// The drive UI for an app that embeds it: `agentic-drive/ui`. The app gives the address of a drive server and a function that
// returns the bearer token. React and react-dom are peer dependencies. The styles are in `agentic-drive/ui.css`. The host owns
// the theme, the page address, and sign-in, so the embed changes none of them.
import { useEffect, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { FolderIcon, SidebarNav, ToastProvider, TooltipProvider } from "agentic-design/react";
import { createClient, type DriveClient } from "../src/client.js";
import { Routes } from "./App.js";
import "./app.css";

export interface DriveUiOptions {
  /** The address of the drive server, for example `https://drive.example.com`. Only its origin is used. */
  baseUrl: string;
  /** Returns the bearer token for the next request. It runs before every request, so it can refresh a token. No token sends no `authorization` header. */
  getToken: () => string | undefined | Promise<string | undefined>;
}

/** The token placeholder that the client needs to send authenticated calls. `getToken` replaces it on every request. */
const PLACEHOLDER = "from-get-token";

/** A client for the options, and `close`. After `close`, no request starts and a running one aborts, so work that outlives the UI cannot send a token. */
function makeClient({ baseUrl, getToken }: DriveUiOptions) {
  if (typeof getToken !== "function") throw new TypeError("getToken must be a function");
  const closed = new AbortController();
  const fetchWithToken: typeof fetch = async (input, init) => {
    closed.signal.throwIfAborted();
    const token = await getToken();
    closed.signal.throwIfAborted();
    if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(token))) throw new TypeError("getToken must return 1 to 512 letters, digits, - or _");
    const headers = new Headers(init?.headers);
    if (token === undefined) headers.delete("authorization");
    else headers.set("authorization", `Bearer ${token}`);
    const signal = init?.signal ? AbortSignal.any([init.signal, closed.signal]) : closed.signal;
    return globalThis.fetch(input, { ...init, headers, signal });
  };
  return { client: createClient({ baseUrl, token: PLACEHOLDER, fetch: fetchWithToken }), close: () => closed.abort() };
}

/** The folders and trash of the signed-in caller, with upload, share, and the machine-made label. It needs the tooltip and toast providers above it. `mount` adds them.
 * It shows the root again when `baseUrl` changes. A bad `baseUrl` or `getToken` throws. Pass a stable `getToken`, because a new function makes a new client. */
export function DriveBrowser({ baseUrl, getToken }: DriveUiOptions) {
  const [client, setClient] = useState<DriveClient>();
  // The client closes when the component unmounts or an option changes, so work of the old one sends nothing more.
  useEffect(() => {
    const made = makeClient({ baseUrl, getToken });
    setClient(made.client);
    return () => made.close();
  }, [baseUrl, getToken]);
  return client ? <DriveView key={baseUrl} client={client} origin={new URL(baseUrl).origin} /> : null;
}

function DriveView({ client, origin }: { client: DriveClient; origin: string }) {
  // The route lives in this component, not in the page address, so the embed never moves the host page.
  const [hash, setHash] = useState("#/");
  const go = (loc: string) => setHash(`#/${loc === "/" ? "" : loc}`);
  const follow = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element).closest?.("a[href^='#/']");
    if (!link || !e.currentTarget.contains(link)) return;
    e.preventDefault();
    setHash(link.getAttribute("href")!);
  };
  const place = hash.startsWith("#/trash") ? "trash" : "files";
  return (
    <div className="drive-root" onClick={follow}>
      <SidebarNav label="Places" items={[
        { href: "#/", label: "My files", icon: <FolderIcon aria-hidden="true" />, current: place === "files" },
        { href: "#/trash", label: "Trash", current: place === "trash" },
      ]} />
      <div className="drive-main">
        <Routes hash={hash} client={client} origin={origin} go={go} />
      </div>
    </div>
  );
}

export interface MountedDrive {
  /** Show the drive with another address or token callback. The folder the person has open resets. */
  update(options: DriveUiOptions): void;
  /** Remove the UI. A request that runs is aborted, and no later request starts or calls `getToken`. Calling it again does nothing. */
  unmount(): void;
}

/** Render the drive into an element, for an app that does not use React itself. A bad `baseUrl` or `getToken` throws a `TypeError`. */
export function mount(element: HTMLElement, options: DriveUiOptions): MountedDrive {
  let current = makeClient(options);
  const root = createRoot(element);
  let open = true;
  let version = 0;
  const render = (next: DriveUiOptions, client: DriveClient) =>
    root.render(
      <TooltipProvider>
        <ToastProvider>
          <DriveView key={version++} client={client} origin={new URL(next.baseUrl).origin} />
        </ToastProvider>
      </TooltipProvider>,
    );
  render(options, current.client);
  return {
    update: (next) => {
      const made = makeClient(next);
      if (!open) return made.close();
      // The old client closes first, so an upload of the old UI sends nothing more.
      current.close();
      current = made;
      render(next, made.client);
    },
    unmount: () => {
      if (!open) return;
      open = false;
      current.close();
      root.unmount();
    },
  };
}

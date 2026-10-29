// The drive UI for an app that embeds it: `agentic-drive/ui`. The app gives the address of a drive server and a function that
// returns the bearer token. React and react-dom are peer dependencies. The styles are in `agentic-drive/ui.css`. The host owns
// the theme, the page address, and sign-in, so the embed changes none of them.
import { useMemo, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { FolderIcon, SidebarNav, ToastProvider, TooltipProvider } from "agentic-design/react";
import { createClient } from "../src/client.js";
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

function makeClient({ baseUrl, getToken }: DriveUiOptions) {
  if (typeof getToken !== "function") throw new TypeError("getToken must be a function");
  const fetchWithToken: typeof fetch = async (input, init) => {
    const token = await getToken();
    if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(token))) throw new TypeError("getToken must return 1 to 512 letters, digits, - or _");
    const headers = new Headers(init?.headers);
    if (token === undefined) headers.delete("authorization");
    else headers.set("authorization", `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  };
  return createClient({ baseUrl, token: PLACEHOLDER, fetch: fetchWithToken });
}

/** The folders and trash of the signed-in caller, with upload, share, and the machine-made label. It needs the tooltip and toast providers above it. `mount` adds them. */
export function DriveBrowser(options: DriveUiOptions) {
  // The client is made again only when the address or the callback changes.
  const client = useMemo(() => makeClient(options), [options.baseUrl, options.getToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const origin = useMemo(() => new URL(options.baseUrl).origin, [options.baseUrl]);
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
  /** Remove the UI and stop its requests. Calling it again does nothing. */
  unmount(): void;
}

/** Render the drive into an element, for an app that does not use React itself. A bad `baseUrl` or `getToken` throws a `TypeError`. */
export function mount(element: HTMLElement, options: DriveUiOptions): MountedDrive {
  makeClient(options);
  const root = createRoot(element);
  let open = true;
  let version = 0;
  const render = (next: DriveUiOptions) =>
    root.render(
      <TooltipProvider>
        <ToastProvider>
          <DriveBrowser key={version++} {...next} />
        </ToastProvider>
      </TooltipProvider>,
    );
  render(options);
  return {
    update: (next) => (makeClient(next), open && render(next)),
    unmount: () => {
      if (!open) return;
      open = false;
      root.unmount();
    },
  };
}

// The drive UI for an app that embeds it: `agentic-drive/ui`. The app gives the address of a drive server and a function that
// returns the bearer token. React and react-dom are peer dependencies. The styles are in `agentic-drive/ui.css`. The host owns
// the theme, the page address, and sign-in, so the embed changes none of them.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { FolderIcon, SidebarNav, ToastProvider, TooltipProvider, useToast } from "agentic-design/react";
import { createClient, DriveApiError, type DriveClient, type Item } from "../src/client.js";
import { Routes, downloadItem } from "./App.js";
import "./app.css";

/** Return true to handle a reference open; false or void keeps the download action. */
export type OnOpenItem = (item: Item) => boolean | void;
export type { Item } from "../src/client.js";

/** Folder locators follow the SDK rules: "/" is root; use an id or an absolute path. */
export type DriveLocation =
  | { kind: "folder"; path: string }
  | { kind: "trash" }
  | { kind: "activity"; itemId: string }
  | { kind: "file"; itemId: string };

const ROOT: DriveLocation = { kind: "folder", path: "/" };
function locationHash(location: DriveLocation): string {
  if (location.kind === "folder" && typeof location.path === "string" && location.path.length)
    return `#/folder/${encodeURIComponent(location.path)}`;
  if (location.kind === "trash") return "#/trash";
  if ((location.kind === "activity" || location.kind === "file") && typeof location.itemId === "string" && location.itemId.length)
    return `#/${location.kind === "activity" ? "a" : "f"}/${encodeURIComponent(location.itemId)}`;
  throw new TypeError("Invalid drive location");
}
function fromHash(hash: string): DriveLocation {
  const path = hash.slice(2);
  if (path === "trash") return { kind: "trash" };
  if (path.startsWith("a/")) return { kind: "activity", itemId: path.slice(2) };
  if (path.startsWith("f/")) return { kind: "file", itemId: path.slice(2) };
  return { kind: "folder", path: path || "/" };
}

/** Replace the current host history entry for a transient navigation. */
export interface DriveNavigationOptions {
  replace: boolean;
}

export interface DriveUiOptions {
  /** Controlled in React. In mount/update, selects the location; omission preserves it. */
  location?: DriveLocation;
  /** Internal navigation. Controlled React hosts must apply the next location.
   * Use replaceState when options.replace is true (an explicit download returns). */
  onNavigate?: (location: DriveLocation, options: DriveNavigationOptions) => void;
  /** Runs when a person activates a reference item. Return true to skip the built-in download. */
  onOpenItem?: OnOpenItem;
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

let clients = 0;

/** The folders and trash of the signed-in caller, with upload, share, and the machine-made label. It needs the tooltip and toast providers above it. `mount` adds them.
 * It keeps its location when `baseUrl` changes. A bad `baseUrl` or `getToken` throws. Pass a stable `getToken`, because a new function makes a new client. */
export function DriveBrowser({ baseUrl, getToken, onOpenItem, location, onNavigate }: DriveUiOptions) {
  const [local, setLocal] = useState<DriveLocation>(ROOT);
  const active = location ?? local;
  locationHash(active);
  const navigate = (next: DriveLocation, options: DriveNavigationOptions = { replace: false }) => {
    if (location === undefined) setLocal(next);
    onNavigate?.(next, options);
  };
  const [made, setMade] = useState<{ id: number; client: DriveClient; origin: string }>();
  // The client closes when the component unmounts or an option changes, so work of the old one sends nothing more.
  // A new client reloads the current location.
  useEffect(() => {
    const next = makeClient({ baseUrl, getToken });
    setMade({ id: ++clients, client: next.client, origin: new URL(baseUrl).origin });
    return () => next.close();
  }, [baseUrl, getToken]);
  return made ? <DriveView key={made.id} client={made.client} origin={made.origin} onOpenItem={onOpenItem} location={active} onNavigate={navigate} /> : null;
}

function DriveView({ client, origin, onOpenItem, location, onNavigate }: { client: DriveClient; origin: string; onOpenItem?: OnOpenItem; location: DriveLocation; onNavigate: NonNullable<DriveUiOptions["onNavigate"]> }) {
  const hash = locationHash(location);
  const toast = useToast();
  const pending = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    return () => controller.abort();
  }, [hash]);
  const download = async (id: string) => {
    const signal = pending.current.signal;
    try { await downloadItem(client, id, origin, signal); }
    catch (e) {
      if (!signal.aborted) toast({ title: "Could not download", description: e instanceof DriveApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Download failed", tone: "danger" });
    }
  };
  const go = (loc: string, options: DriveNavigationOptions = { replace: false }) => onNavigate(fromHash(`#/${loc === "/" || loc === "root" ? "" : loc}`), options);
  const follow = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element).closest?.("a[href^='#/']");
    if (!link || !e.currentTarget.contains(link)) return;
    e.preventDefault();
    const next = fromHash(link.getAttribute("href")!);
    if (next.kind === "file") void download(next.itemId);
    else onNavigate(next, { replace: false });
  };
  const place = hash.startsWith("#/trash") ? "trash" : "files";
  return (
    <div className="drive-root" onClick={follow}>
      <SidebarNav label="Places" items={[
        { href: "#/", label: "My files", icon: <FolderIcon aria-hidden="true" />, current: place === "files" },
        { href: "#/trash", label: "Trash", current: place === "trash" },
      ]} />
      <div className="drive-main">
        <Routes hash={hash} client={client} origin={origin} go={go} onOpenItem={onOpenItem} folderLoc={location.kind === "folder" ? location.path : undefined} />
      </div>
    </div>
  );
}

export interface MountedDrive {
  /** Show the drive with another address, token callback, or item-open callback. The current location stays unless options.location is supplied. */
  update(options: DriveUiOptions): void;
  /** Select a location without remounting the drive. Does not call onNavigate. */
  setLocation(location: DriveLocation): void;
  /** Current location. A folder path is suitable for SDK registerDocument({ folder }). */
  getLocation(): DriveLocation;
  /** Remove the UI. A request that runs is aborted, and no later request starts or calls `getToken`. Calling it again does nothing. */
  unmount(): void;
}

/** Render the drive into an element, for an app that does not use React itself. A bad `baseUrl` or `getToken` throws a `TypeError`. */
export function mount(element: HTMLElement, options: DriveUiOptions): MountedDrive {
  let active = { ...(options.location ?? ROOT) };
  locationHash(active);
  let settings = options;
  let current = makeClient(options);
  const root = createRoot(element);
  let open = true;
  let version = 0;
  const navigate = (next: DriveLocation, options: DriveNavigationOptions = { replace: false }) => {
    active = { ...next };
    render(settings, current.client);
    settings.onNavigate?.({ ...active }, options);
  };
  const render = (next: DriveUiOptions, client: DriveClient) =>
    root.render(
      <TooltipProvider>
        <ToastProvider>
          <DriveView key={version} client={client} origin={new URL(next.baseUrl).origin} onOpenItem={next.onOpenItem} location={active} onNavigate={navigate} />
        </ToastProvider>
      </TooltipProvider>,
    );
  render(options, current.client);
  return {
    update: (next) => {
      if (!open) return;
      if (next.location !== undefined) locationHash(next.location);
      const made = makeClient(next);
      settings = next;
      if (next.location !== undefined) active = { ...next.location };
      version++;
      // The old client closes first, so an upload of the old UI sends nothing more.
      current.close();
      current = made;
      render(next, made.client);
    },
    setLocation: (next) => {
      if (!open) return;
      locationHash(next);
      active = { ...next };
      render(settings, current.client);
    },
    getLocation: () => ({ ...active }),
    unmount: () => {
      if (!open) return;
      open = false;
      current.close();
      root.unmount();
    },
  };
}

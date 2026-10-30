// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { ToastProvider, TooltipProvider } from "agentic-design/react";
import { DriveBrowser, mount, type DriveUiOptions, type MountedDrive } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia, and the design components ask for it.
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const ada = { kind: "human" as const, id: "ada" };
const item = (id: string, name: string, kind: "folder" | "file", parentId: string) => ({
  id, owner: "ada", parentId, name, kind, size: 3, mime: null, hash: null, ref: null, createdAt: 1, updatedAt: 1,
  createdBy: ada, updatedBy: ada, createdById: "ada", updatedById: "ada", trashed: false, trashedAt: null, machineMade: false,
});
const ITEMS: Record<string, ReturnType<typeof item>> = {
  "/": item("root", "", "folder", ""),
  docs: item("docs", "docs", "folder", "root"),
};
const CHILDREN: Record<string, ReturnType<typeof item>[]> = {
  "/": [item("docs", "docs", "folder", "root"), item("n1", "notes.txt", "file", "root")],
  docs: [item("d1", "inner.txt", "file", "docs")],
};

/** A server in memory. It records the authorization header of each request. */
function fakeServer() {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ path: `${url.pathname}${url.search}`, authorization: new Headers(init?.headers).get("authorization") });
    const path = url.searchParams.get("path") ?? "/";
    const body = url.pathname.endsWith("/stat") ? ITEMS[path] : url.pathname.endsWith("/items") ? CHILDREN[path] : url.pathname.endsWith("/trash") ? [] : undefined;
    if (!body) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such item" } }), { status: 404 });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return { seen, fetch };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
let host: HTMLElement;
let mounted: MountedDrive | undefined;
let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const open = async (options: DriveUiOptions) => {
  await act(async () => void (mounted = mount(host, options)));
  await settle();
};
const base: DriveUiOptions = { baseUrl: "https://drive.example.com", getToken: () => "tok-1" };

describe("mount", () => {
  // Navigation can fail through root resets, callback echoes, stale callbacks, or controlled clicks.
  it("selects folders and trash, reports clicks, and preserves location on update", async () => {
    const onNavigate = vi.fn();
    await open({ ...base, location: { kind: "folder", path: "docs" }, onNavigate });
    expect(host.textContent).toContain("inner.txt");
    expect(mounted!.getLocation()).toEqual({ kind: "folder", path: "docs" });
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => mounted!.update({ ...base, onNavigate }));
    await settle();
    expect(host.textContent).toContain("inner.txt");
    const rootLink = host.querySelector<HTMLAnchorElement>('.drive-crumbs a[href="#/"]')!;
    await act(async () => rootLink.click());
    await settle();
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "folder", path: "/" }, { replace: false });
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/docs"]')!.click());
    await settle();
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "folder", path: "docs" }, { replace: false });
    const view = host.querySelector(".drive-root");
    await act(async () => mounted!.setLocation({ kind: "trash" }));
    expect(host.querySelector(".drive-root")).toBe(view);
    await settle();
    expect(host.textContent).toContain("The trash is empty");
    expect(onNavigate).toHaveBeenCalledTimes(2);
    await act(async () => mounted!.setLocation({ kind: "folder", path: "/" }));
    await settle();
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/trash"]')!.click());
    await settle();
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "trash" }, { replace: false });
    expect(mounted!.getLocation()).toEqual({ kind: "trash" });
  });

  it("replaces host history when a file link opens a temporary download route", async () => {
    const onNavigate = vi.fn();
    await open({ ...base, onNavigate });
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/f/n1"]')!.click());
    await settle();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "file", itemId: "n1" }, { replace: true });
  });

  it("returns a completed root download with a replace hint", async () => {
    const onNavigate = vi.fn();
    ITEMS.n1 = CHILDREN["/"]![1]!;
    const fetch = server.fetch.getMockImplementation()!;
    server.fetch.mockImplementation(async (input, init) =>
      String(input).includes("/url?")
        ? new Response(JSON.stringify({ url: "https://drive.example.com/download", expiresInSeconds: 60 }), { headers: { "content-type": "application/json" } })
        : fetch(input, init));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await open({ ...base, location: { kind: "file", itemId: "n1" }, onNavigate });
      expect(click).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "folder", path: "/" }, { replace: true });
      expect(mounted!.getLocation()).toEqual({ kind: "folder", path: "/" });
    } finally {
      click.mockRestore();
      delete ITEMS.n1;
    }
  });

  it("React location is controlled and host changes do not echo navigation", async () => {
    const root = createRoot(host);
    const onNavigate = vi.fn();
    const render = (path: string) => act(async () => root.render(
      <TooltipProvider><ToastProvider><DriveBrowser {...base} location={{ kind: "folder", path }} onNavigate={onNavigate} /></ToastProvider></TooltipProvider>
    ));
    try {
      await render("/");
      await settle();
      await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/docs"]')!.click());
      await settle();
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "folder", path: "docs" }, { replace: false });
      expect(host.textContent).toContain("notes.txt");
      await render("docs");
      await settle();
      expect(host.textContent).toContain("inner.txt");
      expect(onNavigate).toHaveBeenCalledTimes(1);
      await render("/");
      await settle();
      expect(host.textContent).toContain("notes.txt");
    } finally {
      await act(async () => root.unmount());
    }
  });

  // Failure cases: handled refs download, declined refs stop opening, updates keep a stale hook,
  // ordinary files or folders call the hook, or React prop changes reset the folder.
  it("handles references, replaces and removes the hook, and keeps the default path", async () => {
    const ref = { ...item("ref1", "Plan", "file", "root"), kind: "ref" as const, ref: "docs:plan" };
    CHILDREN["/"]!.push(ref as never);
    ITEMS.ref1 = ref as never;
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    try {
      await open({ ...base, onOpenItem: first });
      const activate = async (name: string) => {
        const link = [...host.querySelectorAll("a")].find((a) => a.textContent === name)!;
        await act(async () => link.click());
        await settle();
      };
      await activate("Plan");
      expect(first).toHaveBeenCalledExactlyOnceWith(ref);
      expect(server.seen.some((r) => r.path.includes("/url"))).toBe(false);
      await act(async () => mounted!.update({ ...base, onOpenItem: second }));
      await settle();
      await activate("Plan");
      expect(second).toHaveBeenCalledExactlyOnceWith(ref);
      expect(server.seen.some((r) => r.path.includes("/url"))).toBe(true);
      await act(async () => mounted!.update(base));
      await act(async () => mounted!.setLocation({ kind: "folder", path: "/" }));
      await settle();
      server.seen.length = 0;
      await activate("Plan");
      expect(second).toHaveBeenCalledTimes(1);
      expect(server.seen.some((r) => r.path.includes("/url"))).toBe(true);
    } finally {
      CHILDREN["/"]!.pop();
      delete ITEMS.ref1;
    }
  });

  it("DriveBrowser uses a changed callback without reloading the folder", async () => {
    const ref = { ...item("react-ref", "React plan", "file", "docs"), kind: "ref" as const, ref: "docs:react" };
    CHILDREN.docs!.push(ref as never);
    const root = createRoot(host);
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const render = (onOpenItem: typeof first) => act(async () => root.render(<TooltipProvider><ToastProvider><DriveBrowser {...base} onOpenItem={onOpenItem} /></ToastProvider></TooltipProvider>));
    try {
      await render(first);
      await settle();
      await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/docs"]')!.click());
      await settle();
      const click = () => act(async () => host.querySelector<HTMLAnchorElement>('a[href="#/f/react-ref"]')!.click());
      await click();
      expect(first).toHaveBeenCalledExactlyOnceWith(ref);
      const requests = server.seen.length;
      await render(second);
      await click();
      expect(second).toHaveBeenCalledExactlyOnceWith(ref);
      expect(first).toHaveBeenCalledTimes(1);
      expect(server.seen).toHaveLength(requests);
    } finally {
      await act(async () => root.unmount());
      CHILDREN.docs!.pop();
    }
  });

  it.each<[string, unknown]>([
    ["no baseUrl", { getToken: () => "a" }],
    ["a baseUrl that is not http", { baseUrl: "ftp://x.example", getToken: () => "a" }],
    ["no getToken", { baseUrl: "https://drive.example.com" }],
    ["a getToken that is not a function", { baseUrl: "https://drive.example.com", getToken: "tok" }],
  ])("throws a TypeError for %s, and leaves the element empty", (_name, options) => {
    expect(() => mount(host, options as DriveUiOptions)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("lists the folder from the server and sends the token of the callback", async () => {
    await open(base);
    expect(host.textContent).toContain("notes.txt");
    expect(host.textContent).toContain("docs");
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((r) => r.authorization === "Bearer tok-1")).toBe(true);
    expect(server.seen[0]!.path.startsWith("/api/v1/drive/")).toBe(true);
  });

  it("asks for the token again on every request, so a refreshed token is used", async () => {
    let n = 0;
    await open({ ...base, getToken: async () => `tok-${++n}` });
    const tokens = server.seen.map((r) => r.authorization);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens[0]).toBe("Bearer tok-1");
  });

  it("sends no authorization header when the callback has no token", async () => {
    await open({ ...base, getToken: () => undefined });
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((r) => r.authorization === null)).toBe(true);
  });

  it("shows an alert, not a crash, when the token has bad characters", async () => {
    await open({ ...base, getToken: () => "bad token\r\nx-evil: 1" });
    expect(server.fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("getToken must return");
  });

  it("shows the server error in an alert", async () => {
    ITEMS.gone = item("gone", "gone", "folder", "root");
    server.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad key" } }), { status: 401 }));
    await open(base);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("bad key");
    delete ITEMS.gone;
  });

  it("opens a folder without moving the host page", async () => {
    const before = location.href;
    await open(base);
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.trim() === "docs" && a.getAttribute("href") === "#/docs")!;
    await act(async () => link.click());
    await settle();
    expect(host.textContent).toContain("inner.txt");
    expect(location.href).toBe(before);
  });

  it("opens the trash view from the places list", async () => {
    await open(base);
    const trash = [...host.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Trash")!;
    await act(async () => trash.click());
    await settle();
    expect(server.seen.some((r) => r.path.includes("/trash"))).toBe(true);
  });

  it("update uses the new server, and unmount twice is safe", async () => {
    await open(base);
    server.fetch.mockClear();
    await act(async () => mounted!.update({ ...base, baseUrl: "https://other.example.com" }));
    await settle();
    expect(server.fetch).toHaveBeenCalled();
    expect(server.fetch.mock.calls.every(([u]) => String(u).startsWith("https://other.example.com/"))).toBe(true);
    expect(() => mounted!.update({ ...base, baseUrl: "nope" })).toThrow(TypeError);
    await act(async () => mounted!.unmount());
    expect(host.innerHTML).toBe("");
    expect(() => mounted!.unmount()).not.toThrow();
    server.fetch.mockClear();
    await act(async () => mounted!.update(base));
    expect(host.innerHTML).toBe("");
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("sends nothing and asks for no token after unmount, while an upload of many files runs", async () => {
    await open(base);
    const getToken = vi.fn(() => "tok-1");
    await act(async () => mounted!.update({ ...base, getToken }));
    await settle();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    let release!: () => void;
    server.fetch.mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") await new Promise<void>((resolve, reject) => { release = resolve; init.signal?.addEventListener("abort", () => reject(init.signal!.reason)); });
      return new Response(JSON.stringify(item("u", "u.txt", "file", "root")), { headers: { "content-type": "application/json" } });
    });
    const files = ["a.txt", "b.txt", "c.txt"].map((n) => new File(["x"], n));
    await act(async () => { Object.defineProperty(input, "files", { value: files }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    const puts = () => server.fetch.mock.calls.filter(([, i]) => i?.method === "PUT").length;
    expect(puts()).toBe(1);
    const tokenCalls = getToken.mock.calls.length;
    await act(async () => mounted!.unmount());
    release();
    await settle();
    await settle();
    expect(puts()).toBe(1);
    expect(getToken.mock.calls.length).toBe(tokenCalls);
  });

  it("closes the client of the old options on update", async () => {
    await open(base);
    const oldFetchCalls = server.fetch.mock.calls.length;
    expect(oldFetchCalls).toBeGreaterThan(0);
    const first = vi.fn(() => "old");
    await act(async () => mounted!.update({ ...base, getToken: first }));
    await settle();
    const second = vi.fn(() => "new");
    await act(async () => mounted!.update({ ...base, getToken: second }));
    await settle();
    first.mockClear();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(first).not.toHaveBeenCalled();
    expect(server.seen.at(-1)!.authorization).toBe("Bearer new");
  });

  it("DriveBrowser, the React component, also sends nothing after it unmounts during an upload", async () => {
    const getToken = vi.fn(() => "tok-1");
    const root = createRoot(host);
    await act(async () => root.render(<TooltipProvider><ToastProvider><DriveBrowser baseUrl={base.baseUrl} getToken={getToken} /></ToastProvider></TooltipProvider>));
    await settle();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    let release!: () => void;
    server.fetch.mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") await new Promise<void>((resolve, reject) => { release = resolve; init.signal?.addEventListener("abort", () => reject(init.signal!.reason)); });
      return new Response(JSON.stringify(item("u", "u.txt", "file", "root")), { headers: { "content-type": "application/json" } });
    });
    const files = ["a.txt", "b.txt", "c.txt"].map((n) => new File(["x"], n));
    await act(async () => { Object.defineProperty(input, "files", { value: files }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    const puts = () => server.fetch.mock.calls.filter(([, i]) => i?.method === "PUT").length;
    expect(puts()).toBe(1);
    const tokenCalls = getToken.mock.calls.length;
    await act(async () => root.unmount());
    release();
    await settle();
    await settle();
    expect(puts()).toBe(1);
    expect(getToken.mock.calls.length).toBe(tokenCalls);
  });

  it("DriveBrowser loads from the new server when baseUrl changes", async () => {
    const getToken = () => "tok-1";
    const root = createRoot(host);
    const render = (baseUrl: string) => act(async () => root.render(<TooltipProvider><ToastProvider><DriveBrowser baseUrl={baseUrl} getToken={getToken} /></ToastProvider></TooltipProvider>));
    await render("https://a.example.com");
    await settle();
    expect(host.textContent).toContain("notes.txt");
    server.fetch.mockClear();
    await render("https://b.example.com");
    await settle();
    expect(server.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(server.fetch.mock.calls.every(([u]) => String(u).startsWith("https://b.example.com/"))).toBe(true);
    expect(host.textContent).toContain("notes.txt");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("update after unmount does nothing, even for options that are bad", async () => {
    await open(base);
    await act(async () => mounted!.unmount());
    expect(() => mounted!.update({ baseUrl: "nope" } as never)).not.toThrow();
  });
});

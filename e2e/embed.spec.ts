import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/client.js";

const ADA = "ada-token-for-the-ui-tests";
const HELPER = "helper-token-for-the-ui-tests";
const root = join(import.meta.dirname, "..");
const design = join(root, "node_modules/agentic-design/dist");

// A host page on the origin of the server. It loads the built package files, as an app would: `dist/embed.js` and `dist/embed.css`.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title>
<link rel="stylesheet" href="/host/styles.css"><link rel="stylesheet" href="/host/embed.css"></head>
<body><main><h1>Host page</h1><div id="drive"></div></main><script src="/host/host.js"></script></body></html>`;

test.beforeAll(async () => {
  const page = join(root, "e2e/embed-host.ts");
  const built = await build({ entryPoints: [page], bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  host = built.outputFiles[0]!.text;
});
let host = "";

async function openHost(page: Page) {
  await page.route("**/host/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/host/", "");
    if (name === "page") return route.fulfill({ contentType: "text/html", body: PAGE });
    if (name === "host.js") return route.fulfill({ contentType: "text/javascript", body: host });
    if (name === "embed.css") return route.fulfill({ contentType: "text/css", body: readFileSync(join(root, "dist/embed.css")) });
    if (name === "styles.css") return route.fulfill({ contentType: "text/css", body: readFileSync(join(design, "styles.css")) });
    return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(design, name)) });
  });
  await page.goto("/host/page");
}

test("the package UI mounts in a host page and works against the server", async ({ page }) => {
  const base = `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`;
  const person = createClient({ baseUrl: base, token: ADA });
  await person.mkdir("/embed-docs");
  await person.upload("/embed-docs/inside.txt", "hi", { mime: "text/plain" });
  await createClient({ baseUrl: base, token: HELPER }).upload("/embed-agent.txt", "by a helper", { mime: "text/plain" });

  await openHost(page);
  await page.evaluate((token) => (window as unknown as { start(t: string): void }).start(token), ADA);
  const drive = page.locator("#drive");
  const files = drive.locator(".drive-row");
  await expect(files.getByRole("link", { name: "embed-docs", exact: true })).toBeVisible();
  await expect(drive.getByText("Created by agent", { exact: true }).first()).toBeVisible();

  // Opening a folder uses no page address, so the host page keeps its own.
  const url = page.url();
  await files.getByRole("link", { name: "embed-docs", exact: true }).click();
  await expect(files.getByRole("link", { name: "inside.txt", exact: true })).toBeVisible();
  await expect(drive.getByRole("heading", { name: "embed-docs" })).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.getByRole("heading", { name: "Host page" })).toBeVisible();

  await drive.getByLabel("Choose files to upload").setInputFiles({ name: "from-embed.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(files.getByRole("link", { name: "from-embed.txt", exact: true })).toBeVisible();
  expect((await person.stat("/embed-docs/from-embed.txt")).name).toBe("from-embed.txt");

  const result = await new AxeBuilder({ page }).include("#drive").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  await page.evaluate(() => (window as unknown as { stop(): void }).stop());
  await expect(drive).toBeEmpty();
});

test("a token that the server refuses shows an alert in the host page", async ({ page }) => {
  await openHost(page);
  await page.evaluate(() => (window as unknown as { start(t: string): void }).start("not-a-real-token"));
  await expect(page.locator("#drive").getByRole("alert")).toBeVisible();
});

for (const view of ["list", "grid"]) {
  for (const activation of ["pointer", "keyboard"]) {
    test(`${view} reference opens by ${activation} and preserves fallback`, async ({ page }) => {
      const person = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: ADA });
      const name = `ref-${view}-${activation}`;
      const item = await person.registerDocument({ name, ref: `docs:${name}` });
      await person.upload(`/${name}.txt`, "hello");
      await openHost(page);
      await page.evaluate(({ token, view }) => {
        localStorage.setItem("agentic-drive-view", view);
        const host = window as unknown as { start(t: string): void; setOpenHook(t: string, h: boolean | null): void };
        host.start(token);
        host.setOpenHook(token, true);
      }, { token: ADA, view });
      const drive = page.locator("#drive");
      const link = () => drive.getByRole("link", { name, exact: true });
      const urls: string[] = [];
      page.on("request", (r) => { if (r.url().includes("/url?")) urls.push(r.url()); });
      const activate = async () => {
        if (activation === "pointer") await link().click();
        else { await link().focus(); await page.keyboard.press("Enter"); }
      };
      await activate();
      await expect.poll(() => page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([item]);
      expect(urls).toEqual([]);
      await expect(link()).toBeVisible();
      for (const handled of [false, null]) {
        await page.evaluate(({ token, handled }) => {
          const host = window as unknown as { setOpenHook(t: string, h: boolean | null): void; navigate(l: unknown): void };
          host.setOpenHook(token, handled);
          host.navigate({ kind: "folder", path: "/" });
        }, { token: ADA, handled });
        const request = page.waitForRequest((r) => r.url().includes("/url?") && r.url().includes(item.id));
        await activate();
        await request;
      }
      await page.evaluate((token) => {
        const host = window as unknown as { setOpenHook(t: string, h: boolean): void; navigate(l: unknown): void };
        host.setOpenHook(token, true);
        host.navigate({ kind: "folder", path: "/" });
      }, ADA);
      const download = page.waitForEvent("download");
      await drive.getByRole("link", { name: `${name}.txt`, exact: true }).click();
      expect((await download).suggestedFilename()).toBe(`${name}.txt`);
      expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened.length)).toBe(2);
    });
  }
}

test("host navigation selects nested paths, tracks crumbs and trash, and applies history", async ({ page }) => {
  const client = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: ADA });
  const parent = await client.mkdir("/router-parent");
  const nested = await client.mkdir("/router-parent/nested");
  await client.upload("/router-parent/nested/seed.txt", "seed");
  await openHost(page);
  await page.evaluate((token) => {
    const host = window as unknown as { startRouter(t: string, l: unknown): void };
    host.startRouter(token, { kind: "folder", path: "/router-parent/nested" });
  }, ADA);
  const drive = page.locator("#drive");
  await expect(drive.getByRole("heading", { name: "nested", exact: true })).toBeVisible();
  const active = () => page.evaluate(() => (window as unknown as { active(): { kind: string; path: string } }).active());
  expect(await active()).toEqual({ kind: "folder", path: "/router-parent/nested" });
  await drive.getByLabel("Choose files to upload").setInputFiles({ name: "router-upload.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(drive.getByRole("link", { name: "router-upload.txt", exact: true })).toBeVisible();
  expect((await client.stat("/router-parent/nested/router-upload.txt")).parentId).toBe(nested.id);
  await client.registerDocument({ name: "Router plan", ref: "docs:router-plan", folder: (await active()).path });
  await page.evaluate((token) => (window as unknown as { setOpenHook(t: string, h: boolean): void }).setOpenHook(token, true), ADA);
  await expect(drive.getByRole("heading", { name: "nested", exact: true })).toBeVisible();
  await drive.getByRole("link", { name: "Router plan", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened: unknown[] }).opened.length)).toBe(1);
  // Restore the router callback after the option update above.
  await page.evaluate((token) => {
    (window as unknown as { stop(): void }).stop();
    (window as unknown as { startRouter(t: string, l: unknown): void }).startRouter(token, { kind: "folder", path: "/router-parent/nested" });
  }, ADA);
  await drive.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "router-parent", exact: true }).click();
  await expect.poll(active).toEqual({ kind: "folder", path: parent.id });
  await drive.locator(".drive-row").getByRole("link", { name: "nested", exact: true }).click();
  await expect.poll(active).toEqual({ kind: "folder", path: nested.id });
  await drive.getByRole("link", { name: "Trash", exact: true }).click();
  await expect.poll(active).toEqual({ kind: "trash" });
  await page.goBack();
  await expect(drive.getByRole("heading", { name: "nested", exact: true })).toBeVisible();
  await page.goForward();
  await expect(drive.getByRole("heading", { name: "Trash", exact: true })).toBeVisible();
  await page.evaluate((id) => (window as unknown as { navigate(l: unknown): void }).navigate({ kind: "activity", itemId: id }), nested.id);
  await expect(drive.getByRole("heading", { name: "Activity: nested" })).toBeVisible();
  await drive.getByRole("link", { name: "Back to files" }).click();
  await expect(drive.getByRole("heading", { name: "nested", exact: true })).toBeVisible();
  await drive.getByRole("button", { name: "Actions for seed.txt" }).click();
  await page.getByRole("menuitem", { name: "Activity", exact: true }).click();
  await expect(drive.getByRole("heading", { name: "Activity: seed.txt" })).toBeVisible();
});

test("an authenticated caller cannot select a folder without a role", async ({ page }) => {
  const client = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: ADA });
  const folder = await client.mkdir("/router-denied");
  const reader = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: "reader-token-for-the-ui-tests" });
  await expect(reader.stat(folder.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await openHost(page);
  await page.evaluate(({ token, id }) => {
    const host = window as unknown as { startRouter(t: string, l: unknown): void };
    host.startRouter(token, { kind: "folder", path: id });
  }, { token: "reader-token-for-the-ui-tests", id: folder.id });
  await expect(page.locator("#drive").getByRole("alert")).toContainText("NOT_FOUND");
  await expect(page.locator("#drive").getByLabel("Choose files to upload")).toHaveCount(0);
});

test("a viewer can navigate a shared folder but cannot upload into it", async ({ page }) => {
  const client = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: ADA });
  const folder = await client.mkdir("/router-viewer");
  await client.upload("/router-viewer/readable.txt", "read");
  await client.share(folder.id, { kind: "human", id: "reader" }, "viewer");
  await openHost(page);
  await page.evaluate((id) => {
    (window as unknown as { startRouter(t: string, l: unknown): void }).startRouter("reader-token-for-the-ui-tests", { kind: "folder", path: id });
  }, folder.id);
  const drive = page.locator("#drive");
  await expect(drive.getByRole("link", { name: "readable.txt", exact: true })).toBeVisible();
  const denied = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/api/v1/drive/"));
  await drive.getByLabel("Choose files to upload").setInputFiles({ name: "denied.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  expect((await denied).status()).toBe(403);
  await expect(client.stat("/router-viewer/denied.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("file links download in place and explicit downloads return to canonical root", async ({ page }) => {
  const client = createClient({ baseUrl: `http://127.0.0.1:${process.env.DRIVE_UI_PORT}`, token: ADA });
  await client.mkdir("/router-download");
  await client.upload("/router-download/child.txt", "child");
  const rootItem = await client.upload("/router-root.txt", "root");
  await openHost(page);
  await page.evaluate((token) => {
    (window as unknown as { startRouter(t: string, l: unknown): void }).startRouter(token, { kind: "folder", path: "/" });
  }, ADA);
  const drive = page.locator("#drive");
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await drive.locator(".drive-row").getByRole("link", { name: "router-download", exact: true }).click();
  const child = page.waitForEvent("download");
  await drive.getByRole("link", { name: "child.txt", exact: true }).click();
  await child;
  await expect(drive.getByRole("heading", { name: "router-download", exact: true })).toBeVisible();
  await page.goBack();
  await expect(drive.getByRole("heading", { name: "My files", exact: true })).toBeVisible();
  await page.goForward();
  await expect(drive.getByRole("heading", { name: "router-download", exact: true })).toBeVisible();
  expect(downloads).toEqual(["child.txt"]);
  await page.evaluate(() => (window as unknown as { navigate(l: unknown): void }).navigate({ kind: "folder", path: "/" }));
  const root = page.waitForEvent("download");
  await page.evaluate((id) => (window as unknown as { navigate(l: unknown): void }).navigate({ kind: "file", itemId: id }), rootItem.id);
  await root;
  await expect.poll(() => page.evaluate(() => (window as unknown as { active(): unknown }).active())).toEqual({ kind: "folder", path: "/" });
});

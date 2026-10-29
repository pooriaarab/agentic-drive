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
  const files = drive.locator(".ad-file-row");
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

import { defineConfig } from "@playwright/test";

const port = 8788;
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  // A fresh seeded database on every run. The script stays in the foreground, so Playwright can stop it.
  webServer: { command: `node e2e/serve.mjs ${port}`, url: `http://127.0.0.1:${port}/health`, timeout: 120_000, reuseExistingServer: false },
});

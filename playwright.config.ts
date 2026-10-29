import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// A machine may use any fixed port, so the default is one that the system hands out. Workers inherit it.
process.env.DRIVE_UI_PORT ??= execFileSync(process.execPath, ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" }).trim();
const port = Number(process.env.DRIVE_UI_PORT);
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  // A fresh seeded database on every run. The script stays in the foreground, so Playwright can stop it.
  webServer: { command: `node e2e/serve.mjs ${port}`, url: `http://127.0.0.1:${port}/health`, timeout: 120_000, reuseExistingServer: false },
});

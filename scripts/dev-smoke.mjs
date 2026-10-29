// Starts `npm run dev`, waits for GET /health to answer 200, then stops the server.
// Run it with `npm run dev:smoke`. Set DEV_SMOKE_PORT to use another port.
import { spawn } from "node:child_process";

const port = process.env.DEV_SMOKE_PORT ?? "8799";
const url = `http://127.0.0.1:${port}/health`;
const server = spawn("npm", ["run", "dev", "--", "--ip", "127.0.0.1", "--port", port], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let exited = false;
server.on("exit", () => { exited = true; });

const stop = () => {
  if (exited) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
};

let status = 0;
const deadline = Date.now() + 180_000;
while (!exited && Date.now() < deadline) {
  try {
    status = (await fetch(url)).status;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
stop();
if (status !== 200) {
  console.error(`dev smoke failed: GET ${url} gave ${status || "no answer"}`);
  process.exit(1);
}
console.log(`dev smoke passed: GET ${url} gave 200`);

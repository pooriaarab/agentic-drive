// Starts `npm run dev`, waits for GET /health to answer 200, then stops the server.
// Run it with `npm run dev:smoke`. Set DEV_SMOKE_PORT to use another port. It needs a POSIX system.
import { spawn } from "node:child_process";

const port = process.env.DEV_SMOKE_PORT ?? "8799";
const url = `http://127.0.0.1:${port}/health`;
const probe = () => fetch(url, { signal: AbortSignal.timeout(5000) });

// Another server on the port would answer for us and hide a broken dev script.
const taken = await probe().then(() => true, () => false);
if (taken) {
  console.error(`dev smoke failed: something already answers on port ${port}. Stop it or set DEV_SMOKE_PORT.`);
  process.exit(1);
}

const server = spawn("npm", ["run", "dev", "--", "--ip", "127.0.0.1", "--port", port], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
server.on("error", (error) => {
  console.error(`dev smoke failed: ${error.message}`);
  process.exit(1);
});
let exited = false;
server.on("exit", () => { exited = true; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalGroup = (signal) => {
  try { process.kill(-server.pid, signal); } catch { /* already gone */ }
};
const stop = async () => {
  signalGroup("SIGTERM");
  for (let i = 0; i < 100 && !exited; i++) await sleep(100);
  signalGroup("SIGKILL");
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}

let status = 0;
const deadline = Date.now() + 180_000;
while (!exited && Date.now() < deadline) {
  status = await probe().then((res) => res.status, () => 0);
  if (status === 200) break;
  await sleep(1000);
}
await stop();
if (status !== 200) {
  console.error(`dev smoke failed: GET ${url} gave ${status || "no answer"}`);
  process.exit(1);
}
console.log(`dev smoke passed: GET ${url} gave 200`);

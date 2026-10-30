// Starts `wrangler dev` on a fresh local database with two seeded callers: a person and an agent of that person.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1_SCHEMA } from "agentic-identity/cloudflare";

const port = process.argv[2] ?? "8788";
const root = join(import.meta.dirname, "..");
const hash = (t) => createHash("sha256").update(t).digest("hex");
const row = (collection, id, doc) => `INSERT INTO store_docs (collection, id, body) VALUES ('${collection}', '${id}', '${JSON.stringify(doc)}');`;
const sql = [
  `${D1_SCHEMA};`,
  row("principals", "ada", { id: "ada", kind: "human", scopes: ["drive:admin"] }),
  row("principals", "reader", { id: "reader", kind: "human", scopes: ["drive:admin"] }),
  row("principals", "helper", { id: "helper", kind: "agent_of_human", parentId: "ada", scopes: ["drive:write"] }),
  row("credentials", hash("reader-token-for-the-ui-tests"), { principalId: "reader", kind: "api_key" }),
  row("credentials", hash("ada-token-for-the-ui-tests"), { principalId: "ada", kind: "api_key" }),
  row("credentials", hash("helper-token-for-the-ui-tests"), { principalId: "helper", kind: "api_key" }),
].join("\n");

const persist = mkdtempSync(join(tmpdir(), "drive-ui-"));
writeFileSync(join(persist, "seed.sql"), sql);
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
const seeded = spawnSync("npx", ["wrangler", "d1", "execute", "agentic-drive", "--local", "--persist-to", persist, "--file", join(persist, "seed.sql")], { cwd: root, env, encoding: "utf8" });
if (seeded.status !== 0) throw new Error(`could not seed the database: ${seeded.stderr}`);
const base = `http://127.0.0.1:${port}`;
const dev = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", port, "--persist-to", persist,
  "--var", `DRIVE_PUBLIC_URL:${base}`, "--var", `DRIVE_URL_SECRET:${"ui-test-url-secret-".padEnd(40, "s")}`, "--var", "DRIVE_REGION:unknown"], { cwd: root, env, stdio: "inherit" });
// Playwright stops this process group, so wrangler and its children stop with it.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { dev.kill(signal); process.exit(0); });
dev.on("exit", (code) => process.exit(code ?? 0));

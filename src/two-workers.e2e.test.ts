// End to end: two instances of the real Worker bundle on one D1 database and one R2 bucket, under Miniflare.
// The failure list, written before the test:
//  1. A write on one Worker is invisible on the other.
//  2. Two Workers create the same name at once, and both win.
//  3. A role that one Worker grants, changes, or revokes is not the role the other Worker enforces.
//  4. A role does not follow an item that moves, as the other Worker sees it.
//  5. A restart loses data, a share, a link, a credential, or a signed URL.
//  6. An agent with fewer scopes writes through the second Worker.
// At the end the test writes a report of every check with its status. The report holds names and HTTP
// statuses only: no token, URL, body, or id.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1_SCHEMA } from "agentic-identity/cloudflare";

const root = join(import.meta.dirname, "..");
const URL_SECRET = "two-workers-url-secret-".padEnd(48, "s");
const tok = (name: string) => `${name}-`.padEnd(40, "k");
const TOKENS = { alice: tok("alice"), bob: tok("bob"), carol: tok("carol"), readbot: tok("readbot") };
const principals = [
  { id: "alice", kind: "human", scopes: ["drive:admin"] },
  { id: "bob", kind: "human", scopes: ["drive:admin"] },
  { id: "carol", kind: "human", scopes: ["drive:admin"] },
  { id: "readbot", kind: "agent_of_human", parentId: "alice", scopes: ["drive:read"] },
];
const credentials: [string, string][] = [
  [TOKENS.alice, "alice"], [TOKENS.bob, "bob"], [TOKENS.carol, "carol"], [TOKENS.readbot, "readbot"],
];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Name = "a" | "b";
const origin = (worker: Name) => `http://worker-${worker}.test`;
const persist = mkdtempSync(join(tmpdir(), "drive-two-workers-"));
const checks: { check: string; worker: string; status: number }[] = [];
let bundle = ""; // the source text of the bundled Worker
let mf: Miniflare;

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
const fetcher = async (worker: Name) => (await mf.getWorker(worker)) as unknown as Fetcher;

function start(): Miniflare {
  const worker = (name: Name) => ({
    name,
    modules: true,
    script: bundle,
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "shared-drive-db" },
    r2Buckets: { FILES: "shared-drive-files" },
    bindings: { DRIVE_PUBLIC_URL: origin(name), DRIVE_URL_SECRET: URL_SECRET, DRIVE_REGION: "unknown", DRIVE_MAX_BYTES: "100000" },
  });
  return new Miniflare({ d1Persist: join(persist, "d1"), r2Persist: join(persist, "r2"), workers: [worker("a"), worker("b")] });
}

async function call(worker: Name, method: string, path: string, opts: { token?: string | null; json?: unknown; body?: string; headers?: Record<string, string>; check?: string } = {}) {
  const target = await fetcher(worker);
  const token = opts.token === undefined ? TOKENS.alice : opts.token;
  const res = await target.fetch(`${origin(worker)}/api/v1/drive${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.json ? { "content-type": "application/json" } : { "content-type": "application/octet-stream" }), ...opts.headers },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  if (opts.check) checks.push({ check: opts.check, worker, status: res.status });
  return res;
}
const json = async (res: Awaited<ReturnType<typeof call>>) => (await res.json()) as any;
const put = (worker: Name, path: string, body: string, token?: string | null, check?: string) =>
  call(worker, "PUT", `/files?path=${encodeURIComponent(path)}&parents=true&mime=text/plain`, { token, body, check });

beforeAll(async () => {
  const out = join(persist, "bundle");
  const bundled = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  if (bundled.status !== 0) throw new Error(`could not bundle the Worker: ${bundled.stderr}`);
  bundle = readFileSync(join(out, "worker.js"), "utf8");
  mf = start();
  const db = await mf.getD1Database("DB", "a");
  await db.prepare(D1_SCHEMA).run();
  for (const p of principals) await db.prepare("INSERT INTO store_docs (collection, id, body) VALUES ('principals', ?, ?)").bind(p.id, JSON.stringify(p)).run();
  for (const [token, principalId] of credentials) {
    await db.prepare("INSERT INTO store_docs (collection, id, body) VALUES ('credentials', ?, ?)").bind(sha(token), JSON.stringify({ principalId, kind: "api_key" })).run();
  }
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
  const report = { format: "agentic-drive-two-worker-report", workers: ["a", "b"], checks, digest: sha(JSON.stringify(checks)) };
  const file = process.env.E2E_REPORT ?? join(persist, "two-worker-report.json");
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`two-worker report: ${file}\n${JSON.stringify(report)}`);
});

let teamId = "";
let fileId = "";
let linkToken = "";
let signedUrl = "";

describe("two Workers on one database and one bucket", () => {
  it("shows a write on one Worker to the other", async () => {
    expect((await put("a", "/team/docs/a.txt", "from a", TOKENS.alice, "write on a")).status).toBe(201);
    expect((await call("b", "GET", "/stat?path=/team/docs/a.txt", { check: "stat on b of a write on a" })).status).toBe(200);
    expect((await put("b", "/team/docs/b.txt", "from b", TOKENS.alice, "write on b")).status).toBe(201);
    expect((await json(await call("a", "GET", "/items?path=/team/docs", { check: "list on a of a write on b" }))).map((n: { name: string }) => n.name)).toEqual(["a.txt", "b.txt"]);
    teamId = (await json(await call("a", "GET", "/stat?path=/team"))).id;
    fileId = (await json(await call("b", "GET", "/stat?path=/team/docs/a.txt"))).id;
  });

  it("lets only one of two Workers create a name", { timeout: 120_000 }, async () => {
    for (let round = 0; round < 8; round++) {
      const path = `/race/r${round}.txt`;
      const [x, y] = await Promise.all([put("a", path, "1", TOKENS.alice), put("b", path, "2", TOKENS.alice)]);
      expect([x.status, y.status].sort(), `round ${round}`).toEqual([201, 409]);
      checks.push({ check: `name race round ${round}, first creator`, worker: "a+b", status: Math.min(x.status, y.status) }, { check: `name race round ${round}, second creator`, worker: "a+b", status: Math.max(x.status, y.status) });
    }
    expect((await json(await call("a", "GET", "/items?path=/race"))).length).toBe(8);
  });

  it("enforces a role that one Worker grants on the other, and follows every change at once", async () => {
    expect((await call("b", "GET", `/stat?path=${fileId}`, { token: TOKENS.bob, check: "bob with no role on b" })).status).toBe(404);
    expect((await call("a", "POST", "/shares", { json: { path: "/team", subjectId: "bob", role: "viewer" }, check: "grant viewer on a" })).status).toBe(200);
    expect((await call("b", "GET", `/stat?path=${fileId}`, { token: TOKENS.bob, check: "inherited viewer reads nested file on b" })).status).toBe(200);
    expect((await call("a", "GET", `/files?path=${fileId}`, { token: TOKENS.bob, check: "inherited viewer reads bytes on a" })).status).toBe(200);
    expect((await put("b", `${teamId}/docs/x.txt`, "x", TOKENS.bob, "viewer writes on b")).status).toBe(403);
    expect((await call("b", "POST", "/trash", { token: TOKENS.bob, json: { path: fileId }, check: "viewer trashes on b" })).status).toBe(403);
    expect((await call("a", "POST", "/shares", { json: { path: "/team", subjectId: "bob", role: "editor" }, check: "upgrade to editor on a" })).status).toBe(200);
    const made = await put("b", `${teamId}/docs/by-bob.txt`, "bob", TOKENS.bob, "editor writes on b");
    expect(made.status).toBe(201);
    expect((await json(made)).owner).toBe("alice");
    expect((await call("a", "POST", "/shares", { token: TOKENS.bob, json: { path: teamId, subjectId: "carol", role: "viewer" }, check: "editor shares on a" })).status).toBe(403);
    expect((await call("a", "GET", "/stat?path=/team/docs/by-bob.txt", { check: "owner sees editor's file on a" })).status).toBe(200);
    expect((await call("b", "POST", "/shares", { json: { path: "/team", subjectId: "bob", role: "viewer" }, check: "downgrade to viewer on b" })).status).toBe(200);
    expect((await put("a", `${teamId}/docs/again.txt`, "x", TOKENS.bob, "viewer after downgrade writes on a")).status).toBe(403);
  });

  it("follows an item that moves, on the other Worker", async () => {
    expect((await call("a", "POST", "/folders", { json: { path: "/private" }, check: "make private folder" })).status).toBe(201);
    expect((await call("a", "POST", "/move", { json: { src: fileId, folder: "/private" }, check: "move out of the shared folder on a" })).status).toBe(200);
    expect((await call("b", "GET", `/stat?path=${fileId}`, { token: TOKENS.bob, check: "bob after the move on b" })).status).toBe(404);
    expect((await call("b", "POST", "/move", { json: { src: fileId, folder: "/team/docs" }, check: "move back on b" })).status).toBe(200);
    expect((await call("a", "GET", `/stat?path=${fileId}`, { token: TOKENS.bob, check: "bob after the move back on a" })).status).toBe(200);
  });

  it("holds an agent to its scopes on the second Worker", async () => {
    expect((await call("b", "GET", "/items?path=/team", { token: TOKENS.readbot, check: "reader agent lists on b" })).status).toBe(200);
    expect((await put("b", "/team/by-readbot.txt", "x", TOKENS.readbot, "reader agent writes on b")).status).toBe(403);
  });

  it("makes a link and a signed URL to use after the restart", async () => {
    linkToken = (await json(await call("a", "POST", "/links", { json: { path: "/team", role: "viewer", expiresInMs: 3_600_000 }, check: "make link on a" }))).token;
    expect(linkToken).toBeTruthy();
    signedUrl = (await json(await call("b", "GET", `/url?path=${fileId}&expires=3600`, { check: "signed url on b" }))).url;
    const early = await (await fetcher("a")).fetch(signedUrl.replace(origin("b"), origin("a")));
    checks.push({ check: "signed url from b served by a", worker: "a", status: early.status });
    expect(early.status).toBe(200);
  });

  it("keeps every thing after a restart", { timeout: 120_000 }, async () => {
    await mf.dispose();
    mf = start();
    expect((await call("a", "GET", "/stat?path=/team/docs/a.txt", { check: "owner after restart on a" })).status).toBe(200);
    expect((await call("b", "GET", `/files?path=${fileId}`, { token: TOKENS.bob, check: "viewer role after restart on b" })).status).toBe(200);
    expect((await put("b", `${teamId}/docs/after.txt`, "x", TOKENS.bob, "viewer writes after restart on b")).status).toBe(403);
    expect((await json(await call("a", "GET", "/items?path=/race"))).length).toBe(8);
    const visit = await (await fetcher("b")).fetch(`${origin("b")}/api/v1/drive/shared/${fileId}/content`, { headers: { "x-link-token": linkToken } });
    checks.push({ check: "link after restart on b", worker: "b", status: visit.status });
    expect(visit.status).toBe(200);
    expect(await visit.text()).toBe("from a");
    const served = await (await fetcher("a")).fetch(signedUrl.replace(origin("b"), origin("a")));
    checks.push({ check: "signed url after restart on a", worker: "a", status: served.status });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await call("a", "GET", "/stat?path=/team", { token: "wrong-token", check: "wrong token after restart" })).status).toBe(401);
  });

  it("erases a person on one Worker and leaves the data of others whole on the other", async () => {
    expect((await call("a", "POST", "/shares", { json: { path: "/team", subjectId: "bob", role: "editor" }, check: "editor again on a" })).status).toBe(200);
    expect((await put("b", `${teamId}/docs/bobs.txt`, "bob", TOKENS.bob, "bob writes on b")).status).toBe(201);
    expect((await put("a", "/bobs-own/x.txt", "mine", TOKENS.bob, "bob writes own drive on a")).status).toBe(201);
    const erased = await call("b", "DELETE", "/account?confirm=yes", { token: TOKENS.bob, check: "bob erases on b" });
    expect(erased.status).toBe(200);
    expect((await call("a", "GET", "/items?path=/", { token: TOKENS.bob, check: "bob's drive after erase on a" })).status).toBe(200);
    expect(await json(await call("a", "GET", "/items?path=/", { token: TOKENS.bob }))).toEqual([]);
    const bobs = (await json(await call("a", "GET", "/items?path=/team/docs"))).find((n: { name: string }) => n.name === "bobs.txt");
    expect(bobs.createdBy).toEqual({ id: "erased", kind: "human" });
    expect((await call("a", "GET", `/stat?path=${fileId}`, { token: TOKENS.bob, check: "bob's share after erase on a" })).status).toBe(404);
    expect((await call("b", "GET", "/stat?path=/team/docs/a.txt", { check: "alice's data after bob's erase on b" })).status).toBe(200);
  });

  it("puts every app's documents in one home view on both Workers", async () => {
    expect((await call("a", "POST", "/documents", { json: { ref: "docs:d1", name: "Plan" }, check: "register docs on a" })).status).toBe(201);
    expect((await call("b", "POST", "/documents", { json: { ref: "sheets:s1", name: "Budget", folder: "/Finance" }, check: "register sheets on b" })).status).toBe(201);
    const home = await json(await call("a", "GET", "/home", { check: "home on a" }));
    expect(home.apps).toEqual({ docs: 1, sheets: 1 });
    expect(home.items.map((i: { app: string | null }) => i.app)).toEqual(expect.arrayContaining(["docs", "sheets", null]));
    expect((await json(await call("b", "GET", "/home?app=sheets"))).items.map((i: { name: string }) => i.name)).toEqual(["Budget"]);
    expect((await call("b", "DELETE", "/documents?ref=docs:d1", { check: "forget docs on b" })).status).toBe(200);
    expect((await json(await call("a", "GET", "/home"))).apps).toEqual({ sheets: 1 });
  });
});

describe("the report", () => {
  it("holds a check for every step, with no secret in it", () => {
    expect(checks.length).toBeGreaterThan(50);
    const text = JSON.stringify(checks);
    for (const secret of [...Object.values(TOKENS), URL_SECRET, linkToken, "http://"]) expect(text).not.toContain(secret);
    expect(bundle.length).toBeGreaterThan(1000);
  });
});

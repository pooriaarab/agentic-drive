// End to end: the real Worker under `wrangler dev`, with local D1 and R2.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticate } from "./worker.js";
import { readZip } from "./zip.js";

const root = join(import.meta.dirname, "..");
const port = 8700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const tok = (name: string) => `${name}-`.padEnd(40, "k");
const TOK_U1 = tok("u1");
const TOK_BOT = tok("bot");
const TOK_U2 = tok("u2");
const TOK_NO_ACTOR = tok("noactor");
const TOK_AGENT_NO_ACTOR = tok("agentnoactor");
const TOK_SHORT = "short-token";
const tokens = {
  [TOK_U1]: { owner: "u1", actor: "u1", kind: "human" },
  [TOK_BOT]: { owner: "u1", actor: "bot", kind: "agent_of_human" },
  [TOK_U2]: { owner: "u2", actor: "u2", kind: "human" },
  [TOK_NO_ACTOR]: { owner: "u1", kind: "human" },
  [TOK_AGENT_NO_ACTOR]: { owner: "u1", kind: "agent_of_human" },
  [TOK_SHORT]: { owner: "u1", actor: "u1", kind: "human" },
};
let proc: ChildProcess;

async function call(method: string, path: string, opts: { token?: string | null; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const token = opts.token === undefined ? TOK_U1 : opts.token;
  const res = await fetch(`${base}/api/v1/drive${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.json ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  return res;
}
const json = async (res: Response) => (await res.json()) as any;
const put = (path: string, data: string | Uint8Array, token?: string | null, q = "") =>
  call("PUT", `/files?path=${encodeURIComponent(path)}${q}`, { token, body: data as BodyInit, headers: { "content-type": "application/octet-stream" } });

beforeAll(async () => {
  const persist = mkdtempSync(join(tmpdir(), "drive-wrangler-"));
  proc = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--var", `DRIVE_API_TOKENS:${JSON.stringify(tokens)}`, "--var", "DRIVE_MAX_BYTES:1000"], {
    cwd: root, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}, 90_000);
afterAll(() => {
  proc?.kill("SIGTERM");
});

describe("sign-in", () => {
  it("answers 401 without a token, with a wrong token, and with a token that only shares a prefix", async () => {
    expect((await call("GET", "/items", { token: null })).status).toBe(401);
    expect((await call("GET", "/items", { token: "nope" })).status).toBe(401);
    expect((await call("GET", "/items", { token: TOK_U1.slice(0, 39) })).status).toBe(401);
    expect((await json(await call("GET", "/items", { token: null }))).error.code).toBe("UNAUTHORIZED");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
  it("fails closed when tokens are unset or broken", () => {
    const as = (token: string) => new Request("http://x", { headers: { authorization: `Bearer ${token}` } });
    const withGrant = (grant: unknown, token = TOK_U1) => ({ DRIVE_API_TOKENS: JSON.stringify({ [token]: grant }) }) as never;
    expect(authenticate(as(TOK_U1), {} as never)).toBeNull();
    expect(authenticate(as(TOK_U1), { DRIVE_API_TOKENS: "{not json" } as never)).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({}))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant(null))).toBeNull();
    expect(authenticate(as(TOK_U1), { DRIVE_API_TOKENS: JSON.stringify(tokens) } as never)).toEqual({ owner: "u1", actor: { id: "u1", kind: "human" } });
    // Each part of the principal is required. A missing or malformed part denies the token.
    expect(authenticate(as(TOK_U1), withGrant({ owner: "u1", kind: "human" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: "u1", actor: "u1" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: "u1", actor: "", kind: "human" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: "", actor: "u1", kind: "human" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: "u1", actor: "u1", kind: "root" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: 7, actor: "u1", kind: "human" }))).toBeNull();
    expect(authenticate(as(TOK_U1), withGrant({ owner: "u1", actor: ["u1"], kind: "human" }))).toBeNull();
    expect(authenticate(as(TOK_SHORT), withGrant({ owner: "u1", actor: "u1", kind: "human" }, TOK_SHORT))).toBeNull();
  });
  it("answers 401 on every route without a token", async () => {
    const routes: [string, string][] = [
      ["GET", "/items"], ["GET", "/stat?path=/"], ["POST", "/folders"], ["PUT", "/files?path=/x"], ["GET", "/files?path=/x"], ["GET", "/url?path=/x"],
      ["POST", "/move"], ["POST", "/trash"], ["GET", "/trash"], ["POST", "/restore"], ["POST", "/purge"], ["GET", "/search"], ["GET", "/export"], ["DELETE", "/account?confirm=yes"],
    ];
    for (const [method, path] of routes) expect((await call(method, path, { token: null })).status, `${method} ${path}`).toBe(401);
  });
  it("answers 401 for a token with no actor, and an agent token with no actor cannot delete anything", async () => {
    expect((await put("/keep-me.txt", "keep")).status).toBe(201);
    for (const token of [TOK_NO_ACTOR, TOK_AGENT_NO_ACTOR, TOK_SHORT]) {
      expect((await call("GET", "/items", { token })).status, token).toBe(401);
      expect((await call("DELETE", "/account?confirm=yes", { token })).status, token).toBe(401);
      expect((await call("POST", "/trash", { token, json: { path: "/keep-me.txt" } })).status, token).toBe(401);
    }
    expect((await call("GET", "/stat?path=/keep-me.txt")).status).toBe(200);
  });
  it("returns JSON errors for unknown routes", async () => {
    const res = await fetch(`${base}/api/v1/drive/nowhere`, { headers: { authorization: `Bearer ${TOK_U1}` } });
    expect(res.status).toBe(404);
  });
});

describe("files", () => {
  it("stores bytes, reports metadata, and serves the same bytes back safely", async () => {
    expect((await call("POST", "/folders", { json: { path: "/docs/2026", parents: true } })).status).toBe(201);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
    const up = await put("/docs/2026/pic.html", png);
    expect(up.status).toBe(201);
    const node = await json(up);
    expect(node).toMatchObject({ name: "pic.html", mime: "image/png", size: 10, owner: "u1", createdBy: { id: "u1", kind: "human" } });
    expect(node.blobKey).toBeUndefined();
    const down = await call("GET", "/files?path=/docs/2026/pic.html");
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    expect(down.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(png);
    expect((await json(await call("GET", "/items?path=/docs/2026"))).map((n: { name: string }) => n.name)).toEqual(["pic.html"]);
  });
  it("refuses an upload over the cap, by header and by stream, and keeps nothing", async () => {
    const big = new Uint8Array(1500);
    expect((await put("/big1", big)).status).toBe(413);
    const chunked = new ReadableStream({ start(c) { c.enqueue(big.slice(0, 700)); c.enqueue(big.slice(700)); c.close(); } });
    const res = await fetch(`${base}/api/v1/drive/files?path=/big2`, { method: "PUT", headers: { authorization: `Bearer ${TOK_U1}` }, body: chunked, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect((await call("GET", "/stat?path=/big2")).status).toBe(404);
    expect((await call("GET", "/stat?path=/big1")).status).toBe(404);
  });
  it("answers 409 for a taken name, 400 for a bad name, 409 for a move into itself", async () => {
    expect((await put("/dup.txt", "1")).status).toBe(201);
    const again = await put("/dup.txt", "2");
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("NAME_TAKEN");
    expect((await put("/DUP.TXT", "3")).status).toBe(409);
    expect((await put("/a/../b", "x", undefined, "&parents=true")).status).toBe(400);
    await call("POST", "/folders", { json: { path: "/p/q", parents: true } });
    const self = await call("POST", "/move", { json: { src: "/p", folder: "/p/q" } });
    expect(self.status).toBe(409);
    expect((await json(self)).error.code).toBe("MOVE_INTO_SELF");
    expect((await call("POST", "/folders", { json: { path: 5 } })).status).toBe(400);
    expect((await call("POST", "/folders", { body: "not json" })).status).toBe(400);
  });
  it("keeps owners apart", async () => {
    expect((await call("GET", "/stat?path=/dup.txt", { token: TOK_U2 })).status).toBe(404);
    expect(await json(await call("GET", "/items", { token: TOK_U2 }))).toEqual([]);
    expect((await call("GET", "/search?name=dup", { token: TOK_U2 })).status).toBe(200);
    expect(await json(await call("GET", "/search?name=dup", { token: TOK_U2 }))).toEqual([]);
  });
  it("answers 400 for a JSON body that is not an object", async () => {
    for (const raw of ["null", "[]", "5", '"x"']) {
      const res = await call("POST", "/folders", { body: raw, headers: { "content-type": "application/json" } });
      expect(res.status, raw).toBe(400);
    }
  });
  it("treats a generic form type as no claim and sniffs text", async () => {
    const res = await call("PUT", "/files?path=/note.txt", { body: "hello", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await json(res)).mime).toBe("text/plain");
  });
  it("has no signed URLs until R2 keys are set", async () => {
    expect((await call("GET", "/url?path=/dup.txt")).status).toBe(501);
  });
});

describe("trash, search, export, erase", () => {
  it("trashes, restores, and purges", async () => {
    await put("/t/x.txt", "bye", TOK_U1, "&parents=true");
    const trashed = await json(await call("POST", "/trash", { json: { path: "/t" } }));
    expect((await call("GET", "/stat?path=/t/x.txt")).status).toBe(404);
    expect((await json(await call("GET", "/trash"))).map((n: { id: string }) => n.id)).toContain(trashed.id);
    expect((await call("POST", "/purge", { json: { id: "nope" } })).status).toBe(404);
    expect((await call("POST", "/restore", { json: { id: trashed.id } })).status).toBe(200);
    expect((await call("GET", "/stat?path=/t/x.txt")).status).toBe(200);
    const again = await json(await call("POST", "/trash", { json: { path: "/t" } }));
    expect((await call("POST", "/purge", { json: { id: again.id } })).status).toBe(200);
    expect((await call("GET", "/stat?path=/t/x.txt")).status).toBe(404);
  });
  it("searches and labels agent work", async () => {
    await put("/by-bot.txt", "robot", TOK_BOT);
    const hits = await json(await call("GET", "/search?createdByKind=agent_of_human&kind=file"));
    expect(hits.map((h: { path: string }) => h.path)).toEqual(["/by-bot.txt"]);
    expect(hits[0].createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
  });
  it("exports a valid zip", async () => {
    const res = await call("GET", "/export");
    expect(res.headers.get("content-type")).toBe("application/zip");
    const zip = readZip(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!));
    const item = manifest.items.find((i: { path: string }) => i.path === "/by-bot.txt");
    expect(new TextDecoder().decode(zip.get(item.file)!)).toBe("robot");
    expect(manifest.items.every((i: { owner: string }) => i.owner === "u1")).toBe(true);
  });
  it("erases only with confirmation, never for an agent, and only the caller's data", async () => {
    await put("/theirs.txt", "keep", TOK_U2);
    expect((await call("DELETE", "/account")).status).toBe(400);
    expect((await call("DELETE", "/account?confirm=yes", { token: TOK_BOT })).status).toBe(403);
    expect((await call("GET", "/stat?path=/dup.txt")).status).toBe(200);
    const gone = await json(await call("DELETE", "/account?confirm=yes"));
    expect(gone.removed).toBeGreaterThan(3);
    expect(await json(await call("GET", "/items"))).toEqual([]);
    expect((await json(await call("GET", "/items", { token: TOK_U2 }))).map((n: { name: string }) => n.name)).toEqual(["theirs.txt"]);
  });
});

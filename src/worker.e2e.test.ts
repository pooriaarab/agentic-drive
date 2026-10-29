// End to end: the real Worker under `wrangler dev`, with local D1 and R2.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore, type Doc } from "agentic-identity";
import { D1_SCHEMA } from "agentic-identity/cloudflare";
import { authenticate, createApp } from "./worker.js";
import { readZip } from "./zip.js";

const root = join(import.meta.dirname, "..");
let port = 0;
let base = "";
const tok = (name: string) => `${name}-`.padEnd(40, "k");
const TOK_U1 = tok("u1");
const TOK_BOT = tok("bot");
const TOK_U2 = tok("u2");
const TOK_READ_BOT = tok("readbot");
const TOK_REVOKED = tok("revoked");
const TOK_GHOST = tok("ghost");
const TOK_EXPIRED = tok("expired");
const TOK_CUT = tok("cut");
const URL_SECRET = "drive-url-secret-".padEnd(40, "s");
// Each token is a credential of identity's store-backed sign-in: a doc keyed by the SHA-256 of the token.
const credentials: [token: string, doc: Doc][] = [
  [TOK_U1, { principalId: "u1", kind: "api_key" }],
  [TOK_BOT, { principalId: "bot", kind: "api_key" }],
  [TOK_READ_BOT, { principalId: "readbot", kind: "api_key" }],
  [TOK_U2, { principalId: "u2", kind: "api_key" }],
  [TOK_REVOKED, { principalId: "revoked", kind: "api_key" }],
  [TOK_GHOST, { principalId: "nobody", kind: "api_key" }],
  [TOK_EXPIRED, { principalId: "u1", kind: "api_key", expiresAt: 1 }],
  [TOK_CUT, { principalId: "u1", kind: "api_key", revokedAt: 1 }],
];
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
// The people and agents behind the tokens, in the shape the identity package keeps them.
const principals: Doc[] = [
  { id: "u1", kind: "human", scopes: ["drive:admin"] },
  { id: "u2", kind: "human", scopes: ["drive:admin"] },
  { id: "bot", kind: "agent_of_human", parentId: "u1", scopes: ["drive:write"] },
  { id: "readbot", kind: "agent_of_human", parentId: "u1", scopes: ["drive:read"] },
  { id: "revoked", kind: "human", scopes: ["drive:admin"], revokedAt: 1 },
];
const seedSql = () =>
  `${D1_SCHEMA};\n${principals
    .map((p) => `INSERT INTO store_docs (collection, id, body) VALUES ('principals', '${p.id}', '${JSON.stringify(p)}');`)
    .join("\n")}\n${credentials
    .map(([token, doc]) => `INSERT INTO store_docs (collection, id, body) VALUES ('credentials', '${hashOf(token)}', '${JSON.stringify(doc)}');`)
    .join("\n")}\nINSERT INTO store_docs (collection, id, body) VALUES ('users', 'u2', '${JSON.stringify({ email: "U2@example.com", emailVerified: true })}');\n`;
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

// The system picks the port, so a wrangler left over from an earlier run cannot answer for this one.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });

beforeAll(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = mkdtempSync(join(tmpdir(), "drive-wrangler-"));
  const seed = join(persist, "seed.sql");
  writeFileSync(seed, seedSql());
  const seeded = spawnSync("npx", ["wrangler", "d1", "execute", "agentic-drive", "--local", "--persist-to", persist, "--file", seed], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  if (seeded.status !== 0) throw new Error(`could not seed the database: ${seeded.stderr}`);
  proc = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--var", "DRIVE_MAX_BYTES:1000", "--var", `DRIVE_PUBLIC_URL:${base}`, "--var", `DRIVE_URL_SECRET:${URL_SECRET}`, "--var", "DRIVE_REGION:unknown"], {
    cwd: root, stdio: "ignore", detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
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
  // wrangler starts child processes. Stop the whole group, or they keep the port.
  if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
});

describe("sign-in", () => {
  it("answers 401 without a token, with a wrong token, and with a token that only shares a prefix", async () => {
    expect((await call("GET", "/items", { token: null })).status).toBe(401);
    expect((await call("GET", "/items", { token: "nope" })).status).toBe(401);
    expect((await call("GET", "/items", { token: TOK_U1.slice(0, 39) })).status).toBe(401);
    expect((await json(await call("GET", "/items", { token: null }))).error.code).toBe("UNAUTHORIZED");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
  it("fails closed on a missing, unknown, expired, or revoked credential, and on a principal that is not live", async () => {
    const store = createMemoryStore();
    for (const p of principals) await store.put("principals", p.id as string, p);
    for (const [token, doc] of credentials) await store.put("credentials", hashOf(token), doc);
    const as = (token: string) => new Request("http://x", { headers: { authorization: `Bearer ${token}` } });
    expect(await authenticate(new Request("http://x"), store)).toBeNull();
    expect(await authenticate(as("not-a-credential"), store)).toBeNull();
    expect(await authenticate(as(TOK_GHOST), store)).toBeNull();
    expect(await authenticate(as(TOK_REVOKED), store)).toBeNull();
    expect(await authenticate(as(TOK_EXPIRED), store)).toBeNull();
    expect(await authenticate(as(TOK_CUT), store)).toBeNull();
    expect(await authenticate(as(`${TOK_U1} x`), store)).toBeNull();
    // A session cookie is not enough: only a bearer token counts.
    expect(await authenticate(new Request("http://x", { headers: { cookie: `session=${TOK_U1}` } }), store)).toBeNull();
    expect(await authenticate(as(TOK_U1), store)).toMatchObject({ owner: "u1", actor: { id: "u1", kind: "human" }, principal: { scopes: ["drive:admin"] } });
    // An agent acts in its owner's drive, with the narrower scopes of its own grant.
    expect(await authenticate(as(TOK_READ_BOT), store)).toMatchObject({
      owner: "u1", actor: { id: "readbot", kind: "agent_of_human" }, principal: { scopes: ["drive:read"], chain: [{ id: "u1", kind: "human" }, { id: "readbot", kind: "agent_of_human" }] },
    });
    // Revoking the owner revokes the agent below it.
    await store.put("principals", "u1", { ...principals[0]!, revokedAt: 1 });
    expect(await authenticate(as(TOK_BOT), store)).toBeNull();
  });
  it("answers 401 on every route without a token", async () => {
    const routes: [string, string][] = [
      ["GET", "/items"], ["GET", "/stat?path=/"], ["POST", "/folders"], ["PUT", "/files?path=/x"], ["GET", "/files?path=/x"], ["GET", "/url?path=/x"],
      ["POST", "/move"], ["POST", "/trash"], ["GET", "/trash"], ["POST", "/restore"], ["POST", "/purge"], ["GET", "/search"], ["GET", "/export"], ["DELETE", "/account?confirm=yes"],
      ["GET", "/shares?path=/x"], ["POST", "/shares"], ["DELETE", "/shares?path=/x&subjectId=u2&subjectKind=human"], ["POST", "/invites"], ["POST", "/invites/accept"], ["POST", "/links"], ["DELETE", "/links?id=x"],
    ];
    for (const [method, path] of routes) expect((await call(method, path, { token: null })).status, `${method} ${path}`).toBe(401);
  });
  it("answers 401 for a credential of a missing or revoked principal, and for an expired or revoked credential", async () => {
    expect((await put("/keep-me.txt", "keep")).status).toBe(201);
    for (const token of [TOK_GHOST, TOK_REVOKED, TOK_EXPIRED, TOK_CUT]) {
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
  it("refuses every API call while the URL settings are missing", async () => {
    const app = createApp();
    const request = () => new Request("http://x/api/v1/drive/items", { headers: { authorization: `Bearer ${TOK_U1}` } });
    const env = { DB: {}, FILES: {} };
    for (const extra of [{}, { DRIVE_PUBLIC_URL: base }, { DRIVE_URL_SECRET: URL_SECRET }, { DRIVE_PUBLIC_URL: base, DRIVE_URL_SECRET: "too-short" }, { DRIVE_PUBLIC_URL: "not a url", DRIVE_URL_SECRET: URL_SECRET }]) {
      const res = await app.fetch(request(), { ...env, ...extra } as never);
      expect(res.status, JSON.stringify(extra)).toBe(503);
      expect((await json(res)).error.code).toBe("NOT_CONFIGURED");
    }
  });
});

describe("signed download URLs", () => {
  const signed = async (path: string, expires = "") => (await json(await call("GET", `/url?path=${encodeURIComponent(path)}${expires}`))).url as string;
  it("serve the bytes as an attachment with the stored type, with no bearer token", async () => {
    await put("/sig/data.csv", "a,b\n1,2\n", TOK_U1, "&parents=true&mime=text/csv");
    const url = await signed("/sig/data.csv");
    expect(url.startsWith(`${base}/api/v1/drive/blob?`)).toBe(true);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''data.csv");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("a,b\n1,2\n");
  });
  it("serve a stored page as opaque bytes, never as a page", async () => {
    await put("/sig/page.html", "<script>alert(1)</script>", TOK_U1, "&mime=text/html");
    const res = await fetch(await signed("/sig/page.html"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
  });
  it("refuse a changed key, a changed signature, a missing part, and another route's token", async () => {
    const url = new URL(await signed("/sig/data.csv"));
    const other = new URL(await signed("/sig/page.html"));
    const swapped = new URL(url);
    swapped.searchParams.set("key", other.searchParams.get("key")!);
    const bad = new URL(url);
    bad.searchParams.set("sig", "0".repeat(64));
    const noSig = new URL(url);
    noSig.searchParams.delete("sig");
    for (const target of [swapped, bad, noSig]) expect((await fetch(target)).status, target.search).toBe(403);
    expect((await fetch(`${base}/api/v1/drive/blob`)).status).toBe(403);
  });
  it("stop working at the expiry", async () => {
    const url = await signed("/sig/data.csv", "&expires=1");
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await fetch(url)).status).toBe(403);
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

describe("sharing over HTTP", () => {
  const post = (path: string, json: unknown, token?: string | null) => call("POST", path, { token, json });
  const status = async (res: Promise<Response>) => (await res).status;
  const visit = (path: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/drive/shared${path}`, { headers });
  let folderId = "";
  let fileId = "";
  it("hides an item from a person with no role, and shows it after a viewer share", async () => {
    expect((await put("/pub/docs/a.txt", "hello", TOK_U1, "&parents=true&mime=text/plain")).status).toBe(201);
    folderId = (await json(await call("GET", "/stat?path=/pub"))).id;
    fileId = (await json(await call("GET", "/stat?path=/pub/docs/a.txt"))).id;
    expect(await status(call("GET", `/stat?path=${fileId}`, { token: TOK_U2 }))).toBe(404);
    expect(await status(call("GET", `/items?path=${folderId}`, { token: TOK_U2 }))).toBe(404);
    expect(await status(call("GET", `/files?path=${fileId}`, { token: TOK_U2 }))).toBe(404);
    expect(await status(post("/shares", { path: "/pub", subjectId: "u2", subjectKind: "human", role: "viewer" }))).toBe(200);
    expect(await status(call("GET", `/stat?path=${fileId}`, { token: TOK_U2 }))).toBe(200);
    expect((await json(await call("GET", `/items?path=${folderId}`, { token: TOK_U2 }))).map((n: { name: string }) => n.name)).toEqual(["docs"]);
    expect(await (await call("GET", `/files?path=${fileId}`, { token: TOK_U2 })).text()).toBe("hello");
    expect(await status(fetch(await json(await call("GET", `/url?path=${fileId}`, { token: TOK_U2 })).then((b) => b.url)))).toBe(200);
  });
  it("answers 403 to a viewer on every write route, and on every share route", async () => {
    const as = TOK_U2;
    expect(await status(put(`${folderId}/n.txt`, "x", as))).toBe(403);
    expect(await status(post("/folders", { path: `${folderId}/d` }, as))).toBe(403);
    expect(await status(post("/trash", { path: fileId }, as))).toBe(403);
    expect(await status(post("/move", { src: fileId, folder: folderId }, as))).toBe(403);
    expect(await status(post("/shares", { path: folderId, subjectId: "u2", subjectKind: "human", role: "owner" }, as))).toBe(403);
    expect(await status(call("GET", `/shares?path=${folderId}`, { token: as }))).toBe(403);
    expect(await status(post("/links", { path: folderId, role: "viewer" }, as))).toBe(403);
    expect(await status(post("/invites", { path: folderId, role: "viewer", handle: "x" }, as))).toBe(403);
    expect(await status(call("DELETE", `/shares?path=${folderId}&subjectId=u1&subjectKind=human`, { token: as }))).toBe(403);
    expect((await call("GET", "/search?name=a.txt", { token: as })).status).toBe(200);
    expect(await json(await call("GET", "/search?name=a.txt", { token: as }))).toEqual([]);
  });
  it("lets an editor write into the shared folder, in the owner's drive, but not purge or share", async () => {
    expect(await status(post("/shares", { path: "/pub", subjectId: "u2", subjectKind: "human", role: "editor" }))).toBe(200);
    const made = await put(`${folderId}/n.txt`, "from u2", TOK_U2);
    expect(made.status).toBe(201);
    const node = await json(made);
    expect(node).toMatchObject({ owner: "u1", createdBy: { id: "u2", kind: "human" } });
    expect(await status(put("/pub/n.txt", "dup"))).toBe(409);
    expect(await status(post("/trash", { path: node.id }, TOK_U2))).toBe(200);
    expect(await status(post("/purge", { id: node.id }, TOK_U2))).toBe(403);
    expect(await status(post("/shares", { path: folderId, subjectId: "u2", subjectKind: "human", role: "owner" }, TOK_U2))).toBe(403);
    expect(await status(post("/purge", { id: node.id }))).toBe(200);
  });
  it("narrows an agent to its scopes", async () => {
    expect(await status(call("GET", "/items?path=/pub", { token: TOK_READ_BOT }))).toBe(200);
    expect(await status(put("/pub/by-readbot.txt", "x", TOK_READ_BOT))).toBe(403);
    expect(await status(put("/pub/by-bot.txt", "x", TOK_BOT))).toBe(201);
    expect(await status(post("/shares", { path: "/pub", subjectId: "u2", subjectKind: "human", role: "owner" }, TOK_BOT))).toBe(403);
  });
  it("serves a linked folder to a visitor, and stops at the expiry, the revoke, and a wrong token", async () => {
    await call("DELETE", `/shares?path=/pub&subjectId=u2&subjectKind=human`);
    expect(await status(call("GET", `/stat?path=${fileId}`, { token: TOK_U2 }))).toBe(404);
    const link = await json(await post("/links", { path: "/pub", role: "viewer", expiresInMs: 60_000 }));
    expect(link.token).toBeTruthy();
    const open = await visit(`/${fileId}`, { "x-link-token": link.token });
    expect(open.status).toBe(200);
    expect((await open.json()).name).toBe("a.txt");
    const content = await visit(`/${fileId}/content`, { "x-link-token": link.token });
    expect(await content.text()).toBe("hello");
    expect(content.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await (await visit(`/${folderId}/items`, { "x-link-token": link.token })).json()).map((n: { name: string }) => n.name)).toEqual(["by-bot.txt", "docs"]);
    expect((await visit(`/${fileId}`)).status).toBe(404);
    expect((await visit(`/${fileId}`, { "x-link-token": "wrong" })).status).toBe(404);
    expect((await visit(`/${fileId}`, { "x-link-token": link.token, authorization: "Bearer nope" })).status).toBe(401);
    expect(await status(call("DELETE", `/links?id=${link.id}`))).toBe(200);
    expect((await visit(`/${fileId}`, { "x-link-token": link.token })).status).toBe(404);
    const short = await json(await post("/links", { path: "/pub", role: "viewer", expiresInMs: 1_000 }));
    await new Promise((r) => setTimeout(r, 1_300));
    expect((await visit(`/${fileId}`, { "x-link-token": short.token })).status).toBe(404);
    expect(await status(post("/links", { path: "/pub", role: "viewer", expiresInMs: -5 }))).toBe(400);
  });
  it("asks for a sign-in on a link that needs one, and lists shares without tokens", async () => {
    const link = await json(await post("/links", { path: "/pub", role: "viewer", signedInOnly: true }));
    expect((await visit(`/${fileId}`, { "x-link-token": link.token })).status).toBe(404);
    expect((await visit(`/${fileId}`, { "x-link-token": link.token, authorization: `Bearer ${TOK_U2}` })).status).toBe(200);
    const shown = await call("GET", "/shares?path=/pub");
    const text = await shown.text();
    expect(text).not.toContain(link.token);
    expect(JSON.parse(text).links.length).toBeGreaterThan(1);
  });
  it("accepts an invite by verified email, and only once", async () => {
    const invite = await json(await post("/invites", { path: "/pub", role: "viewer", email: "u2@example.com", expiresInMs: 60_000 }));
    expect(invite.id).toBeTruthy();
    expect(await status(post("/invites/accept", { id: invite.id }, TOK_BOT))).toBe(403);
    expect(await status(call("GET", `/stat?path=${fileId}`, { token: TOK_U2 }))).toBe(404);
    expect(await status(post("/invites/accept", { id: invite.id }, TOK_U2))).toBe(200);
    expect(await status(call("GET", `/stat?path=${fileId}`, { token: TOK_U2 }))).toBe(200);
    expect(await status(post("/invites/accept", { id: invite.id }, TOK_U2))).toBe(403);
    expect(await status(post("/invites", { path: "/pub", role: "viewer" }))).toBe(400);
  });
});

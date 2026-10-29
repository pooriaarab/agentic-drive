// The client against the real Worker under `wrangler dev`, with local D1 and R2.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import ts from "typescript";
import type { Doc } from "agentic-identity";
import { D1_SCHEMA } from "agentic-identity/cloudflare";
import { createClient, DriveApiError } from "./client.js";

const root = join(import.meta.dirname, "..");
let port = 0;
let base = "";
const tok = (name: string) => `${name}-`.padEnd(40, "k");
const TOK_U1 = tok("u1");
const TOK_U3 = tok("u3");
const TOK_U2 = tok("u2");
const TOK_READ_BOT = tok("readbot");
const URL_SECRET = "drive-url-secret-".padEnd(40, "s");
// Each token is a credential of identity's store-backed sign-in: a doc keyed by the SHA-256 of the token.
const credentials: [token: string, doc: Doc][] = [
  [TOK_U1, { principalId: "u1", kind: "api_key" }],
  [TOK_READ_BOT, { principalId: "readbot", kind: "api_key" }],
  [TOK_U2, { principalId: "u2", kind: "api_key" }],
  [TOK_U3, { principalId: "u3", kind: "api_key" }],
];
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
// The people and agents behind the tokens, in the shape the identity package keeps them.
const principals: Doc[] = [
  { id: "u1", kind: "human", scopes: ["drive:admin"] },
  { id: "u2", kind: "human", scopes: ["drive:admin"] },
  { id: "u3", kind: "human", scopes: ["drive:admin"] },
  { id: "readbot", kind: "agent_of_human", parentId: "u1", scopes: ["drive:read"] },
];
const seedSql = () =>
  `${D1_SCHEMA};\n${principals
    .map((p) => `INSERT INTO store_docs (collection, id, body) VALUES ('principals', '${p.id}', '${JSON.stringify(p)}');`)
    .join("\n")}\n${credentials
    .map(([token, doc]) => `INSERT INTO store_docs (collection, id, body) VALUES ('credentials', '${hashOf(token)}', '${JSON.stringify(doc)}');`)
    .join("\n")}\nINSERT INTO store_docs (collection, id, body) VALUES ('users', 'u2', '${JSON.stringify({ email: "U2@example.com", emailVerified: true })}');\n`;
let proc: ChildProcess;

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


const bytes = (s: string) => new TextEncoder().encode(s);
const text = (d: Uint8Array) => new TextDecoder().decode(d);
const as = (token: string) => createClient({ baseUrl: base, token });
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DriveApiError);
    return error as DriveApiError;
  }
  throw new Error("the call did not fail");
};

describe("the client on the real Worker", () => {
  it("stores, reads, moves, trashes, restores, and purges", async () => {
    const me = as(TOK_U1);
    expect((await me.mkdir("/docs/2026", { parents: true })).kind).toBe("folder");
    const file = await me.upload("/docs/a.txt", "hello", { mime: "text/plain" });
    expect(file).toMatchObject({ name: "a.txt", size: 5, kind: "file", createdBy: { id: "u1", kind: "human" } });
    expect(file).not.toHaveProperty("blobKey");
    const got = await me.download("/docs/a.txt");
    expect(text(got.data)).toBe("hello");
    expect(got.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect((await me.list("/docs")).map((n) => n.name).sort()).toEqual(["2026", "a.txt"]);
    expect((await me.stat(file.id)).id).toBe(file.id);
    expect((await me.upload("/docs/b.bin", bytes("bytes"), {})).size).toBe(5);
    expect((await me.move("/docs/b.bin", "/docs/2026", { name: "c.bin" })).name).toBe("c.bin");
    expect((await me.search({ name: "c.bin" }))[0]).toMatchObject({ path: "/docs/2026/c.bin" });
    expect((await me.url("/docs/a.txt", 60)).expiresInSeconds).toBe(60);
    expect((await me.trash("/docs/a.txt")).trashed).toBe(true);
    expect((await me.listTrash()).map((n) => n.id)).toEqual([file.id]);
    expect((await me.restore(file.id)).trashed).toBe(false);
    await me.trash("/docs/a.txt");
    expect(await me.purge(file.id)).toEqual({ removed: 1 });
    expect(Object.keys((await me.home()).apps)).toEqual([]);
    expect((await me.export()).byteLength).toBeGreaterThan(20);
  });
  it("registers and forgets a document of another app", async () => {
    const me = as(TOK_U1);
    const doc = await me.registerDocument({ ref: "docs:abc", name: "Plan" });
    expect(doc).toMatchObject({ kind: "ref", ref: "docs:abc" });
    expect((await me.home({ app: "docs" })).apps).toEqual({ docs: 1 });
    expect(await me.forgetDocument("docs:abc")).toEqual({ trashed: 1 });
  });
  it("finds a ref, lists the trash with paths, and claims a ref with a role", async () => {
    const me = as(TOK_U1);
    const doc = await me.registerDocument({ ref: "docs:hostops", name: "Plan", folder: "/hostops" });
    expect((await me.findByRef("docs:hostops")).map((r) => [r.id, r.path])).toEqual([[doc.id, "/hostops/Plan"]]);
    expect(await me.findByRef("docs:none")).toEqual([]);
    expect(await failure(me.findByRef("not a ref"))).toMatchObject({ code: "INVALID_REF", status: 400 });
    expect(await me.forgetDocument("docs:hostops")).toEqual({ trashed: 1 });
    expect(await me.findByRef("docs:hostops")).toEqual([]);
    expect((await me.listTrashWithPaths()).find((r) => r.id === doc.id)).toMatchObject({ path: "/hostops/Plan", trashed: true });

    const claimed = await me.claimRef({ path: "/hostops/claimed", ref: "docs:claimed", subject: { kind: "human", id: "u3" }, role: "viewer" });
    expect(claimed).toMatchObject({ kind: "ref", ref: "docs:claimed" });
    expect((await as(TOK_U3).stat(claimed.id)).id).toBe(claimed.id);
    // A bad role undoes the put, and the name stays free.
    expect(await failure(me.claimRef({ path: "/hostops/undone", ref: "docs:undone", subject: { kind: "human", id: "u3" }, role: "boss" as never }))).toMatchObject({ code: "INVALID_SHARE", status: 400 });
    expect(await me.findByRef("docs:undone")).toEqual([]);
    expect((await me.list("/hostops")).map((n) => n.name)).not.toContain("undone");
  });
  it("fails with the code and the status of the API", async () => {
    const wrong = await failure(as("not-a-credential-".padEnd(40, "x")).list("/"));
    expect(wrong).toMatchObject({ code: "UNAUTHORIZED", status: 401, name: "DriveApiError" });
    const missing = await failure(as(TOK_U1).stat("/nothing/here"));
    expect(missing).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const readOnly = await failure(as(TOK_READ_BOT).upload("/x.txt", "x"));
    expect(readOnly).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await as(TOK_U1).upload("/twice.txt", "1");
    expect(await failure(as(TOK_U1).upload("/twice.txt", "2"))).toMatchObject({ code: "NAME_TAKEN", status: 409 });
    expect(await failure(as(TOK_U1).upload("/big.bin", new Uint8Array(2000)))).toMatchObject({ code: "TOO_LARGE", status: 413 });
  });
  it("shares by kind, by invite, and by link, and a visitor reads with a link token alone", async () => {
    const me = as(TOK_U1);
    const folder = await me.mkdir("/pub");
    await me.upload("/pub/f.txt", "shared");
    await failure(as(TOK_U2).stat(folder.id));
    await me.share("/pub", { kind: "human", id: "u2" }, "viewer");
    expect((await as(TOK_U2).stat(folder.id)).name).toBe("pub");
    expect((await me.shares("/pub")).grants).toContainEqual({ subjectKind: "human", subjectId: "u2", role: "viewer" });
    expect(await failure(as(TOK_U2).share(folder.id, { kind: "human", id: "u3" }, "viewer"))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await me.unshare("/pub", { kind: "human", id: "u2" });
    expect(await failure(as(TOK_U2).stat(folder.id))).toMatchObject({ code: "NOT_FOUND" });
    expect(await failure(me.share("/pub", { kind: "robot" as never, id: "u2" }, "viewer"))).toMatchObject({ code: "INVALID_SHARE", status: 400 });
    const link = await me.createLink("/pub", { role: "viewer" });
    const visitor = createClient({ baseUrl: base });
    expect((await visitor.openShared(folder.id, { linkToken: link.token })).name).toBe("pub");
    const [child] = await visitor.listShared(folder.id, { linkToken: link.token });
    expect(text((await visitor.readShared(child!.id, { linkToken: link.token })).data)).toBe("shared");
    expect(await failure(visitor.openShared(folder.id))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    await me.revokeLink(link.id);
    expect(await failure(visitor.openShared(folder.id, { linkToken: link.token }))).toMatchObject({ status: 404 });
    const invite = await me.invite("/pub", { role: "viewer", email: "u2@example.com" });
    await as(TOK_U2).acceptInvite(invite.id);
    expect((await as(TOK_U2).stat(folder.id)).name).toBe("pub");
  });
  it("runs inside a Worker runtime and calls the real Worker", async () => {
    const client = ts.transpileModule(readFileSync(join(import.meta.dirname, "client.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const script = `import { createClient } from "./client.js";
      export default { async fetch(request, env) {
        const drive = createClient({ baseUrl: env.BASE, token: request.headers.get("x-token") ?? undefined });
        try {
          await drive.mkdir("/from-workerd");
          const file = await drive.upload("/from-workerd/w.txt", "worker bytes");
          const got = await drive.download(file.id);
          await drive.stat("/nothing");
          return Response.json({ wrong: true });
        } catch (error) { return Response.json({ code: error.code, status: error.status, name: error.name }); }
      } };`;
    const mf = new Miniflare({
      compatibilityDate: "2026-01-01",
      modules: [{ type: "ESModule", path: "index.js", contents: script }, { type: "ESModule", path: "client.js", contents: client }],
      bindings: { BASE: base },
    });
    try {
      const answer = await mf.dispatchFetch("http://worker.test/", { headers: { "x-token": TOK_U1 } });
      expect(await answer.json()).toEqual({ code: "NOT_FOUND", status: 404, name: "DriveApiError" });
      expect(text((await as(TOK_U1).download("/from-workerd/w.txt")).data)).toBe("worker bytes");
      const denied = await mf.dispatchFetch("http://worker.test/", { headers: { "x-token": "wrong-".padEnd(40, "z") } });
      expect(await denied.json()).toEqual({ code: "UNAUTHORIZED", status: 401, name: "DriveApiError" });
    } finally {
      await mf.dispose();
    }
  });
  it("erases the caller only on the call", async () => {
    const me = as(TOK_U3);
    await me.upload("/mine.txt", "m");
    expect(await me.deleteAccount()).toMatchObject({ removed: 1 });
    expect(await me.list("/")).toEqual([]);
  });
  it("stops a call with an abort signal, and says so when no answer comes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(as(TOK_U1).list("/", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const down = createClient({ baseUrl: `http://127.0.0.1:${await freePort()}`, token: TOK_U1 });
    expect(await failure(down.list("/"))).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});

describe("the client without a server", () => {
  it("imports nothing from Node, so a browser or a Worker can run it", () => {
    const source = readFileSync(join(import.meta.dirname, "client.ts"), "utf8");
    expect(source.match(/^import .* from "(.*)";$/gm)).toEqual(['import type { ActorKind, ErrorCode, Node, SearchQuery } from "./drive.js";']);
    expect(source.match(/\bimport\s*\(|\brequire\s*\(|\bimport\s+[^t(]|from\s+"node:|process\./g)).toBeNull();
  });
  const counting = (status: number) => {
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${new URL(url).pathname}`);
      return new Response("busy", { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  };
  it("never sends a write twice, and sends a read again only when asked", async () => {
    const { calls, fetcher } = counting(503);
    const client = createClient({ baseUrl: "https://drive.example.com", token: "abc", fetch: fetcher, retries: 2 });
    expect(await failure(client.mkdir("/a"))).toMatchObject({ code: "BAD_RESPONSE", status: 503 });
    expect(await failure(client.upload("/a", "x"))).toMatchObject({ status: 503 });
    expect(await failure(client.purge("x"))).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
    calls.length = 0;
    await failure(client.list("/"));
    expect(calls).toEqual(["GET /api/v1/drive/items", "GET /api/v1/drive/items", "GET /api/v1/drive/items"]);
  });
  it("refuses an id or a link token that would change the route or the header", async () => {
    const { calls, fetcher } = counting(200);
    const client = createClient({ baseUrl: "https://drive.example.com", token: "abc", fetch: fetcher, retries: 2 });
    for (const bad of ["..", ".", "a/b", "", "a b", "a?b", "../items"]) {
      await expect(client.listShared(bad)).rejects.toThrow(TypeError);
      await expect(client.openShared(bad)).rejects.toThrow(TypeError);
      await expect(client.readShared(bad)).rejects.toThrow(TypeError);
    }
    await expect(client.openShared("abc", { linkToken: "bad\ntoken" })).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });
  it("keeps an abort that comes while the error body is read", async () => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: "https://drive.example.com", token: "abc", fetch: (async () => new Response(new ReadableStream({ start: (c) => { controller.abort(); c.error(new DOMException("aborted", "AbortError")); } }), { status: 404 })) as unknown as typeof fetch });
    await expect(client.stat("/a", { signal: controller.signal })).rejects.toBeDefined();
    expect(await client.stat("/a", { signal: controller.signal }).catch((e) => e)).not.toBeInstanceOf(DriveApiError);
  });
  it("refuses a bad base URL, token, or retry count, and a call that needs a token", async () => {
    expect(() => createClient({ baseUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "nope" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://x", token: "bad token" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://x", retries: 99 })).toThrow(RangeError);
    await expect(createClient({ baseUrl: "https://x" }).list("/")).rejects.toThrow(TypeError);
  });
  const answering = (make: () => Response) => createClient({ baseUrl: "https://drive.example.com", token: "abc", fetch: (async () => make()) as unknown as typeof fetch });
  it("fails closed on an answer of another shape, an unknown code, a wrong hash, and a dropped body", async () => {
    const wrongHost = answering(() => Response.json({}));
    expect(await failure(wrongHost.list("/"))).toMatchObject({ code: "BAD_RESPONSE", status: 200 });
    expect(await failure(answering(() => Response.json(null)).stat("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => new Response("<html>", { status: 200 })).stat("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    const unknown = await failure(answering(() => Response.json({ error: { code: "RATE_LIMITED", message: "slow down" } }, { status: 429 })).stat("/a"));
    expect(unknown).toMatchObject({ code: "BAD_RESPONSE", status: 429 });
    const wrongBytes = answering(() => new Response("tampered", { headers: { "x-content-sha256": createHash("sha256").update("original").digest("hex") } }));
    expect(await failure(wrongBytes.download("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => new Response("tampered")).download("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => Response.json({ grants: [1], links: ["x"], invites: [null] })).shares("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => Response.json({ apps: { docs: "many" }, files: 0, items: [] })).home())).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => Response.json({ id: "x", name: "n", kind: "file", size: 1, trashed: false })).stat("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    const item = { id: "x", owner: "u1", parentId: "r", name: "n", kind: "file", size: 1, mime: null, hash: null, ref: null, createdAt: 1, updatedAt: 1, createdBy: { id: "bot", kind: "agent_of_human" }, updatedBy: { id: "bot", kind: "agent_of_human" }, createdById: "bot", updatedById: "bot", trashed: false, trashedAt: null };
    expect(await answering(() => Response.json({ ...item, machineMade: true })).stat("/a")).toMatchObject({ machineMade: true });
    expect(await failure(answering(() => Response.json(item)).stat("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => Response.json({ ...item, machineMade: "yes" })).stat("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    const cut = answering(() => new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("[{")); c.error(new Error("reset")); } })));
    expect(await failure(cut.list("/"))).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    const dropped = answering(() => new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) })));
    expect(await failure(dropped.download("/a"))).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
  it("refuses a signed link that is not an http or https URL, and gives readShared no hash", async () => {
    expect(await failure(answering(() => Response.json({ url: "javascript:alert(1)", expiresInSeconds: 60 })).url("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await answering(() => Response.json({ url: "https://drive.example.com/api/v1/drive/blob?x=1", expiresInSeconds: 60 })).url("/a")).toMatchObject({ expiresInSeconds: 60 });
    expect(await answering(() => new Response("x")).readShared("abc")).not.toHaveProperty("sha256");
  });
  it("treats a redirect as an error", async () => {
    const redirected = createClient({ baseUrl: "http://drive.example.com", token: "abc", fetch: (async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 301, headers: { location: "https://drive.example.com/api/v1/drive/items" } });
    }) as unknown as typeof fetch });
    expect(await failure(redirected.list("/"))).toMatchObject({ code: "BAD_RESPONSE", status: 301 });
  });
  it("refuses an export that is not a zip, and a role or actor kind that the types rule out", async () => {
    expect(await failure(answering(() => new Response("<html>")).export())).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(answering(() => Response.json({ grants: [{ subjectKind: "human", subjectId: "a", role: "boss" }], links: [], invites: [] })).shares("/a"))).toMatchObject({ code: "BAD_RESPONSE" });
  });
  it("stops a wait between two tries when the signal aborts", async () => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: "https://drive.example.com", token: "abc", retries: 3, fetch: (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(client.list("/", { signal: controller.signal })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(90);
  });
});

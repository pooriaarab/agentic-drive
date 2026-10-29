// The Worker app with an injected store, blobs, and auth. No D1 or R2 binding exists here.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore, type PrincipalContext } from "agentic-identity";
import { createR2Blobs, type R2Like } from "agentic-identity/cloudflare";
import type { Ctx } from "./drive.js";
import { createApp } from "./worker.js";

const principal = (id: string, scopes = ["drive:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
// The host's own sign-in: the header names the person. Anything else is no caller.
const auth = (request: Request): Ctx | null => {
  const who = request.headers.get("x-user");
  return who ? ctxOf(principal(who)) : null;
};
type Fetcher = { fetch(request: Request, env: never): Response | Promise<Response> };
const SECRET = "inject-url-secret-".padEnd(40, "s");
// A bucket in memory, so that the signed-URL route has bytes to serve.
const fakeR2 = (): R2Like => {
  const data = new Map<string, { bytes: Uint8Array; type?: string }>();
  const meta = (k: string) => ({ etag: `e-${k}`, size: data.get(k)!.bytes.length, httpMetadata: { contentType: data.get(k)!.type } });
  return {
    async put(key, value, options) { data.set(key, { bytes: value, type: options?.httpMetadata?.contentType }); return { etag: `e-${key}` }; },
    async get(key) { return data.has(key) ? { ...meta(key), arrayBuffer: async () => data.get(key)!.bytes.slice().buffer as ArrayBuffer } : null; },
    async head(key) { return data.has(key) ? meta(key) : null; },
    async delete(key) { data.delete(key); },
  };
};
const call = (app: Fetcher, path: string, init: RequestInit = {}, env: object = {}) =>
  app.fetch(new Request(`http://x/api/v1/drive${path}`, init), env as never);
const as = (user: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as object), "x-user": user } });

describe("createApp with injected parts", () => {
  it("serves from the injected store and blobs, with no bindings and no URL settings", async () => {
    const app = createApp({ store: createMemoryStore(), blobs: createMemoryBlobs(), auth });
    const put = await call(app, "/files?path=/a.txt", as("ann", { method: "PUT", body: "hello" }));
    expect(put.status).toBe(201);
    const list = await call(app, "/items", as("ann"));
    expect(((await list.json()) as { name: string }[]).map((n) => n.name)).toEqual(["a.txt"]);
    const read = await call(app, "/files?path=/a.txt", as("ann"));
    expect(await read.text()).toBe("hello");
  });
  it("asks the auth callback and answers 401 when it returns null", async () => {
    const app = createApp({ store: createMemoryStore(), blobs: createMemoryBlobs(), auth });
    expect((await call(app, "/items")).status).toBe(401);
    // A bearer token does not count when the host owns sign-in.
    expect((await call(app, "/items", { headers: { authorization: "Bearer abc" } })).status).toBe(401);
  });
  it("keeps the principals the callback names apart", async () => {
    const app = createApp({ store: createMemoryStore(), blobs: createMemoryBlobs(), auth });
    await call(app, "/files?path=/mine.txt", as("ann", { method: "PUT", body: "x" }));
    expect(await (await call(app, "/items", as("bob"))).json()).toEqual([]);
    expect((await call(app, "/stat?path=/mine.txt", as("bob"))).status).toBe(404);
  });
  it("lets the callback and the parts read the Worker env on each request", async () => {
    const store = createMemoryStore();
    const blobs = createMemoryBlobs();
    const seen: unknown[] = [];
    const app = createApp<{ TENANT: string }>({
      store: (env) => (seen.push(env.TENANT), store), blobs: () => blobs,
      auth: (request, _store, env) => (env.TENANT === "t1" ? auth(request) : null),
    });
    expect((await call(app, "/items", as("ann"), { TENANT: "t1" })).status).toBe(200);
    expect((await call(app, "/items", as("ann"), { TENANT: "t2" })).status).toBe(401);
    expect(seen).toContain("t1");
  });
  it("passes the injected store to the callback", async () => {
    const store = createMemoryStore();
    let got: unknown;
    const app = createApp({ store, blobs: createMemoryBlobs(), auth: (_r, s) => ((got = s), null) });
    await call(app, "/items");
    expect(got).toBe(store);
  });
  it("serves a signed download through injected blobs with only the secret set", async () => {
    const blobs = createR2Blobs(fakeR2(), { region: "unknown", urlBase: "http://host/api/v1/drive/blob", urlSecret: SECRET });
    const app = createApp({ store: createMemoryStore(), blobs, auth });
    await call(app, "/files?path=/a.txt&mime=text/plain", as("ann", { method: "PUT", body: "hello" }));
    const { url } = (await (await call(app, "/url?path=/a.txt", as("ann"))).json()) as { url: string };
    const env = { DRIVE_URL_SECRET: SECRET };
    const res = await app.fetch(new Request(url), env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const forged = new URL(url);
    forged.searchParams.set("sig", "0".repeat(64));
    expect((await app.fetch(new Request(forged), env as never)).status).toBe(403);
    // No secret, no verification.
    expect((await app.fetch(new Request(url), {} as never)).status).toBe(503);
  });
  it("does not touch the store for a forged download link", async () => {
    let built = 0;
    const app = createApp({ store: () => (built++, createMemoryStore()), blobs: createMemoryBlobs(), auth });
    const res = await app.fetch(new Request("http://x/api/v1/drive/blob?key=k&sig=00"), { DRIVE_URL_SECRET: SECRET } as never);
    expect(res.status).toBe(403);
    expect(built).toBe(0);
  });
  it("refuses a caller that is not whole: no principal, or an owner or actor that does not match it", async () => {
    const p = principal("ann");
    const bad: (Ctx | null | object)[] = [
      { owner: "ann", actor: { id: "ann", kind: "human" } },
      { owner: "bob", actor: { id: "ann", kind: "human" }, principal: p },
      { owner: "ann", actor: { id: "bob", kind: "human" }, principal: p },
      { owner: "ann", actor: { id: "ann", kind: "agent" }, principal: p },
      {},
    ];
    for (const ctx of bad) {
      const app = createApp({ store: createMemoryStore(), blobs: createMemoryBlobs(), auth: () => ctx as Ctx });
      expect((await call(app, "/items")).status, JSON.stringify(ctx)).toBe(401);
    }
  });
  it("serves a shared link to a visitor, and asks the callback for a signed-in one", async () => {
    const app = createApp({ store: createMemoryStore(), blobs: createMemoryBlobs(), auth });
    const made = await (await call(app, "/files?path=/s.txt", as("ann", { method: "PUT", body: "shared" }))).json() as { id: string };
    const link = await (await call(app, "/links", as("ann", { method: "POST", body: JSON.stringify({ path: "/s.txt", role: "viewer" }), headers: { "content-type": "application/json" } }))).json() as { token: string };
    const visit = (headers: Record<string, string>) => call(app, `/shared/${made.id}/content`, { headers: { "x-link-token": link.token, ...headers } });
    expect(await (await visit({})).text()).toBe("shared");
    expect(await (await visit({ "x-user": "bob" })).text()).toBe("shared");
    // A header the callback ignores is no sign-in, and a request that sends one gets 401.
    expect((await visit({ authorization: "Bearer abc" })).status).toBe(401);
    expect((await call(app, `/shared/${made.id}/content`)).status).toBe(404);
  });
  it("still answers 503 by default when the bindings or URL settings are missing", async () => {
    const app = createApp();
    const res = await call(app, "/items", as("ann"), {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_CONFIGURED");
  });
  it("needs the URL settings for default blobs even when the store is injected", async () => {
    const app = createApp({ store: createMemoryStore(), auth });
    const res = await call(app, "/items", as("ann"), { FILES: {} });
    expect(res.status).toBe(503);
  });
});

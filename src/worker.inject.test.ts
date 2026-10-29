// The Worker app with an injected store, blobs, and auth. No D1 or R2 binding exists here.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore, type PrincipalContext } from "agentic-identity";
import type { Ctx } from "./drive.js";
import { createApp } from "./worker.js";

const principal = (id: string, scopes = ["drive:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
// The host's own sign-in: the header names the person. Anything else is no caller.
const auth = (request: Request): Ctx | null => {
  const who = request.headers.get("x-user");
  return who ? ctxOf(principal(who)) : null;
};
const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}, env: object = {}) =>
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

import { Hono, type Context } from "hono";
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { createSharing, parseRegion, type Blobs, type Role, type Store } from "agentic-identity";
import { createDrive, DEFAULT_URL_SECONDS, DriveError, safeMime, type ActorKind, type Ctx, type Drive, type ErrorCode, type OnConflict, type SearchQuery } from "./drive.js";
import { authenticate } from "./auth.js";
import { buildExport } from "./export.js";
import { publicNode } from "./local.js";
import { DEFAULT_MAX_BYTES, upload } from "./upload.js";

export { authenticate };
export { backfillAuthorIds, backfillResources, type BackfillOptions, type BackfillResult } from "./migrate.js";

export interface WorkerEnv {
  DB: D1Like;
  FILES: R2Like;
  DRIVE_MAX_BYTES?: string;
  /** The origin of this Worker, such as `https://drive.example.com`. Signed download URLs start with it. */
  DRIVE_PUBLIC_URL?: string;
  /** At least 32 bytes. Signs download URLs. Without it, every request gets 503. */
  DRIVE_URL_SECRET?: string;
  DRIVE_REGION?: string;
}

/**
 * What a host injects into `createApp`. Each part is optional, and the default is the D1 store, the R2 blobs,
 * and the bearer-token check of agentic-identity. A part may be a function of the Worker env, which runs on every request.
 */
export interface AppOptions<Env = WorkerEnv> {
  /** The store that holds items, shares, and credentials. With it, no `DB` binding is read and the table is not created. */
  store?: Store | ((env: Env) => Store | Promise<Store>);
  /** The blob store. With it, no `FILES` binding is read. It signs download URLs, so it must serve them from this Worker's `/api/v1/drive/blob`. */
  blobs?: Blobs | ((env: Env) => Blobs | Promise<Blobs>);
  /**
   * Resolves the caller. Return null for no valid caller (the answer is 401). Return a whole Ctx: a `principal`, and an
   * `owner` and `actor` that match it, or the request gets 401. With it, bearer tokens are not read from the store.
   * A callback that reads a session cookie must check the request origin itself, because every write route is open to a cross-site form.
   */
  auth?: (request: Request, store: Store, env: Env) => Ctx | null | Promise<Ctx | null>;
}

type App = { Bindings: WorkerEnv; Variables: { drive: Drive; store: Store; ctx: Ctx } };

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 413 | 500> = {
  CROSS_DRIVE: 409, INVALID_SHARE: 400, TOO_MANY_ITEMS: 409,
  TOO_DEEP: 400, INVALID_EXPIRY: 400, BUSY: 409, BLOB_EXISTS: 500,
  NOT_FOUND: 404, NAME_TAKEN: 409, INVALID_NAME: 400, INVALID_PATH: 400, INVALID_REF: 400, NOT_A_FOLDER: 400, NOT_A_FILE: 400,
  MOVE_INTO_SELF: 409, PARENT_GONE: 409, TRASHED: 409, NOT_TRASHED: 409, IS_ROOT: 400, FORBIDDEN: 403, BLOB_MISSING: 500, TOO_LARGE: 413,
};

const fail = (code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 503) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });

/** The database is ready once its table exists. The check runs once per binding. */
const schemas = new WeakMap<object, Promise<unknown>>();

function settings(env: WorkerEnv, needUrl = true): { publicUrl: string; urlSecret: string } | null {
  let publicUrl = "";
  try {
    publicUrl = new URL(env.DRIVE_PUBLIC_URL ?? "").origin;
  } catch {
    if (needUrl) return null;
  }
  const urlSecret = env.DRIVE_URL_SECRET;
  return typeof urlSecret === "string" && new TextEncoder().encode(urlSecret).length >= 32 ? { publicUrl, urlSecret } : null;
}

/** The region both adapters declare. It is "eu" unless DRIVE_REGION says otherwise ("unknown" is for local runs, where D1 does not report a region). */
const regionOf = (env: WorkerEnv) => parseRegion(env.DRIVE_REGION ?? "eu");

/** The R2 bucket is declared as "eu": create it with `--jurisdiction eu`. */
function blobsFor(env: WorkerEnv, config: NonNullable<ReturnType<typeof settings>>) {
  return createR2Blobs(env.FILES, { region: regionOf(env), urlBase: `${config.publicUrl}/api/v1/drive/blob`, urlSecret: config.urlSecret });
}

async function defaultStore(env: WorkerEnv): Promise<Store> {
  let ready = schemas.get(env.DB);
  if (!ready) {
    ready = env.DB.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(env.DB);
      throw error;
    });
    schemas.set(env.DB, ready);
  }
  await ready;
  return createD1Store(env.DB, { region: regionOf(env) });
}

const number = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new DriveError("INVALID_PATH", `${name} needs a number of 0 or more`);
  return n;
};

/** Clients such as `curl -T` send a generic form type. That is no claim about the bytes. */
const claimedType = (header: string | undefined) =>
  header === undefined || /^(application\/x-www-form-urlencoded|application\/octet-stream|multipart\/form-data)\b/i.test(header) ? undefined : header;

export function createApp<Env extends object = WorkerEnv>(options: AppOptions<Env> = {}): Hono<{ Bindings: Env; Variables: App["Variables"] }> {
  const injected = options as AppOptions<WorkerEnv>;
  const unset = (message: string) => fail("NOT_CONFIGURED", message, 503);
  const urlSettings = "set DRIVE_PUBLIC_URL and DRIVE_URL_SECRET (32 bytes or more)";
  /** The signing secret. Only the blobs that this Worker builds also need the public URL. */
  const secretOf = (env: WorkerEnv) => (injected.blobs ? settings(env, false) : settings(env))?.urlSecret;
  /** The blobs of one request, or a Response when the Worker is not configured. */
  const blobsOf = async (env: WorkerEnv): Promise<Blobs | Response> => {
    if (injected.blobs) return typeof injected.blobs === "function" ? injected.blobs(env) : injected.blobs;
    const config = settings(env);
    if (!env.FILES) return unset("bind FILES (R2), or inject blobs");
    return config ? blobsFor(env, config) : unset(urlSettings);
  };
  /** Resolves the parts of one request. The error is a Response when the Worker is not configured. */
  const resolve = async (env: WorkerEnv): Promise<{ stop: Response } | { drive: Drive; store: Store }> => {
    if (!injected.store && !env.DB) return { stop: unset("bind DB (D1), or inject a store") };
    const blobs = await blobsOf(env);
    if (blobs instanceof Response) return { stop: blobs };
    const store = injected.store ? await (typeof injected.store === "function" ? injected.store(env) : injected.store) : await defaultStore(env);
    return { store, drive: createDrive({ store, blobs, sharing: createSharing(store) }) };
  };
  /** An injected callback must name a whole caller: a principal, and an owner and actor that match it. Anything else is no caller. */
  const who = async (request: Request, store: Store, env: WorkerEnv): Promise<Ctx | null> => {
    if (!injected.auth) return authenticate(request, store);
    const ctx = await injected.auth(request, store, env);
    const p = ctx?.principal;
    return ctx && p && ctx.owner === p.chain[0]?.id && ctx.actor?.id === p.principalId && ctx.actor.kind === p.kind ? ctx : null;
  };
  const unauthorized = () => fail("UNAUTHORIZED", injected.auth ? "sign in first" : "send a valid bearer token", 401);
  const app = new Hono<App>();
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    const r = await resolve(c.env);
    if ("stop" in r) return r.stop;
    const { drive, store } = r;
    const ctx = await who(c.req.raw, store, c.env);
    if (!ctx) return unauthorized();
    c.set("ctx", ctx);
    c.set("drive", drive);
    c.set("store", store);
    await next();
  });
  const q = (c: { req: { query(k: string): string | undefined } }, k: string) => c.req.query(k);
  const need = (value: string | undefined, name: string) => {
    if (value === undefined) throw new DriveError("INVALID_PATH", `${name} is required`);
    return value;
  };
  const body = async (c: { req: { json(): Promise<unknown> } }) => {
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      throw new DriveError("INVALID_PATH", "body must be JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DriveError("INVALID_PATH", "body must be a JSON object");
    return parsed as Record<string, unknown>;
  };
  const str = (v: unknown, name: string) => {
    if (typeof v !== "string") throw new DriveError("INVALID_PATH", `${name} must be a string`);
    return v;
  };
  const opt = (v: unknown, name: string) => (v === undefined ? undefined : str(v, name));

  api.get("/items", async (c) => c.json((await c.var.drive.list(c.var.ctx, q(c, "path") ?? "/")).map((n) => publicNode(n))));
  api.get("/stat", async (c) => c.json(publicNode(await c.var.drive.stat(c.var.ctx, need(q(c, "path"), "path")))));
  api.post("/folders", async (c) => {
    const b = await body(c);
    return c.json(publicNode(await c.var.drive.mkdir(c.var.ctx, str(b.path, "path"), { parents: b.parents === true })), 201);
  });

  api.put("/files", async (c) => {
    const max = number(c.env.DRIVE_MAX_BYTES, "DRIVE_MAX_BYTES") ?? DEFAULT_MAX_BYTES;
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > max) return fail("TOO_LARGE", `upload is over the limit of ${max} bytes`, 413);
    const stream = c.req.raw.body ?? new Blob([]).stream();
    const node = await upload(c.var.drive, c.var.ctx, need(q(c, "path"), "path"), stream, {
      maxBytes: max, mime: q(c, "mime") ?? claimedType(c.req.header("content-type")), parents: q(c, "parents") === "true",
      onConflict: q(c, "onConflict") as OnConflict | undefined,
    });
    return c.json(publicNode(node), 201);
  });
  api.get("/files", async (c) => {
    const { node, data } = await c.var.drive.read(c.var.ctx, need(q(c, "path"), "path"));
    return new Response(data as BodyInit, {
      headers: {
        "content-type": node.mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`,
        "x-content-type-options": "nosniff",
        "x-content-sha256": node.hash ?? "",
      },
    });
  });
  api.get("/url", async (c) => {
    const expires = number(q(c, "expires"), "expires") ?? DEFAULT_URL_SECONDS;
    return c.json({ url: await c.var.drive.downloadUrl(c.var.ctx, need(q(c, "path"), "path"), expires), expiresInSeconds: expires });
  });

  api.post("/move", async (c) => {
    const b = await body(c);
    return c.json(publicNode(await c.var.drive.move(c.var.ctx, str(b.src, "src"), str(b.folder, "folder"), { name: opt(b.name, "name"), onConflict: opt(b.onConflict, "onConflict") as OnConflict | undefined })));
  });
  api.post("/trash", async (c) => c.json(publicNode(await c.var.drive.trash(c.var.ctx, str((await body(c)).path, "path")))));
  api.get("/trash", async (c) => c.json((await c.var.drive.listTrash(c.var.ctx)).map((n) => publicNode(n))));
  api.post("/restore", async (c) => {
    const b = await body(c);
    return c.json(publicNode(await c.var.drive.restore(c.var.ctx, str(b.id, "id"), { parentId: opt(b.parentId, "parentId"), onConflict: opt(b.onConflict, "onConflict") as OnConflict | undefined })));
  });
  api.post("/purge", async (c) => c.json(await c.var.drive.purge(c.var.ctx, str((await body(c)).id, "id"))));

  api.get("/search", async (c) => {
    const query: SearchQuery = {
      name: q(c, "name"), mime: q(c, "mime"), kind: q(c, "kind") as SearchQuery["kind"], minSize: number(q(c, "minSize"), "minSize"),
      maxSize: number(q(c, "maxSize"), "maxSize"), createdByKind: q(c, "createdByKind") as ActorKind | undefined, app: q(c, "app"), limit: number(q(c, "limit"), "limit"),
    };
    return c.json((await c.var.drive.search(c.var.ctx, query)).map((r) => publicNode(r.node, r.path)));
  });
  api.get("/export", async (c) =>
    new Response((await buildExport(c.var.drive, c.var.ctx)) as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="drive-export.zip"' } }));
  api.delete("/account", async (c) => {
    if (q(c, "confirm") !== "yes") throw new DriveError("INVALID_PATH", "add ?confirm=yes to erase you for good: your drive, and what you shared or held");
    return c.json(await c.var.drive.erasePerson(c.var.ctx));
  });
  api.get("/home", async (c) => {
    const home = await c.var.drive.home(c.var.ctx, { app: q(c, "app"), limit: number(q(c, "limit"), "limit") });
    return c.json({ apps: home.apps, files: home.files, items: home.items.map((i) => ({ ...publicNode(i.node, i.path), app: i.app })) });
  });
  api.post("/documents", async (c) => {
    const b = await body(c);
    return c.json(publicNode(await c.var.drive.registerDocument(c.var.ctx, { ref: str(b.ref, "ref"), name: str(b.name, "name"), folder: opt(b.folder, "folder") })), 201);
  });
  api.delete("/documents", async (c) => c.json(await c.var.drive.forgetDocument(c.var.ctx, need(q(c, "ref"), "ref"))));

  // The signature is the credential here, so this route sits outside the bearer-token check.
  app.get("/api/v1/drive/blob", async (c) => {
    const secret = secretOf(c.env);
    if (!secret) return unset(urlSettings);
    const signed = await verifySignedBlobUrl(c.req.url, { secret });
    if (!signed || signed.method !== "GET") return fail("INVALID_LINK", "this link is not valid, or it has expired", 403);
    const blobs = await blobsOf(c.env);
    if (blobs instanceof Response) return blobs;
    const blob = await blobs.get(signed.key);
    if (!blob) return fail("NOT_FOUND", "the bytes are gone", 404);
    return new Response(blob.data as BodyInit, {
      headers: {
        "content-type": safeMime(signed.responseContentType ?? blob.contentType),
        "content-disposition": signed.responseContentDisposition ?? "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });
  // Sharing. Identity decides who may share. A caller below owner gets 403, and one who cannot read the item gets 404.
  const roleOf = (v: unknown) => v as Role;
  const lifetime = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number") throw new DriveError("INVALID_SHARE", `${name} must be a number of milliseconds`);
    return v;
  };
  api.get("/shares", async (c) => c.json(await c.var.drive.shares(c.var.ctx, need(q(c, "path"), "path"))));
  api.post("/shares", async (c) => {
    const b = await body(c);
    await c.var.drive.shareWith(c.var.ctx, str(b.path, "path"), { kind: b.subjectKind as never, id: str(b.subjectId, "subjectId") }, roleOf(b.role));
    return c.json({ ok: true });
  });
  api.delete("/shares", async (c) => {
    await c.var.drive.unshare(c.var.ctx, need(q(c, "path"), "path"), { kind: q(c, "subjectKind") as never, id: need(q(c, "subjectId"), "subjectId") });
    return c.json({ ok: true });
  });
  api.post("/invites", async (c) => {
    const b = await body(c);
    const expiresInMs = lifetime(b.expiresInMs, "expiresInMs");
    const invite = await c.var.drive.invite(c.var.ctx, str(b.path, "path"), {
      role: roleOf(b.role), ...(b.email === undefined ? {} : { email: str(b.email, "email") }), ...(b.handle === undefined ? {} : { handle: str(b.handle, "handle") }),
      ...(expiresInMs === undefined ? {} : { expiresInMs }),
    });
    return c.json(invite, 201);
  });
  // The email comes from a verified sign-in and the handle from the agent's own record, never from the request.
  api.post("/invites/accept", async (c) => {
    const id = str((await body(c)).id, "id");
    const user = await c.var.store.get("users", c.var.ctx.actor.id);
    const agent = await c.var.store.get("principals", c.var.ctx.actor.id);
    await c.var.drive.acceptInvite(c.var.ctx, id, {
      ...(user?.emailVerified === true && typeof user.email === "string" ? { email: user.email } : {}),
      ...(typeof agent?.handle === "string" ? { handle: agent.handle } : {}),
    });
    return c.json({ ok: true });
  });
  api.post("/links", async (c) => {
    const b = await body(c);
    const expiresInMs = lifetime(b.expiresInMs, "expiresInMs");
    const link = await c.var.drive.createLink(c.var.ctx, str(b.path, "path"), {
      role: roleOf(b.role), signedInOnly: b.signedInOnly === true, ...(expiresInMs === undefined ? {} : { expiresAt: Date.now() + expiresInMs }),
    });
    return c.json(link, 201);
  });
  api.delete("/links", async (c) => {
    await c.var.drive.revokeLink(c.var.ctx, need(q(c, "id"), "id"));
    return c.json({ ok: true });
  });
  // Registered before the bearer-token check of `api`, so it does not run for these routes.
  // A visitor reads by id with a link token in `x-link-token`. A bearer token, if sent, must be valid.
  const shared = new Hono<App>();
  const visit = async (c: Context<App>) => {
    const r = await resolve(c.env);
    if ("stop" in r) return r;
    const { drive, store } = r;
    const ctx = await who(c.req.raw, store, c.env);
    if (!ctx && c.req.header("authorization")) return { stop: unauthorized() };
    return { drive, principal: ctx?.principal ?? null, token: c.req.header("x-link-token") };
  };
  shared.get("/:id", async (c) => {
    const v = await visit(c);
    return "stop" in v ? v.stop : c.json(publicNode(await v.drive.openShared(v.principal, c.req.param("id"), v.token)));
  });
  shared.get("/:id/items", async (c) => {
    const v = await visit(c);
    return "stop" in v ? v.stop : c.json((await v.drive.listShared(v.principal, c.req.param("id"), v.token)).map((n) => publicNode(n)));
  });
  shared.get("/:id/content", async (c) => {
    const v = await visit(c);
    if ("stop" in v) return v.stop;
    const { node, data } = await v.drive.readShared(v.principal, c.req.param("id"), v.token);
    return new Response(data as BodyInit, {
      headers: {
        "content-type": safeMime(node.mime), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`,
        "x-content-type-options": "nosniff", "cache-control": "private, no-store",
      },
    });
  });
  app.route("/api/v1/drive/shared", shared);
  app.route("/api/v1/drive", api);


  app.notFound(() => fail("NOT_FOUND", "no such route", 404));
  app.onError((error) => {
    if (error instanceof DriveError) return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), { status: STATUS[error.code], headers: { "content-type": "application/json" } });
    console.error("internal error", error instanceof Error ? error.name : "unknown");
    return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "the server could not finish the request" } }), { status: 500, headers: { "content-type": "application/json" } });
  });
  return app as never;
}

const app = createApp();
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };

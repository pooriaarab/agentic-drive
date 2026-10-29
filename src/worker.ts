import { Hono, type Context } from "hono";
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { createSharing, createStoreAuth, parseRegion, type Role, type Store } from "agentic-identity";
import { createDrive, DEFAULT_URL_SECONDS, DriveError, safeMime, type ActorKind, type Ctx, type Drive, type ErrorCode, type OnConflict, type SearchQuery } from "./drive.js";
import { buildExport } from "./export.js";
import { publicNode } from "./local.js";
import { DEFAULT_MAX_BYTES, upload } from "./upload.js";

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

type App = { Bindings: WorkerEnv; Variables: { drive: Drive; store: Store; ctx: Ctx } };

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 413 | 500> = {
  CROSS_DRIVE: 409, INVALID_SHARE: 400, TOO_MANY_ITEMS: 409,
  TOO_DEEP: 400, INVALID_EXPIRY: 400, BUSY: 409, BLOB_EXISTS: 500,
  NOT_FOUND: 404, NAME_TAKEN: 409, INVALID_NAME: 400, INVALID_PATH: 400, INVALID_REF: 400, NOT_A_FOLDER: 400, NOT_A_FILE: 400,
  MOVE_INTO_SELF: 409, PARENT_GONE: 409, TRASHED: 409, NOT_TRASHED: 409, IS_ROOT: 400, FORBIDDEN: 403, BLOB_MISSING: 500, TOO_LARGE: 413,
};

const fail = (code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 503) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });

/**
 * The caller behind a bearer token, resolved by the store-backed Auth of agentic-identity: the credential
 * names a principal, and the whole delegation chain must be live. Only a bearer token counts. A session
 * cookie is refused, because no check of the request origin stands behind it here. Any problem gives null.
 */
export async function authenticate(request: Request, store: Store, now?: () => number): Promise<Ctx | null> {
  if (!/^Bearer [A-Za-z0-9_-]{1,512}$/.test(request.headers.get("authorization") ?? "")) return null;
  const principal = await createStoreAuth(store, now ? { now } : {}).authenticate(request);
  return principal ? { owner: principal.chain[0]!.id, actor: { id: principal.principalId, kind: principal.kind as ActorKind }, principal } : null;
}

/** The database is ready once its table exists. The check runs once per binding. */
const schemas = new WeakMap<object, Promise<unknown>>();

function settings(env: WorkerEnv): { publicUrl: string; urlSecret: string } | null {
  let publicUrl: string;
  try {
    publicUrl = new URL(env.DRIVE_PUBLIC_URL ?? "").origin;
  } catch {
    return null;
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

async function driveFor(env: WorkerEnv, config: NonNullable<ReturnType<typeof settings>>): Promise<{ drive: Drive; store: Store }> {
  let ready = schemas.get(env.DB);
  if (!ready) {
    ready = env.DB.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(env.DB);
      throw error;
    });
    schemas.set(env.DB, ready);
  }
  await ready;
  const store = createD1Store(env.DB, { region: regionOf(env) });
  return { store, drive: createDrive({ store, blobs: blobsFor(env, config), sharing: createSharing(store) }) };
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

export function createApp(): Hono<App> {
  const app = new Hono<App>();
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    const config = settings(c.env);
    if (!config) return fail("NOT_CONFIGURED", "set DRIVE_PUBLIC_URL and DRIVE_URL_SECRET (32 bytes or more)", 503);
    const { drive, store } = await driveFor(c.env, config);
    const ctx = await authenticate(c.req.raw, store);
    if (!ctx) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
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
    const config = settings(c.env);
    if (!config) return fail("NOT_CONFIGURED", "set DRIVE_PUBLIC_URL and DRIVE_URL_SECRET (32 bytes or more)", 503);
    const signed = await verifySignedBlobUrl(c.req.url, { secret: config.urlSecret });
    if (!signed || signed.method !== "GET") return fail("INVALID_LINK", "this link is not valid, or it has expired", 403);
    const blob = await blobsFor(c.env, config).get(signed.key);
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
    await c.var.drive.shareWith(c.var.ctx, str(b.path, "path"), str(b.subjectId, "subjectId"), roleOf(b.role));
    return c.json({ ok: true });
  });
  api.delete("/shares", async (c) => {
    await c.var.drive.unshare(c.var.ctx, need(q(c, "path"), "path"), need(q(c, "subjectId"), "subjectId"));
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
    const config = settings(c.env);
    if (!config) return { stop: fail("NOT_CONFIGURED", "set DRIVE_PUBLIC_URL and DRIVE_URL_SECRET (32 bytes or more)", 503) };
    const { drive, store } = await driveFor(c.env, config);
    const ctx = await authenticate(c.req.raw, store);
    if (!ctx && c.req.header("authorization")) return { stop: fail("UNAUTHORIZED", "send a valid bearer token", 401) };
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
  return app;
}

const app = createApp();
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };

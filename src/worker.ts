import { Hono } from "hono";
import { D1_SCHEMA, createD1Store, createR2Blobs, verifySignedBlobUrl, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { ACTOR_KINDS, createDrive, DEFAULT_URL_SECONDS, DriveError, safeMime, type ActorKind, type Ctx, type Drive, type ErrorCode, type OnConflict, type SearchQuery } from "./drive.js";
import { buildExport } from "./export.js";
import { publicNode } from "./local.js";
import { DEFAULT_MAX_BYTES, upload } from "./upload.js";

export interface WorkerEnv {
  DB: D1Like;
  FILES: R2Like;
  /**
   * JSON: `{ "<token>": { "owner": "u1", "actor": "u1", "kind": "human" } }`. A token is at least 32 characters.
   * Every grant needs an owner, an actor id, and an actor kind. A token with a missing or bad part gets 401.
   * Without the secret, every request fails with 401.
   */
  DRIVE_API_TOKENS?: string;
  DRIVE_MAX_BYTES?: string;
  /** The origin of this Worker, such as `https://drive.example.com`. Signed download URLs start with it. */
  DRIVE_PUBLIC_URL?: string;
  /** At least 32 bytes. Signs download URLs. Without it, every request gets 503. */
  DRIVE_URL_SECRET?: string;
}

const MIN_TOKEN_LENGTH = 32;
type App = { Bindings: WorkerEnv; Variables: { drive: Drive; ctx: Ctx } };

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 413 | 500> = {
  TOO_DEEP: 400, INVALID_EXPIRY: 400, BUSY: 409,
  NOT_FOUND: 404, NAME_TAKEN: 409, INVALID_NAME: 400, INVALID_PATH: 400, INVALID_REF: 400, NOT_A_FOLDER: 400, NOT_A_FILE: 400,
  MOVE_INTO_SELF: 409, PARENT_GONE: 409, TRASHED: 409, NOT_TRASHED: 409, IS_ROOT: 400, FORBIDDEN: 403, BLOB_MISSING: 500, TOO_LARGE: 413,
};

const fail = (code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 503) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The principal a grant names, or null when any part is missing or malformed. */
function principalOf(grant: unknown): Ctx | null {
  if (typeof grant !== "object" || grant === null) return null;
  const { owner, actor, kind } = grant as Record<string, unknown>;
  if (!isText(owner) || !isText(actor) || !(ACTOR_KINDS as readonly unknown[]).includes(kind)) return null;
  return { owner, actor: { id: actor, kind: kind as ActorKind } };
}

/** The seam for sign-in. A later release swaps this for agentic-identity. */
export function authenticate(request: Request, env: WorkerEnv): Ctx | null {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !env.DRIVE_API_TOKENS) return null;
  let grants: Record<string, unknown>;
  try {
    grants = JSON.parse(env.DRIVE_API_TOKENS) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof grants !== "object" || grants === null) return null;
  let found: unknown;
  for (const [candidate, grant] of Object.entries(grants)) {
    if (sameText(candidate, token) && candidate.length >= MIN_TOKEN_LENGTH) found = grant;
  }
  return principalOf(found);
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

/** The R2 bucket is declared as "eu": create it with `--jurisdiction eu`. */
function blobsFor(env: WorkerEnv, config: NonNullable<ReturnType<typeof settings>>) {
  return createR2Blobs(env.FILES, { region: "eu", urlBase: `${config.publicUrl}/api/v1/drive/blob`, urlSecret: config.urlSecret });
}

async function driveFor(env: WorkerEnv, config: NonNullable<ReturnType<typeof settings>>): Promise<Drive> {
  let ready = schemas.get(env.DB);
  if (!ready) {
    ready = env.DB.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(env.DB);
      throw error;
    });
    schemas.set(env.DB, ready);
  }
  await ready;
  return createDrive({ store: createD1Store(env.DB, { region: "eu" }), blobs: blobsFor(env, config) });
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
    const ctx = authenticate(c.req.raw, c.env);
    if (!ctx) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
    c.set("ctx", ctx);
    c.set("drive", await driveFor(c.env, config));
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
      maxSize: number(q(c, "maxSize"), "maxSize"), createdByKind: q(c, "createdByKind") as ActorKind | undefined, limit: number(q(c, "limit"), "limit"),
    };
    return c.json((await c.var.drive.search(c.var.ctx, query)).map((r) => publicNode(r.node, r.path)));
  });
  api.get("/export", async (c) =>
    new Response((await buildExport(c.var.drive, c.var.ctx)) as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="drive-export.zip"' } }));
  api.delete("/account", async (c) => {
    if (q(c, "confirm") !== "yes") throw new DriveError("INVALID_PATH", "add ?confirm=yes to delete everything you own for good");
    return c.json(await c.var.drive.deleteAll(c.var.ctx));
  });

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
        "content-type": safeMime(blob.contentType),
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });
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

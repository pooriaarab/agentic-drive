import { Hono } from "hono";
import { createD1Store, type D1Like } from "./adapters/d1.js";
import { createR2Blobs, type R2BucketLike } from "./adapters/r2.js";
import { createDrive, DriveError, type ActorKind, type Ctx, type Drive, type ErrorCode, type OnConflict, type SearchQuery } from "./drive.js";
import { buildExport } from "./export.js";
import { publicNode } from "./local.js";
import { DEFAULT_MAX_BYTES, upload } from "./upload.js";

export interface WorkerEnv {
  DB: D1Like;
  FILES: R2BucketLike;
  /** JSON: `{ "<token>": { "owner": "u1", "actor": "u1", "kind": "human" } }`. Without it, every request fails with 401. */
  DRIVE_API_TOKENS?: string;
  DRIVE_MAX_BYTES?: string;
  /** All four are needed for signed URLs. */
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

type Grant = { owner: string; actor?: string; kind?: ActorKind };
type App = { Bindings: WorkerEnv; Variables: { drive: Drive; ctx: Ctx } };

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 413 | 500> = {
  NOT_FOUND: 404, NAME_TAKEN: 409, INVALID_NAME: 400, INVALID_PATH: 400, INVALID_REF: 400, NOT_A_FOLDER: 400, NOT_A_FILE: 400,
  MOVE_INTO_SELF: 409, PARENT_GONE: 409, TRASHED: 409, NOT_TRASHED: 409, IS_ROOT: 400, FORBIDDEN: 403, BLOB_MISSING: 500, TOO_LARGE: 413,
};

const fail = (code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 501) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The seam for sign-in. A later release swaps this for agentic-identity. */
export function authenticate(request: Request, env: WorkerEnv): Ctx | null {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !env.DRIVE_API_TOKENS) return null;
  let grants: Record<string, Grant>;
  try {
    grants = JSON.parse(env.DRIVE_API_TOKENS) as Record<string, Grant>;
  } catch {
    return null;
  }
  let found: Grant | undefined;
  for (const [candidate, grant] of Object.entries(grants)) if (sameText(candidate, token)) found = grant;
  if (!found?.owner) return null;
  return { owner: found.owner, actor: { id: found.actor ?? found.owner, kind: found.kind ?? "human" } };
}

const stores = new WeakMap<object, ReturnType<typeof createD1Store>>();

function driveFor(env: WorkerEnv): Drive {
  let store = stores.get(env.DB);
  if (!store) stores.set(env.DB, (store = createD1Store(env.DB)));
  const signing = env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
    ? { accountId: env.R2_ACCOUNT_ID, bucketName: env.R2_BUCKET_NAME, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, jurisdiction: "eu" as const }
    : undefined;
  return createDrive({ store, blobs: createR2Blobs({ bucket: env.FILES, signing }) });
}

const number = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new DriveError("INVALID_PATH", `${name} needs a number of 0 or more`);
  return n;
};

export function createApp(): Hono<App> {
  const app = new Hono<App>();
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    const ctx = authenticate(c.req.raw, c.env);
    if (!ctx) return fail("UNAUTHORIZED", "send a valid bearer token", 401);
    c.set("ctx", ctx);
    c.set("drive", driveFor(c.env));
    await next();
  });
  const q = (c: { req: { query(k: string): string | undefined } }, k: string) => c.req.query(k);
  const need = (value: string | undefined, name: string) => {
    if (value === undefined) throw new DriveError("INVALID_PATH", `${name} is required`);
    return value;
  };
  const body = async (c: { req: { json(): Promise<unknown> } }) => {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new DriveError("INVALID_PATH", "body must be JSON");
    }
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
      maxBytes: max, mime: q(c, "mime") ?? c.req.header("content-type") ?? undefined, parents: q(c, "parents") === "true",
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
    if (!c.env.R2_ACCESS_KEY_ID) return fail("SIGNING_NOT_CONFIGURED", "signed URLs need R2 signing keys", 501);
    const expires = number(q(c, "expires"), "expires") ?? 300;
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

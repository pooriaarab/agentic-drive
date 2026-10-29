// A typed client for the HTTP API of the Worker. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.
import type { ActorKind, ErrorCode, Node, SearchQuery } from "./drive.js";

export type Role = "viewer" | "commenter" | "editor" | "owner";
export type OnConflict = "fail" | "rename" | "replace";
export type SubjectKind = "human" | "agent";
export type Subject = { kind: SubjectKind; id: string };

/** An item as the API prints it: no storage keys. */
/** `machineMade` is true when an agent principal created the item. */
export type Item = Omit<Node, "nameKey" | "blobKey" | "purging"> & { machineMade: boolean };
/** A search hit, or a home item: an item with its path. */
export type PathItem = Item & { path: string };

/** The codes of the drive, and the ones that only the Worker raises. */
export type ApiErrorCode = ErrorCode | "UNAUTHORIZED" | "NOT_CONFIGURED" | "INVALID_LINK" | "INTERNAL";
/** `NETWORK_ERROR` means no answer came (status 0). `BAD_RESPONSE` means an answer that is not the API's. */
export type ClientErrorCode = ApiErrorCode | "NETWORK_ERROR" | "BAD_RESPONSE";

/** The error of every failed call. `code` is the code of the API, and `status` is the HTTP status. */
export class DriveApiError extends Error {
  constructor(readonly code: ClientErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "DriveApiError";
  }
}

export interface ClientOptions {
  /** The origin of the Worker, such as `https://drive.example.com`. */
  baseUrl: string;
  /** A bearer token. It is optional only for the link routes, `openShared`, `listShared`, and `readShared`. */
  token?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** How often a read (GET) call tries again after a network error or a 502, 503, or 504. The default is 0. A write is never tried again. */
  retries?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export type UploadBody = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface Downloaded {
  data: Uint8Array;
  contentType: string;
  sha256: string;
}

const BASE = "/api/v1/drive";
const CODES: Record<ApiErrorCode, true> = {
  NOT_FOUND: true, NAME_TAKEN: true, BLOB_EXISTS: true, INVALID_NAME: true, INVALID_PATH: true, INVALID_REF: true, NOT_A_FOLDER: true, NOT_A_FILE: true, MOVE_INTO_SELF: true, TOO_DEEP: true,
  PARENT_GONE: true, TRASHED: true, NOT_TRASHED: true, IS_ROOT: true, FORBIDDEN: true, BLOB_MISSING: true, TOO_LARGE: true, INVALID_EXPIRY: true, BUSY: true, CROSS_DRIVE: true, INVALID_SHARE: true,
  TOO_MANY_ITEMS: true, UNAUTHORIZED: true, NOT_CONFIGURED: true, INVALID_LINK: true, INTERNAL: true,
};
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(CODES));

type Check<T> = (value: unknown) => value is T;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string";
const orNull = (test: (v: unknown) => boolean) => (v: unknown) => v === null || test(v);
const num = (v: unknown) => typeof v === "number";
// The client imports no value, so it cannot use PRINCIPAL_KINDS. This record fails to compile when a kind is added or removed.
const ACTOR_KINDS: Record<ActorKind, true> = { human: true, agent_of_human: true, agent_of_agent: true, agent: true, user_token: true };
const ROLES = ["viewer", "commenter", "editor", "owner"];
const oneOf = (list: string[]) => (v: unknown) => typeof v === "string" && list.includes(v);
const actor = (v: unknown) => record(v) && text(v.id) && oneOf(Object.keys(ACTOR_KINDS))(v.kind);
const isItem: Check<Item> = (v): v is Item =>
  record(v) && text(v.id) && text(v.owner) && text(v.parentId) && text(v.name) && (v.kind === "folder" || v.kind === "file" || v.kind === "ref") && num(v.size) && orNull(text)(v.mime) && orNull(text)(v.hash) &&
  orNull(text)(v.ref) && num(v.createdAt) && num(v.updatedAt) && actor(v.createdBy) && actor(v.updatedBy) && text(v.createdById) && text(v.updatedById) && typeof v.trashed === "boolean" && orNull(num)(v.trashedAt);
const isPathItem: Check<PathItem> = (v): v is PathItem => isItem(v) && typeof (v as { path?: unknown }).path === "string";
const listOf = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => Array.isArray(v) && v.every(check);
const shape = <T>(test: (v: Record<string, unknown>) => boolean): Check<T> => (v): v is T => record(v) && test(v);
const numbers = (...keys: string[]) => shape<Record<string, number>>((v) => keys.every((k) => typeof v[k] === "number"));
const isOk = shape<{ ok: true }>((v) => v.ok === true);
const RETRY_STATUS = new Set([502, 503, 504]);

export function createClient(options: ClientOptions) {
  let origin: string;
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http");
    origin = url.origin;
  } catch {
    throw new TypeError("baseUrl must be an http or https URL");
  }
  const { token } = options;
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(token))) throw new TypeError("token must be 1 to 512 letters, digits, - or _");
  const retries = options.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new RangeError("retries must be an integer from 0 to 5");
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const query = (params: Record<string, string | number | boolean | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text === "" ? "" : `?${text}`;
  };

  /** Sends one request. A failure becomes a `DriveApiError`, except an abort, which stays the abort of `fetch`. */
  async function send(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal; auth?: boolean }): Promise<Response> {
    if (init.auth !== false && token === undefined) throw new TypeError("this call needs a token");
    const headers: Record<string, string> = { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...init.headers };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const attempts = method === "GET" ? retries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        // A stream body needs `duplex`. Browsers that cannot stream a request fail here, so send bytes there.
        response = await doFetch(`${origin}${BASE}${path}`, { method, headers, body, signal: init.signal, redirect: "manual", ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
      } catch (error) {
        if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        if (attempt < attempts) {
          await pause(attempt, init.signal);
          continue;
        }
        const refused = body instanceof ReadableStream ? " (a stream body may be refused by this runtime: send bytes)" : "";
        throw new DriveApiError("NETWORK_ERROR", 0, `${error instanceof Error ? `no answer: ${error.message}` : "no answer"}${refused}`);
      }
      if (attempt < attempts && RETRY_STATUS.has(response.status)) {
        await response.body?.cancel();
        await pause(attempt, init.signal);
        continue;
      }
      // The API never redirects. A browser shows a redirect as an opaque response, and Node and Workers as a 3xx.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw new DriveApiError("BAD_RESPONSE", response.status, "the server redirected. Set baseUrl to the final URL.");
      }
      if (response.ok) return response;
      throw await errorOf(response, init.signal);
    }
  }

  /** A short wait before a read is sent again. An abort ends it. */
  async function pause(attempt: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", stop);
        resolve();
      }, Math.min(100 * 2 ** (attempt - 1), 1000));
      const stop = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  async function errorOf(response: Response, signal?: AbortSignal): Promise<DriveApiError> {
    let code: ClientErrorCode = "BAD_RESPONSE";
    let message = `the server answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string" && KNOWN_CODES.has(parsed.error.code)) code = parsed.error.code as ClientErrorCode;
      else if (typeof parsed.error?.code === "string") message = `the server answered ${response.status} with an unknown code, ${JSON.stringify(parsed.error.code.slice(0, 40))}`;
      if (code !== "BAD_RESPONSE" && typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch (error) {
      // An abort stays an abort. Any other body is not the JSON error of the API: keep the status.
      if (signal?.aborted) throw error;
    }
    return new DriveApiError(code, response.status, message);
  }

  /** Reads the body. A drop in the middle is a network error, and a body of another shape is a bad response. */
  async function json<T>(method: string, path: string, init: Parameters<typeof send>[2], check: Check<T>): Promise<T> {
    const response = await send(method, path, init);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (!(error instanceof SyntaxError)) throw new DriveApiError("NETWORK_ERROR", 0, "the connection dropped while the body came in");
      throw new DriveApiError("BAD_RESPONSE", response.status, "the answer is not JSON");
    }
    if (!check(value)) throw new DriveApiError("BAD_RESPONSE", response.status, "the answer is not the shape that the API sends");
    return value;
  }

  /** The bytes. With `verify`, they must match the hash that the server sends. */
  async function bytes(path: string, init: Parameters<typeof send>[2], verify = false): Promise<Downloaded> {
    const response = await send("GET", path, init);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new DriveApiError("NETWORK_ERROR", 0, "the connection dropped while the body came in");
    }
    const sha256 = response.headers.get("x-content-sha256") ?? "";
    if (verify) {
      // The Worker sends the hash of every stored file. An answer without it is not the API's.
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DriveApiError("BAD_RESPONSE", response.status, "the answer has no valid x-content-sha256");
      if (typeof crypto === "undefined" || !crypto.subtle) throw new DriveApiError("BAD_RESPONSE", response.status, "this runtime has no WebCrypto, so the bytes cannot be checked. Use https.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
      if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== sha256) throw new DriveApiError("BAD_RESPONSE", response.status, "the bytes do not match their hash");
    }
    return { data, contentType: response.headers.get("content-type") ?? "application/octet-stream", sha256 };
  }

  const link = (token: string | undefined) => {
    if (token === undefined) return undefined;
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) throw new TypeError("a link token has 1 to 512 letters, digits, - or _");
    return { "x-link-token": token };
  };
  /** An id that is a path segment. A dot segment would climb out of `/shared`, and a slash would start a path. */
  const id = (value: string) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value) || value === "." || value === "..") throw new TypeError("an item id has letters, digits, -, _ and . (not first), and is not . or ..");
    return value;
  };

  const isUrl = shape<{ url: string; expiresInSeconds: number }>((v) => typeof v.url === "string" && /^https?:\/\//.test(v.url) && URL.canParse(v.url) && typeof v.expiresInSeconds === "number");
  const isShares = shape<{ grants: { subjectKind: SubjectKind; subjectId: string; role: Role }[]; links: { id: string; role: Role; signedInOnly: boolean; expiresAt: number | null; revoked: boolean }[]; invites: { id: string; role: Role; email: string | null; handle: string | null; expiresAt: number | null; accepted: boolean }[] }>(
    (v) =>
      listOf(shape((g) => (g.subjectKind === "human" || g.subjectKind === "agent") && text(g.subjectId) && oneOf(ROLES)(g.role)))(v.grants) &&
      listOf(shape((l) => text(l.id) && oneOf(ROLES)(l.role) && typeof l.signedInOnly === "boolean" && orNull(num)(l.expiresAt) && typeof l.revoked === "boolean"))(v.links) &&
      listOf(shape((i) => text(i.id) && oneOf(ROLES)(i.role) && orNull(text)(i.email) && orNull(text)(i.handle) && orNull(num)(i.expiresAt) && typeof i.accepted === "boolean"))(v.invites));
  const isHome = shape<{ apps: Record<string, number>; files: number; items: (PathItem & { app: string | null })[] }>((v) => record(v.apps) && Object.values(v.apps).every(num) && num(v.files) && listOf(shape((i) => isPathItem(i) && orNull(text)((i as Record<string, unknown>).app)))(v.items));
  const isId = shape<{ id: string }>((v) => typeof v.id === "string");
  const isLink = shape<{ id: string; token: string }>((v) => typeof v.id === "string" && typeof v.token === "string");

  return {
    /** The live items of a folder. */
    list: (path = "/", o: CallOptions = {}) => json("GET", `/items${query({ path })}`, o, listOf(isItem)),
    stat: (path: string, o: CallOptions = {}) => json("GET", `/stat${query({ path })}`, o, isItem),
    mkdir: (path: string, opts: { parents?: boolean } = {}, o: CallOptions = {}) => json("POST", "/folders", { json: { path, parents: opts.parents === true }, ...o }, isItem),
    /** Writes a file. A `ReadableStream` body streams in runtimes that allow it. */
    upload: (path: string, body: UploadBody, opts: { mime?: string; parents?: boolean; onConflict?: OnConflict } = {}, o: CallOptions = {}) =>
      json("PUT", `/files${query({ path, mime: opts.mime, parents: opts.parents === true ? true : undefined, onConflict: opts.onConflict })}`, {
        body: (typeof body === "string" ? new TextEncoder().encode(body) : body) as BodyInit, headers: { "content-type": "application/octet-stream" }, ...o,
      }, isItem),
    /** The bytes. They are checked against the hash that the server sends. */
    download: (path: string, o: CallOptions = {}) => bytes(`/files${query({ path })}`, o, true),
    /** A signed link that works without a token, for `expires` seconds. You fetch the link yourself. */
    url: (path: string, expires?: number, o: CallOptions = {}) => json("GET", `/url${query({ path, expires })}`, o, isUrl),
    move: (src: string, folder: string, opts: { name?: string; onConflict?: OnConflict } = {}, o: CallOptions = {}) => json("POST", "/move", { json: { src, folder, ...opts }, ...o }, isItem),
    trash: (path: string, o: CallOptions = {}) => json("POST", "/trash", { json: { path }, ...o }, isItem),
    listTrash: (o: CallOptions = {}) => json("GET", "/trash", o, listOf(isItem)),
    restore: (itemId: string, opts: { parentId?: string; onConflict?: OnConflict } = {}, o: CallOptions = {}) => json("POST", "/restore", { json: { id: itemId, ...opts }, ...o }, isItem),
    /** Deletes a trashed item for good. */
    purge: (itemId: string, o: CallOptions = {}) => json("POST", "/purge", { json: { id: itemId }, ...o }, numbers("removed")) as Promise<{ removed: number }>,
    search: (q: Pick<SearchQuery, "name" | "mime" | "kind" | "minSize" | "maxSize" | "createdByKind" | "app" | "limit"> = {}, o: CallOptions = {}) => json("GET", `/search${query(q)}`, o, listOf(isPathItem)),
    /** Everything the caller has, as a zip. */
    export: async (o: CallOptions = {}) => {
      const { data } = await bytes("/export", o);
      // A zip starts with "PK". Anything else is not the export, such as a page from a proxy.
      if (data[0] !== 0x50 || data[1] !== 0x4b) throw new DriveApiError("BAD_RESPONSE", 200, "the answer is not a zip");
      return data;
    },
    /** Erases the caller for good. The client sends `confirm=yes`. */
    deleteAccount: (o: CallOptions = {}) => json("DELETE", "/account?confirm=yes", o, numbers("removed", "grants", "invites", "anonymized")) as Promise<{ removed: number; grants: number; invites: number; anonymized: number }>,
    home: (q: { app?: string; limit?: number } = {}, o: CallOptions = {}) => json("GET", `/home${query(q)}`, o, isHome),
    registerDocument: (input: { ref: string; name: string; folder?: string }, o: CallOptions = {}) => json("POST", "/documents", { json: input, ...o }, isItem),
    forgetDocument: (ref: string, o: CallOptions = {}) => json("DELETE", `/documents${query({ ref })}`, o, numbers("trashed")) as Promise<{ trashed: number }>,

    shares: (path: string, o: CallOptions = {}) => json("GET", `/shares${query({ path })}`, o, isShares),
    share: (path: string, subject: Subject, role: Role, o: CallOptions = {}) => json("POST", "/shares", { json: { path, subjectId: subject.id, subjectKind: subject.kind, role }, ...o }, isOk),
    unshare: (path: string, subject: Subject, o: CallOptions = {}) => json("DELETE", `/shares${query({ path, subjectId: subject.id, subjectKind: subject.kind })}`, o, isOk),
    /** Invite by `email` (a person) or `handle` (an agent). It sends no message. */
    invite: (path: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }, o: CallOptions = {}) => json("POST", "/invites", { json: { path, ...input }, ...o }, isId),
    acceptInvite: (inviteId: string, o: CallOptions = {}) => json("POST", "/invites/accept", { json: { id: inviteId }, ...o }, isOk),
    /** The token of a link comes back once. */
    createLink: (path: string, input: { role: Role; expiresInMs?: number; signedInOnly?: boolean }, o: CallOptions = {}) => json("POST", "/links", { json: { path, ...input }, ...o }, isLink),
    revokeLink: (linkId: string, o: CallOptions = {}) => json("DELETE", `/links${query({ id: linkId })}`, o, isOk),

    /** The next three read a shared item by id. Pass a link token, a bearer token, or both. */
    openShared: async (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json("GET", `/shared/${id(itemId)}`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }, isItem),
    listShared: async (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json("GET", `/shared/${id(itemId)}/items`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }, listOf(isItem)),
    readShared: async (itemId: string, opts: { linkToken?: string } & CallOptions = {}): Promise<Omit<Downloaded, "sha256">> => {
      const { data, contentType } = await bytes(`/shared/${id(itemId)}/content`, { auth: false, headers: link(opts.linkToken), signal: opts.signal });
      return { data, contentType };
    },
  };
}

export type DriveClient = ReturnType<typeof createClient>;

// A typed client for the HTTP API of the Worker. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.
import type { ErrorCode, Node, SearchQuery } from "./drive.js";

export type Role = "viewer" | "commenter" | "editor" | "owner";
export type OnConflict = "fail" | "rename" | "replace";
export type SubjectKind = "human" | "agent";
export type Subject = { kind: SubjectKind; id: string };

/** An item as the API prints it: no storage keys. */
export type Item = Omit<Node, "nameKey" | "blobKey" | "purging">;
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
const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  "NOT_FOUND", "NAME_TAKEN", "BLOB_EXISTS", "INVALID_NAME", "INVALID_PATH", "INVALID_REF", "NOT_A_FOLDER", "NOT_A_FILE", "MOVE_INTO_SELF", "TOO_DEEP", "PARENT_GONE", "TRASHED", "NOT_TRASHED",
  "IS_ROOT", "FORBIDDEN", "BLOB_MISSING", "TOO_LARGE", "INVALID_EXPIRY", "BUSY", "CROSS_DRIVE", "INVALID_SHARE", "TOO_MANY_ITEMS", "UNAUTHORIZED", "NOT_CONFIGURED", "INVALID_LINK", "INTERNAL",
]);

type Check<T> = (value: unknown) => value is T;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isItem: Check<Item> = (v): v is Item => record(v) && typeof v.id === "string" && typeof v.name === "string" && (v.kind === "folder" || v.kind === "file" || v.kind === "ref") && typeof v.size === "number" && typeof v.trashed === "boolean";
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
        response = await doFetch(`${origin}${BASE}${path}`, { method, headers, body, signal: init.signal, redirect: "error", ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
      } catch (error) {
        if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        if (attempt < attempts) {
          await pause(attempt, init.signal);
          continue;
        }
        throw new DriveApiError("NETWORK_ERROR", 0, error instanceof Error ? `no answer: ${error.message}` : "no answer");
      }
      if (attempt < attempts && RETRY_STATUS.has(response.status)) {
        await response.body?.cancel();
        await pause(attempt, init.signal);
        continue;
      }
      if (response.ok) return response;
      throw await errorOf(response);
    }
  }

  /** A short wait before a read is sent again. An abort ends it. */
  async function pause(attempt: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1000)));
    signal?.throwIfAborted();
  }

  async function errorOf(response: Response): Promise<DriveApiError> {
    let code: ClientErrorCode = "BAD_RESPONSE";
    let message = `the server answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string" && KNOWN_CODES.has(parsed.error.code)) code = parsed.error.code as ClientErrorCode;
      else if (typeof parsed.error?.code === "string") message = `the server answered ${response.status} with an unknown code, ${JSON.stringify(parsed.error.code.slice(0, 40))}`;
      if (code !== "BAD_RESPONSE" && typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // The body is not the JSON error of the API. Keep the status.
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
      throw new DriveApiError("BAD_RESPONSE", response.status, "the answer is not JSON");
    }
    if (!check(value)) throw new DriveApiError("BAD_RESPONSE", response.status, "the answer is not the shape that the API sends");
    return value;
  }

  /** The bytes, checked against the hash that the server sends. */
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
    if (verify && sha256 !== "") {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
      if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== sha256) throw new DriveApiError("BAD_RESPONSE", response.status, "the bytes do not match their hash");
    }
    return { data, contentType: response.headers.get("content-type") ?? "application/octet-stream", sha256 };
  }

  const link = (token: string | undefined) => (token === undefined ? undefined : { "x-link-token": token });
  const id = (value: string) => encodeURIComponent(value);

  const isUrl = shape<{ url: string; expiresInSeconds: number }>((v) => typeof v.url === "string" && typeof v.expiresInSeconds === "number");
  const isShares = shape<{ grants: { subjectKind: SubjectKind; subjectId: string; role: Role }[]; links: { id: string; role: Role; signedInOnly: boolean; expiresAt: number | null; revoked: boolean }[]; invites: { id: string; role: Role; email: string | null; handle: string | null; expiresAt: number | null; accepted: boolean }[] }>(
    (v) => Array.isArray(v.grants) && Array.isArray(v.links) && Array.isArray(v.invites));
  const isHome = shape<{ apps: Record<string, number>; files: number; items: (PathItem & { app: string | null })[] }>((v) => record(v.apps) && typeof v.files === "number" && listOf(isPathItem)(v.items));
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
    export: (o: CallOptions = {}) => bytes("/export", o).then((r) => r.data),
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
    openShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json("GET", `/shared/${id(itemId)}`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }, isItem),
    listShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json("GET", `/shared/${id(itemId)}/items`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }, listOf(isItem)),
    readShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => bytes(`/shared/${id(itemId)}/content`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }),
  };
}

export type DriveClient = ReturnType<typeof createClient>;

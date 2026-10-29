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
        response = await doFetch(`${origin}${BASE}${path}`, { method, headers, body, signal: init.signal, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
      } catch (error) {
        if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        if (attempt < attempts) continue;
        throw new DriveApiError("NETWORK_ERROR", 0, error instanceof Error ? `no answer: ${error.message}` : "no answer");
      }
      if (attempt < attempts && RETRY_STATUS.has(response.status)) {
        await response.body?.cancel();
        continue;
      }
      if (response.ok) return response;
      throw await errorOf(response);
    }
  }

  async function errorOf(response: Response): Promise<DriveApiError> {
    let code: ClientErrorCode = "BAD_RESPONSE";
    let message = `the server answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string") code = parsed.error.code as ClientErrorCode;
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // The body is not the JSON error of the API. Keep the status.
    }
    return new DriveApiError(code, response.status, message);
  }

  async function json<T>(method: string, path: string, init: Parameters<typeof send>[2] = {}): Promise<T> {
    const response = await send(method, path, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new DriveApiError("BAD_RESPONSE", response.status, "the answer is not JSON");
    }
  }

  async function bytes(path: string, init: Parameters<typeof send>[2]): Promise<Downloaded> {
    const response = await send("GET", path, init);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      sha256: response.headers.get("x-content-sha256") ?? "",
    };
  }

  const link = (token: string | undefined) => (token === undefined ? undefined : { "x-link-token": token });
  const id = (value: string) => encodeURIComponent(value);

  return {
    /** The live items of a folder. */
    list: (path = "/", o: CallOptions = {}) => json<Item[]>("GET", `/items${query({ path })}`, o),
    stat: (path: string, o: CallOptions = {}) => json<Item>("GET", `/stat${query({ path })}`, o),
    mkdir: (path: string, opts: { parents?: boolean } = {}, o: CallOptions = {}) => json<Item>("POST", "/folders", { json: { path, parents: opts.parents === true }, ...o }),
    /** Writes a file. A `ReadableStream` body streams in runtimes that allow it. */
    upload: (path: string, body: UploadBody, opts: { mime?: string; parents?: boolean; onConflict?: OnConflict } = {}, o: CallOptions = {}) =>
      json<Item>("PUT", `/files${query({ path, mime: opts.mime, parents: opts.parents === true ? true : undefined, onConflict: opts.onConflict })}`, {
        body: (typeof body === "string" ? new TextEncoder().encode(body) : body) as BodyInit, headers: { "content-type": "application/octet-stream" }, ...o,
      }),
    download: (path: string, o: CallOptions = {}) => bytes(`/files${query({ path })}`, o),
    /** A signed link that works without a token, for `expires` seconds. */
    url: (path: string, expires?: number, o: CallOptions = {}) => json<{ url: string; expiresInSeconds: number }>("GET", `/url${query({ path, expires })}`, o),
    move: (src: string, folder: string, opts: { name?: string; onConflict?: OnConflict } = {}, o: CallOptions = {}) => json<Item>("POST", "/move", { json: { src, folder, ...opts }, ...o }),
    trash: (path: string, o: CallOptions = {}) => json<Item>("POST", "/trash", { json: { path }, ...o }),
    listTrash: (o: CallOptions = {}) => json<Item[]>("GET", "/trash", o),
    restore: (itemId: string, opts: { parentId?: string; onConflict?: OnConflict } = {}, o: CallOptions = {}) => json<Item>("POST", "/restore", { json: { id: itemId, ...opts }, ...o }),
    /** Deletes a trashed item for good. */
    purge: (itemId: string, o: CallOptions = {}) => json<{ removed: number }>("POST", "/purge", { json: { id: itemId }, ...o }),
    search: (q: Pick<SearchQuery, "name" | "mime" | "kind" | "minSize" | "maxSize" | "createdByKind" | "app" | "limit"> = {}, o: CallOptions = {}) => json<PathItem[]>("GET", `/search${query(q)}`, o),
    /** Everything the caller has, as a zip. */
    export: (o: CallOptions = {}) => bytes("/export", o).then((r) => r.data),
    /** Erases the caller for good. It needs `confirm`: the client sends `confirm=yes`. */
    deleteAccount: (o: CallOptions = {}) => json<{ removed: number; grants: number; invites: number; anonymized: number }>("DELETE", "/account?confirm=yes", o),
    home: (q: { app?: string; limit?: number } = {}, o: CallOptions = {}) =>
      json<{ apps: Record<string, number>; files: number; items: (PathItem & { app: string | null })[] }>("GET", `/home${query(q)}`, o),
    registerDocument: (input: { ref: string; name: string; folder?: string }, o: CallOptions = {}) => json<Item>("POST", "/documents", { json: input, ...o }),
    forgetDocument: (ref: string, o: CallOptions = {}) => json<{ trashed: number }>("DELETE", `/documents${query({ ref })}`, o),

    shares: (path: string, o: CallOptions = {}) =>
      json<{ grants: { subjectKind: SubjectKind; subjectId: string; role: Role }[]; links: { id: string; role: Role; signedInOnly: boolean; expiresAt: number | null; revoked: boolean }[]; invites: { id: string; role: Role; email: string | null; handle: string | null; expiresAt: number | null; accepted: boolean }[] }>(
        "GET", `/shares${query({ path })}`, o),
    share: (path: string, subject: Subject, role: Role, o: CallOptions = {}) => json<{ ok: true }>("POST", "/shares", { json: { path, subjectId: subject.id, subjectKind: subject.kind, role }, ...o }),
    unshare: (path: string, subject: Subject, o: CallOptions = {}) => json<{ ok: true }>("DELETE", `/shares${query({ path, subjectId: subject.id, subjectKind: subject.kind })}`, o),
    /** Invite by `email` (a person) or `handle` (an agent). It sends no message. */
    invite: (path: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }, o: CallOptions = {}) => json<{ id: string }>("POST", "/invites", { json: { path, ...input }, ...o }),
    acceptInvite: (inviteId: string, o: CallOptions = {}) => json<{ ok: true }>("POST", "/invites/accept", { json: { id: inviteId }, ...o }),
    /** The token of a link comes back once. */
    createLink: (path: string, input: { role: Role; expiresInMs?: number; signedInOnly?: boolean }, o: CallOptions = {}) => json<{ id: string; token: string }>("POST", "/links", { json: { path, ...input }, ...o }),
    revokeLink: (linkId: string, o: CallOptions = {}) => json<{ ok: true }>("DELETE", `/links${query({ id: linkId })}`, o),

    /** The next three read a shared item by id. Pass a link token, a bearer token, or both. */
    openShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json<Item>("GET", `/shared/${id(itemId)}`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }),
    listShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => json<Item[]>("GET", `/shared/${id(itemId)}/items`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }),
    readShared: (itemId: string, opts: { linkToken?: string } & CallOptions = {}) => bytes(`/shared/${id(itemId)}/content`, { auth: false, headers: link(opts.linkToken), signal: opts.signal }),
  };
}

export type DriveClient = ReturnType<typeof createClient>;

import type { AdapterOptions, BlobObject, Blobs, Doc, Json, Page, Query, Store, StoreOps } from "../ports.js";

export type Tables = Record<string, Record<string, Doc>>;

export interface MemoryStoreOptions extends AdapterOptions {
  /** Starting data. */
  snapshot?: Tables;
  /** Called with the full data after each committed write. */
  onCommit?: (tables: Tables) => void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

function ops(tables: Tables): StoreOps {
  return {
    async get<T extends Doc>(collection: string, id: string) {
      const doc = tables[collection]?.[id];
      return doc ? clone(doc) as T : null;
    },
    async put(collection, id, doc) {
      (tables[collection] ??= {})[id] = clone(doc);
    },
    async delete(collection, id) {
      delete tables[collection]?.[id];
    },
    async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
      const limit = query.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const sign = query.orderBy?.direction === "desc" ? -1 : 1;
      const field = query.orderBy?.field;
      const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
      let rows = Object.entries(tables[collection] ?? {})
        .filter(([, doc]) => Object.entries(query.where ?? {}).every(([k, v]) => doc[k] === v))
        .map(([id, doc]) => ({ id, doc, v: (field === undefined ? id : doc[field]) as Json }))
        .filter((row) => row.v !== undefined && row.v !== null)
        .sort(order);
      if (query.cursor !== undefined) {
        let after: { v: Json; id: string };
        try {
          const [v, id] = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as [Json, string];
          if (typeof id !== "string") throw new Error();
          after = { v, id };
        } catch {
          throw new Error("invalid cursor");
        }
        rows = rows.filter((row) => order(row, after) > 0);
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({ id: row.id, data: clone(row.doc) as T })),
        ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url") } : {}),
      };
    },
  };
}

export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  let tables: Tables = clone(options.snapshot ?? {});
  let lock: Promise<unknown> = Promise.resolve();
  // One operation at a time, so a transaction sees no other writer.
  const exclusive = <R>(fn: () => Promise<R>, write: boolean): Promise<R> => {
    const run = lock.then(fn, fn).then((result) => {
      if (write) options.onCommit?.(tables);
      return result;
    });
    lock = run.catch(() => undefined);
    return run;
  };
  const base = ops(tables);
  return {
    region: options.region ?? "eu",
    get: (c, id) => exclusive(() => base.get(c, id), false),
    put: (c, id, doc) => exclusive(() => base.put(c, id, doc), true),
    delete: (c, id) => exclusive(() => base.delete(c, id), true),
    query: (c, q) => exclusive(() => base.query(c, q), false),
    transaction: (fn) =>
      exclusive(async () => {
        const draft = clone(tables);
        const result = await fn(ops(draft));
        // Copy in place so `base` keeps pointing at the live tables.
        for (const key of Object.keys(tables)) delete tables[key];
        Object.assign(tables, draft);
        return result;
      }, true),
  };
}

export function createMemoryBlobs(options: AdapterOptions = {}): Blobs {
  const objects = new Map<string, BlobObject>();
  const now = options.now ?? Date.now;
  return {
    region: options.region ?? "eu",
    async put(key, data, opts) {
      objects.set(key, { data: data.slice(), ...(opts?.contentType ? { contentType: opts.contentType } : {}) });
    },
    async get(key) {
      const found = objects.get(key);
      return found ? { ...found, data: found.data.slice() } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async signedUrl(key, { method, expiresInSeconds, responseContentDisposition, responseContentType }) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      const extra = [
        responseContentDisposition && `&disposition=${encodeURIComponent(responseContentDisposition)}`,
        responseContentType && `&type=${encodeURIComponent(responseContentType)}`,
      ].filter(Boolean).join("");
      return `memory://blobs/${encodeURIComponent(key)}?method=${method}&expires=${now() + expiresInSeconds * 1000}${extra}`;
    },
  };
}

import type { AdapterOptions, Doc, Json, Page, Query, Scalar, Store, StoreOps } from "../ports.js";

/** The part of a D1 database that this adapter uses. */
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

const FIELD = /^[A-Za-z0-9_]+$/;
const sqlValue = (v: Scalar) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
const encode = (value: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
const decode = (cursor: string) => JSON.parse(decodeURIComponent(escape(atob(cursor)))) as [Json, string];

/**
 * A Store on one D1 table. A transaction collects its writes and sends them in one atomic batch.
 * It does not stop two Workers from racing on the same item. One isolate runs one transaction at a time.
 * Create the database in an EU location with `wrangler d1 create --location weur`.
 */
export function createD1Store(db: D1Like, options: AdapterOptions = {}): Store {
  let ready: Promise<unknown> | undefined;
  const init = () => (ready ??= db.batch([db.prepare("CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))")]));
  const putSql = (c: string, id: string, doc: Doc) => db.prepare("INSERT OR REPLACE INTO docs (collection, id, data) VALUES (?, ?, ?)").bind(c, id, JSON.stringify(doc));
  const delSql = (c: string, id: string) => db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").bind(c, id);

  async function read(c: string, id: string): Promise<Doc | null> {
    await init();
    const row = await db.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?").bind(c, id).first<{ data: string }>();
    return row ? (JSON.parse(row.data) as Doc) : null;
  }

  async function find<T extends Doc>(c: string, q: Query): Promise<Page<T>> {
    await init();
    const limit = q.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
    const field = q.orderBy?.field;
    if (field !== undefined && !FIELD.test(field)) throw new Error(`invalid field "${field}"`);
    const dir = q.orderBy?.direction === "desc" ? "DESC" : "ASC";
    const key = field === undefined ? "id" : `json_extract(data, '$.${field}')`;
    const where = ["collection = ?"];
    const args: unknown[] = [c];
    for (const [name, value] of Object.entries(q.where ?? {})) {
      if (!FIELD.test(name)) throw new Error(`invalid field "${name}"`);
      where.push(value === null ? `json_extract(data, '$.${name}') IS NULL` : `json_extract(data, '$.${name}') = ?`);
      if (value !== null) args.push(sqlValue(value));
    }
    if (field !== undefined) where.push(`${key} IS NOT NULL`);
    if (q.cursor !== undefined) {
      let after: [Json, string];
      try {
        after = decode(q.cursor);
        if (typeof after[1] !== "string") throw new Error();
      } catch {
        throw new Error("invalid cursor");
      }
      const op = dir === "ASC" ? ">" : "<";
      where.push(`(${key} ${op} ? OR (${key} = ? AND id ${op} ?))`);
      args.push(sqlValue(after[0] as Scalar), sqlValue(after[0] as Scalar), after[1]);
    }
    const { results } = await db
      .prepare(`SELECT id, data, ${key} AS sortkey FROM docs WHERE ${where.join(" AND ")} ORDER BY ${key} ${dir}, id ${dir} LIMIT ?`)
      .bind(...args, limit + 1)
      .all<{ id: string; data: string; sortkey: Json }>();
    const page = results.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, data: JSON.parse(r.data) as T })),
      ...(results.length > limit && last ? { nextCursor: encode([last.sortkey, last.id]) } : {}),
    };
  }

  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  const direct: StoreOps = {
    get: async <T extends Doc>(c: string, id: string) => (await read(c, id)) as T | null,
    put: async (c, id, doc) => {
      await init();
      await putSql(c, id, doc).first();
    },
    delete: async (c, id) => {
      await init();
      await delSql(c, id).first();
    },
    query: find,
  };

  return {
    region: options.region ?? "eu",
    get: (c, id) => exclusive(() => direct.get(c, id)),
    put: (c, id, doc) => exclusive(() => direct.put(c, id, doc)),
    delete: (c, id) => exclusive(() => direct.delete(c, id)),
    query: (c, q) => exclusive(() => direct.query(c, q)),
    transaction: (fn) =>
      exclusive(async () => {
        const pending = new Map<string, { c: string; id: string; doc: Doc | null }>();
        const tx: StoreOps = {
          async get<T extends Doc>(c: string, id: string) {
            const hit = pending.get(`${c}/${id}`);
            return (hit ? hit.doc : await read(c, id)) as T | null;
          },
          async put(c, id, doc) {
            pending.set(`${c}/${id}`, { c, id, doc: JSON.parse(JSON.stringify(doc)) as Doc });
          },
          async delete(c, id) {
            pending.set(`${c}/${id}`, { c, id, doc: null });
          },
          async query<T extends Doc>(c: string, q: Query = {}) {
            if (pending.size > 0 && (q.orderBy || q.cursor)) throw new Error("ordered queries after a write in a transaction are not supported");
            const page = await find<T>(c, q);
            const mine = [...pending.values()].filter((p) => p.c === c);
            const match = (doc: Doc) => Object.entries(q.where ?? {}).every(([k, v]) => doc[k] === v);
            const items = page.items.filter((i) => !mine.some((p) => p.id === i.id));
            for (const p of mine) if (p.doc && match(p.doc)) items.push({ id: p.id, data: p.doc as T });
            return { items: items.sort((a, b) => (a.id < b.id ? -1 : 1)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
          },
        };
        const result = await fn(tx);
        if (pending.size > 0) await db.batch([...pending.values()].map((p) => (p.doc ? putSql(p.c, p.id, p.doc) : delSql(p.c, p.id))));
        return result;
      }),
  };
}

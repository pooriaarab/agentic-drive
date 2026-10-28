import { StoreConflictError, type AdapterOptions, type Doc, type Json, type Page, type Query, type Scalar, type Store, type StoreOps } from "../ports.js";

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

/** A unique rule on live rows of one collection. D1 enforces it with a partial unique index. */
export interface UniqueIndex {
  name: string;
  collection: string;
  fields: string[];
  /** Only rows whose fields equal these values count. Use it to leave out trashed rows. */
  where?: Record<string, Scalar>;
}

export interface D1Options extends AdapterOptions {
  unique?: UniqueIndex[];
}

/** How often a transaction runs again after another writer changed what it read. */
const ATTEMPTS = 4;
const FIELD = /^[A-Za-z0-9_]+$/;
const sqlValue = (v: Scalar) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
const encode = (value: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
const decode = (cursor: string) => JSON.parse(decodeURIComponent(escape(atob(cursor)))) as [Json, string];

const literal = (v: Scalar) => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v === null ? "NULL" : String(sqlValue(v)));
function uniqueSql(rule: UniqueIndex): string {
  for (const part of [rule.name, rule.collection, ...rule.fields, ...Object.keys(rule.where ?? {})]) {
    if (!FIELD.test(part)) throw new Error(`invalid name "${part}" in a unique rule`);
  }
  const keys = rule.fields.map((f) => `json_extract(data, '$.${f}')`).join(", ");
  const where = [`collection = ${literal(rule.collection)}`, ...Object.entries(rule.where ?? {}).map(([k, v]) => `json_extract(data, '$.${k}') = ${literal(v)}`)];
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${rule.name} ON docs (${keys}) WHERE ${where.join(" AND ")}`;
}

/**
 * A Store on one D1 table. Many Workers can share it.
 *
 * A transaction reads freely, then sends its writes in one atomic batch. The batch also starts with a
 * check for every document the transaction read: if one changed, the whole batch fails and the
 * transaction runs again on fresh data. After a few tries it throws `StoreConflictError`.
 * `unique` rules become unique indexes, so two Workers cannot both create the same name.
 * Create the database in an EU location with `wrangler d1 create --location weur`.
 */
export function createD1Store(db: D1Like, options: D1Options = {}): Store {
  let ready: Promise<unknown> | undefined;
  const init = () =>
    (ready ??= db
      .batch([
        db.prepare("CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))"),
        db.prepare("CREATE TABLE IF NOT EXISTS docs_guard (ok INTEGER NOT NULL)"),
        ...(options.unique ?? []).map((rule) => db.prepare(uniqueSql(rule))),
      ])
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      }));
  const conflict = (error: unknown) => error instanceof Error && /UNIQUE constraint failed|docs_guard/i.test(error.message);
  // An upsert, never INSERT OR REPLACE: that would delete the other row that holds a unique name.
  const putSql = (c: string, id: string, doc: Doc) => db.prepare("INSERT INTO docs (collection, id, data) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data").bind(c, id, JSON.stringify(doc));
  const delSql = (c: string, id: string) => db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").bind(c, id);

  async function readText(c: string, id: string): Promise<string | null> {
    await init();
    const row = await db.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?").bind(c, id).first<{ data: string }>();
    return row ? row.data : null;
  }
  async function read(c: string, id: string): Promise<Doc | null> {
    const text = await readText(c, id);
    return text === null ? null : (JSON.parse(text) as Doc);
  }

  async function find<T extends Doc>(c: string, q: Query, seen?: (id: string, text: string) => void): Promise<Page<T>> {
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
    for (const r of page) seen?.(r.id, r.data);
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
      try {
        await putSql(c, id, doc).first();
      } catch (error) {
        throw conflict(error) ? new StoreConflictError() : error;
      }
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
        for (let attempt = 1; ; attempt++) {
          const pending = new Map<string, { c: string; id: string; doc: Doc | null }>();
          // The first text this attempt saw for each document, or null for a missing one.
          const reads = new Map<string, { c: string; id: string; text: string | null }>();
          const note = (c: string, id: string, text: string | null) => {
            const key = `${c}/${id}`;
            if (!pending.has(key) && !reads.has(key)) reads.set(key, { c, id, text });
          };
          const tx: StoreOps = {
            async get<T extends Doc>(c: string, id: string) {
              const hit = pending.get(`${c}/${id}`);
              if (hit) return hit.doc as T | null;
              const text = await readText(c, id);
              note(c, id, text);
              return (text === null ? null : JSON.parse(text)) as T | null;
            },
            async put(c, id, doc) {
              pending.set(`${c}/${id}`, { c, id, doc: JSON.parse(JSON.stringify(doc)) as Doc });
            },
            async delete(c, id) {
              pending.set(`${c}/${id}`, { c, id, doc: null });
            },
            async query<T extends Doc>(c: string, q: Query = {}) {
              if (pending.size > 0 && (q.orderBy || q.cursor)) throw new Error("ordered queries after a write in a transaction are not supported");
              const page = await find<T>(c, q, (id, text) => note(c, id, text));
              const mine = [...pending.values()].filter((p) => p.c === c);
              const match = (doc: Doc) => Object.entries(q.where ?? {}).every(([k, v]) => doc[k] === v);
              const items = page.items.filter((i) => !mine.some((p) => p.id === i.id));
              for (const p of mine) if (p.doc && match(p.doc)) items.push({ id: p.id, data: p.doc as T });
              return { items: items.sort((a, b) => (a.id < b.id ? -1 : 1)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
            },
          };
          const result = await fn(tx);
          if (pending.size === 0) return result;
          const guards = [...reads.values()].map((r) =>
            db.prepare("INSERT INTO docs_guard (ok) SELECT CASE WHEN (SELECT data FROM docs WHERE collection = ? AND id = ?) IS ? THEN 1 END").bind(r.c, r.id, r.text),
          );
          const writes = [...pending.values()].map((p) => (p.doc ? putSql(p.c, p.id, p.doc) : delSql(p.c, p.id)));
          try {
            await db.batch([...guards, ...writes, db.prepare("DELETE FROM docs_guard")]);
            return result;
          } catch (error) {
            if (!conflict(error)) throw error;
            if (attempt >= ATTEMPTS) throw new StoreConflictError();
          }
        }
      }),
  };
}

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore, parseRegion, type AdapterOptions, type Blobs, type Doc, type Store, type StoreOps } from "agentic-identity";

type Change = [collection: string, id: string, doc: Doc | null];

/**
 * A Store kept in a journal file: one JSON line per committed write set, replayed on open.
 * It is the shared memory store plus the journal, so it follows the same rules. One process at a time.
 */
export function createFileStore(dir: string, options: AdapterOptions & { shared?: string } = {}): Store {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "store.jsonl");
  const inner = createMemoryStore(options);
  const ready = (async () => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      for (const [collection, id, doc] of JSON.parse(line) as Change[]) await (doc ? inner.put(collection, id, doc) : inner.delete(collection, id));
    }
  })();
  const keep = (changes: Change[]) => {
    if (changes.length > 0) appendFileSync(file, `${JSON.stringify(changes)}\n`);
  };
  const recording = (ops: StoreOps, changes: Change[]): StoreOps => ({
    ...ops,
    put: async (collection, id, doc) => {
      await ops.put(collection, id, doc);
      changes.push([collection, id, doc]);
    },
    delete: async (collection, id) => {
      await ops.delete(collection, id);
      changes.push([collection, id, null]);
    },
  });
  return {
    region: inner.region,
    get: async (c, id) => (await ready, inner.get(c, id)),
    query: async (c, q) => (await ready, inner.query(c, q)),
    async put(collection, id, doc) {
      await ready;
      await inner.put(collection, id, doc);
      keep([[collection, id, doc]]);
    },
    async delete(collection, id) {
      await ready;
      await inner.delete(collection, id);
      keep([[collection, id, null]]);
    },
    async transaction(fn) {
      await ready;
      // A rerun starts over, so only the last run's writes are the committed ones.
      let changes: Change[] = [];
      const result = await inner.transaction((tx) => {
        changes = [];
        return fn(recording(tx, changes));
      });
      keep(changes);
      return result;
    },
  };
}

/** Blobs kept as files under `dir`. File names are key hashes, so no key escapes the folder. */
export function createFileBlobs(dir: string, options: AdapterOptions = {}): Blobs {
  mkdirSync(dir, { recursive: true });
  const path = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));
  const need = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
  };
  const now = options.now ?? Date.now;
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async put(key, data, opts) {
      need(key);
      writeFileSync(path(key), data);
      if (opts?.contentType) writeFileSync(`${path(key)}.type`, opts.contentType);
      else rmSync(`${path(key)}.type`, { force: true });
    },
    async get(key) {
      need(key);
      if (!existsSync(path(key))) return null;
      const type = existsSync(`${path(key)}.type`) ? readFileSync(`${path(key)}.type`, "utf8") : undefined;
      return { data: new Uint8Array(readFileSync(path(key))), ...(type ? { contentType: type } : {}) };
    },
    async delete(key) {
      need(key);
      rmSync(path(key), { force: true });
      rmSync(`${path(key)}.type`, { force: true });
    },
    /** A local path with its expiry. Nothing serves or checks it: it exists so the port is whole. */
    async signedUrl(key, { method, expiresInSeconds }) {
      need(key);
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      return `file://${path(key)}?method=${method}&expires=${now() + expiresInSeconds * 1000}`;
    },
  };
}

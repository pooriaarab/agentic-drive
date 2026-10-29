import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore, parseRegion, type AdapterOptions, type Blobs, type Doc, type Store, type StoreOps } from "agentic-identity";

type Change = [collection: string, id: string, doc: Doc | null];

/**
 * A Store kept in a journal file: one JSON line per committed write set, replayed on open.
 * It is the shared memory store plus the journal, so it follows the same rules. One process at a time.
 * A half-written last line (a crash during an append) is cut off on open. A bad line anywhere else
 * throws, because the data cannot be trusted. If an append fails, the store refuses every later call.
 * `shared` exists for the contract suites: stores that share a name share one live dataset, so do not
 * open the same directory twice with it in production.
 */
export function createFileStore(dir: string, options: AdapterOptions & { shared?: string } = {}): Store {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "store.jsonl");
  const inner = createMemoryStore(options);
  const ready = (async () => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    let good = 0;
    for (const [i, line] of lines.entries()) {
      if (line === "") {
        good += 1;
        continue;
      }
      let changes: Change[];
      try {
        changes = JSON.parse(line) as Change[];
      } catch {
        if (i < lines.length - 1) throw new Error(`the journal ${file} has a bad line ${i + 1}`);
        truncateSync(file, good === 0 ? 0 : Buffer.byteLength(lines.slice(0, good).join("\n")) + 1);
        return;
      }
      for (const [collection, id, doc] of changes) await (doc ? inner.put(collection, id, doc) : inner.delete(collection, id));
      good += 1;
    }
  })();
  let failed: unknown;
  const keep = (changes: Change[]) => {
    if (changes.length === 0) return;
    try {
      const fd = openSync(file, "a");
      try {
        writeSync(fd, `${JSON.stringify(changes)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // Memory now holds a write that the file lacks. Stop, so nothing is read from a state that a restart would lose.
      failed = error;
      throw error;
    }
  };
  const open = async () => {
    await ready;
    if (failed !== undefined) throw new Error("the journal could not be written, so the store is closed. Open it again.");
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
    get: async (c, id) => (await open(), inner.get(c, id)),
    query: async (c, q) => (await open(), inner.query(c, q)),
    async put(collection, id, doc) {
      await open();
      await inner.put(collection, id, doc);
      keep([[collection, id, doc]]);
    },
    async delete(collection, id) {
      await open();
      await inner.delete(collection, id);
      keep([[collection, id, null]]);
    },
    async transaction(fn) {
      await open();
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

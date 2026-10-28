import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterOptions, Blobs, Store } from "../ports.js";
import { createMemoryStore, type Tables } from "./memory.js";

/** A Store kept in one JSON file. One process at a time. */
export function createFileStore(dir: string, options: AdapterOptions = {}): Store {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "store.json");
  const snapshot = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Tables) : {};
  return createMemoryStore({
    ...options,
    snapshot,
    onCommit(tables) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(tables));
      renameSync(tmp, file);
    },
  });
}

/** Blobs kept as files under `dir`. File names are key hashes, so no key escapes the folder. */
export function createFileBlobs(dir: string, options: AdapterOptions = {}): Blobs {
  mkdirSync(dir, { recursive: true });
  const path = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));
  return {
    region: options.region ?? "eu",
    async put(key, data, opts) {
      writeFileSync(path(key), data);
      if (opts?.contentType) writeFileSync(`${path(key)}.type`, opts.contentType);
      else rmSync(`${path(key)}.type`, { force: true });
    },
    async get(key) {
      if (!existsSync(path(key))) return null;
      const type = existsSync(`${path(key)}.type`) ? readFileSync(`${path(key)}.type`, "utf8") : undefined;
      return { data: new Uint8Array(readFileSync(path(key))), ...(type ? { contentType: type } : {}) };
    },
    async delete(key) {
      rmSync(path(key), { force: true });
      rmSync(`${path(key)}.type`, { force: true });
    },
    async signedUrl() {
      throw new Error("local file blobs have no signed URLs");
    },
  };
}

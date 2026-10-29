import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Blobs, Doc, Store } from "agentic-identity";

type Change = [collection: string, id: string, doc: Doc | null];

/**
 * Copies the data that the old local store kept (`db/store.jsonl` and hashed files in `blobs/`) into the shared
 * file store, once. A marker in the store records it. The old files stay, so nothing is lost if a copy fails:
 * a run that stops runs again, and it writes the same data. A torn last line of the journal was never
 * acknowledged, so it is dropped. A bad line anywhere else throws, because the data cannot be trusted.
 */
export async function importLegacyLocal(dir: string, store: Store, blobs: Blobs): Promise<void> {
  const journal = join(dir, "db", "store.jsonl");
  if (!existsSync(journal) || (await store.get("drive_meta", "legacy_import"))) return;
  const lines = readFileSync(journal, "utf8").split("\n");
  const tail = lines.pop() as string;
  const docs = new Map<string, Change>();
  const replay = (line: string, at: number | string) => {
    let changes: Change[];
    try {
      changes = JSON.parse(line) as Change[];
    } catch {
      throw new Error(`the journal ${journal} has a bad line ${at}`);
    }
    for (const change of changes) docs.set(`${change[0]}\0${change[1]}`, change);
  };
  for (const [i, line] of lines.entries()) if (line !== "") replay(line, i + 1);
  if (tail !== "") {
    try {
      replay(tail, "last");
    } catch {
      // A crash cut the last append. It was never acknowledged.
    }
  }
  const path = (key: string) => join(dir, "blobs", createHash("sha256").update(key).digest("hex"));
  for (const [collection, , doc] of docs.values()) {
    const key = collection === "drive_nodes" ? doc?.blobKey : undefined;
    if (typeof key !== "string" || !existsSync(path(key))) continue;
    const type = existsSync(`${path(key)}.type`) ? readFileSync(`${path(key)}.type`, "utf8") : undefined;
    // A blob that is there already came from an earlier run of this import.
    await blobs.put(key, new Uint8Array(readFileSync(path(key))), { ifNoneMatch: "*", ...(type ? { contentType: type } : {}) });
  }
  for (const [collection, id, doc] of docs.values()) if (doc) await store.put(collection, id, doc);
  await store.put("drive_meta", "legacy_import", { importedAt: Date.now() });
}

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
  const isChange = (c: unknown): c is Change =>
    Array.isArray(c) && c.length === 3 && typeof c[0] === "string" && typeof c[1] === "string" && (c[2] === null || (typeof c[2] === "object" && !Array.isArray(c[2])));
  const replay = (line: string, at: number | string) => {
    let changes: unknown;
    try {
      changes = JSON.parse(line);
    } catch {
      throw new Error(`the journal ${journal} has a bad line ${at}`);
    }
    if (!Array.isArray(changes) || !changes.every(isChange)) throw new Error(`the journal ${journal} has a bad line ${at}`);
    for (const change of changes) docs.set(`${change[0]}\0${change[1]}`, change);
  };
  for (const [i, line] of lines.entries()) if (line !== "") replay(line, i + 1);
  if (tail !== "") {
    // A tail that is not JSON was cut by a crash and never acknowledged. A whole tail that is wrong is bad data.
    let cut = false;
    try {
      JSON.parse(tail);
    } catch {
      cut = true;
    }
    if (!cut) replay(tail, "last");
  }
  let missing = 0;
  const path = (key: string) => join(dir, "blobs", createHash("sha256").update(key).digest("hex"));
  for (const [collection, , doc] of docs.values()) {
    const key = collection === "drive_nodes" ? doc?.blobKey : undefined;
    if (typeof key !== "string") continue;
    if (!existsSync(path(key))) {
      missing++;
      continue;
    }
    const type = existsSync(`${path(key)}.type`) ? readFileSync(`${path(key)}.type`, "utf8") : undefined;
    // A blob that is there already came from an earlier run of this import.
    await blobs.put(key, new Uint8Array(readFileSync(path(key))), { ifNoneMatch: "*", ...(type ? { contentType: type } : {}) });
  }
  if (missing > 0) console.error(`import: ${missing} old blob files are missing, so those files cannot be read.`);
  // One transaction is one write of the store file, and no half copy is left behind.
  await store.transaction(async (tx) => {
    if (await tx.get("drive_meta", "legacy_import")) return;
    // Data in the new store with no marker means something wrote there first. A copy would overwrite it.
    for (const collection of ["drive_nodes", "drive_names", "principals"]) {
      if ((await tx.query(collection, { limit: 1 })).items.length > 0) {
        throw new Error(`the folder holds old data and new data, and the old data was not imported. Move ${journal} away or import by hand.`);
      }
    }
    for (const [collection, id, doc] of docs.values()) if (doc) await tx.put(collection, id, doc);
    await tx.put("drive_meta", "legacy_import", { importedAt: Date.now() });
  });
}

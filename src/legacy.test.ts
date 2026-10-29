// Ways the one-time import of the old local layout can fail:
//  1. A file made before the swap cannot be read after it: its bytes or type did not move.
//  2. The import runs twice and breaks the data, or runs again after the user changed it.
//  3. A torn last line stops the import, or a bad middle line is skipped.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDrive, type Ctx } from "./drive.js";
import { importLegacyLocal } from "./legacy.js";
import { openLocal } from "./local.js";

const me: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const node = (id: string, parentId: string, name: string, extra: Record<string, unknown>) => ({
  id, owner: "u1", parentId, kind: "file", name, nameKey: name.toLowerCase(), size: 0, mime: null, hash: null, ref: null, blobKey: null,
  createdAt: 1, updatedAt: 1, createdBy: me.actor, updatedBy: me.actor, createdById: "u1", updatedById: "u1", trashed: false, trashedAt: null, purging: false, ...extra,
});

/** A folder in the old layout: one journal line with a file, and its blob under the hash of its key. */
function oldLayout(tail = "") {
  const dir = mkdtempSync(join(tmpdir(), "drive-legacy-"));
  mkdirSync(join(dir, "db"));
  mkdirSync(join(dir, "blobs"));
  const key = "blobs/old-1";
  const file = node("n1", "root", "old.txt", { size: 3, mime: "text/plain", blobKey: key });
  const claim = { nodeId: "n1", owner: "u1", parentId: "root" };
  writeFileSync(join(dir, "db", "store.jsonl"), `${JSON.stringify([["drive_nodes", "n1", file], ["drive_names", createHash("sha256").update("u1\0root\0old.txt").digest("hex"), claim]])}\n${tail}`);
  const path = join(dir, "blobs", createHash("sha256").update(key).digest("hex"));
  writeFileSync(path, "old");
  writeFileSync(`${path}.type`, "text/plain");
  return dir;
}

describe("import of the old local layout", () => {
  it("moves docs and blobs, and runs once", async () => {
    const dir = oldLayout();
    const { store, blobs } = openLocal(dir);
    await importLegacyLocal(dir, store, blobs);
    expect(await store.get("drive_nodes", "n1")).toMatchObject({ name: "old.txt", blobKey: "blobs/old-1" });
    expect(await blobs.get("blobs/old-1")).toMatchObject({ contentType: "text/plain" });
    expect(new TextDecoder().decode((await blobs.get("blobs/old-1"))!.data)).toBe("old");
    await store.delete("drive_nodes", "n1");
    await importLegacyLocal(dir, store, blobs);
    expect(await store.get("drive_nodes", "n1")).toBeNull();
  });
  it("drops a torn last line and refuses a bad middle line", async () => {
    const torn = oldLayout('[["drive_nodes","n2",{"id"');
    const a = openLocal(torn);
    await importLegacyLocal(torn, a.store, a.blobs);
    expect(await a.store.get("drive_nodes", "n1")).not.toBeNull();
    expect(await a.store.get("drive_nodes", "n2")).toBeNull();
    const bad = oldLayout();
    writeFileSync(join(bad, "db", "store.jsonl"), `not json\n${JSON.stringify([["drive_nodes", "n1", {}]])}\n`);
    const b = openLocal(bad);
    await expect(importLegacyLocal(bad, b.store, b.blobs)).rejects.toThrow(/bad line 1/);
    expect(await b.store.get("drive_nodes", "n1")).toBeNull();
  });
  it("lets the drive read the imported file", async () => {
    const dir = oldLayout();
    const { store, blobs } = openLocal(dir);
    await importLegacyLocal(dir, store, blobs);
    const drive = createDrive({ store, blobs });
    expect(new TextDecoder().decode((await drive.read(me, "/old.txt")).data)).toBe("old");
  });
});

it("refuses a line that parses but is not a list of changes", async () => {
  const dir = oldLayout();
  writeFileSync(join(dir, "db", "store.jsonl"), `${JSON.stringify([["drive_nodes", "n1", "text"]])}\n`);
  const { store, blobs } = openLocal(dir);
  await expect(importLegacyLocal(dir, store, blobs)).rejects.toThrow(/bad line 1/);
  expect(await store.get("drive_meta", "legacy_import")).toBeNull();
});

it("refuses to import over data that something wrote first", async () => {
  const dir = oldLayout();
  const { store, blobs } = openLocal(dir);
  await store.put("principals", "u9", { id: "u9" });
  await expect(importLegacyLocal(dir, store, blobs)).rejects.toThrow(/old data and new data/);
  expect(await store.get("drive_nodes", "n1")).toBeNull();
});

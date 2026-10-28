// Failure modes first. Each case names a way the move, path, or trash logic can break.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createFileBlobs, createFileStore } from "./adapters/fs.js";
import { createMemoryBlobs, createMemoryStore } from "./adapters/memory.js";
import { createDrive, DriveError, type Ctx, type Drive } from "./drive.js";
import type { Blobs, Store } from "./ports.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const human: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const agent: Ctx = { owner: "u1", actor: { id: "bot", kind: "agent_of_human" } };
const stranger: Ctx = { owner: "u2", actor: { id: "u2", kind: "human" } };

const adapters: [string, () => { store: Store; blobs: Blobs }][] = [
  ["memory", () => ({ store: createMemoryStore(), blobs: createMemoryBlobs() })],
  ["file", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-"));
    return { store: createFileStore(join(dir, "s")), blobs: createFileBlobs(join(dir, "b")) };
  }],
];

describe.each(adapters)("drive on %s adapters", (_name, make) => {
  let drive: Drive;
  let backend: { store: Store; blobs: Blobs };
  let clock = 1000;
  beforeEach(() => {
    backend = make();
    drive = createDrive({ ...backend, now: () => ++clock });
  });
  const fails = (promise: Promise<unknown>, c: string) => expect(promise).rejects.toMatchObject({ code: c });

  describe("move", () => {
    it("refuses to move a folder into itself or a descendant", async () => {
      await drive.mkdir(human, "/a/b/c", { parents: true });
      await fails(drive.move(human, "/a", "/a"), "MOVE_INTO_SELF");
      await fails(drive.move(human, "/a", "/a/b/c"), "MOVE_INTO_SELF");
      expect((await drive.list(human, "/a/b")).map((n) => n.name)).toEqual(["c"]);
    });
    it("refuses a name that exists at the destination, ignoring case and Unicode form", async () => {
      await drive.mkdir(human, "/dest");
      await drive.putFile(human, "/dest/Café.txt", bytes("1"));
      await drive.putFile(human, "/src.txt", bytes("2"));
      await fails(drive.move(human, "/src.txt", "/dest", { name: "café.TXT" }), "NAME_TAKEN");
      await fails(drive.move(human, "/src.txt", "/dest", { name: "CAFÉ.txt" }), "NAME_TAKEN");
    });
    it("refuses a file or missing destination", async () => {
      await drive.putFile(human, "/f.txt", bytes("1"));
      await drive.putFile(human, "/g.txt", bytes("1"));
      await fails(drive.move(human, "/g.txt", "/f.txt"), "NOT_A_FOLDER");
      await fails(drive.move(human, "/g.txt", "/nope"), "NOT_FOUND");
    });
    it("refuses a trashed destination and a trashed source", async () => {
      await drive.mkdir(human, "/t");
      await drive.putFile(human, "/f.txt", bytes("1"));
      await drive.trash(human, "/t");
      const trashed = (await drive.listTrash(human))[0]!;
      await fails(drive.move(human, "/f.txt", trashed.id), "TRASHED");
      await fails(drive.move(human, trashed.id, "/"), "TRASHED");
    });
    it("moves a folder with its children and keeps the blobs readable", async () => {
      await drive.putFile(human, "/a/x.txt", bytes("hi"), { parents: true });
      await drive.mkdir(human, "/z");
      await drive.move(human, "/a", "/z");
      expect(new TextDecoder().decode((await drive.read(human, "/z/a/x.txt")).data)).toBe("hi");
      await fails(drive.stat(human, "/a"), "NOT_FOUND");
    });
    it("lets a rename change only the case of the same item", async () => {
      await drive.putFile(human, "/a.txt", bytes("1"));
      await drive.rename(human, "/a.txt", "A.txt");
      expect((await drive.list(human, "/")).map((n) => n.name)).toEqual(["A.txt"]);
    });
    it("cannot move the root", async () => {
      await fails(drive.move(human, "/", "/"), "IS_ROOT");
    });
  });

  describe("names and paths", () => {
    it.each(["", " ", ".", "..", "a/b", "a\0b", "a\nb", "x".repeat(256)])("rejects the name %j", async (name) => {
      await drive.mkdir(human, "/ok");
      await fails(drive.rename(human, "/ok", name), "INVALID_NAME");
    });
    it("rejects dot segments and empty segments in a path", async () => {
      await fails(drive.mkdir(human, "/a/../b", { parents: true }), "INVALID_NAME");
      await fails(drive.mkdir(human, "/a//b", { parents: true }), "INVALID_PATH");
    });
    it("treats a string without a leading slash as an id", async () => {
      await drive.mkdir(human, "/a");
      await fails(drive.stat(human, "a"), "NOT_FOUND");
      const folder = await drive.stat(human, "/a");
      expect((await drive.stat(human, folder.id)).name).toBe("a");
    });
    it("keeps the stored name as typed and NFC-normalized", async () => {
      await drive.mkdir(human, "/Résumé");
      expect((await drive.list(human, "/"))[0]!.name).toBe("Résumé");
      expect((await drive.stat(human, "/RÉSUMÉ")).kind).toBe("folder");
    });
    it("supports emoji and CJK names", async () => {
      await drive.putFile(human, "/\u{1F4C1}/文件.txt", bytes("x"), { parents: true });
      expect((await drive.stat(human, "/\u{1F4C1}/文件.txt")).kind).toBe("file");
    });
  });

  describe("mkdir", () => {
    it("fails on a missing parent, a taken name, or a file in the path", async () => {
      await fails(drive.mkdir(human, "/a/b"), "NOT_FOUND");
      await drive.mkdir(human, "/a");
      await fails(drive.mkdir(human, "/a"), "NAME_TAKEN");
      await drive.putFile(human, "/f", bytes("x"));
      await fails(drive.mkdir(human, "/f/sub", { parents: true }), "NOT_A_FOLDER");
    });
    it("is idempotent with parents", async () => {
      const first = await drive.mkdir(human, "/a/b", { parents: true });
      const again = await drive.mkdir(human, "/a/b", { parents: true });
      expect(again.id).toBe(first.id);
    });
  });

  describe("trash", () => {
    it("hides a trashed folder and everything under it, and restores them together", async () => {
      await drive.putFile(human, "/d/x.txt", bytes("1"), { parents: true });
      await drive.trash(human, "/d");
      await fails(drive.stat(human, "/d/x.txt"), "NOT_FOUND");
      expect(await drive.list(human, "/")).toEqual([]);
      expect((await drive.listTrash(human)).map((n) => n.name)).toEqual(["d"]);
      const [item] = await drive.listTrash(human);
      await drive.restore(human, item!.id);
      expect((await drive.stat(human, "/d/x.txt")).size).toBe(1);
    });
    it("cannot trash the root or an item twice", async () => {
      await fails(drive.trash(human, "/"), "IS_ROOT");
      await drive.mkdir(human, "/a");
      const { id } = await drive.stat(human, "/a");
      await drive.trash(human, id);
      await fails(drive.trash(human, id), "TRASHED");
    });
    it("lets a new item reuse a trashed name, then restore collides", async () => {
      await drive.putFile(human, "/a.txt", bytes("old"));
      const { id } = await drive.stat(human, "/a.txt");
      await drive.trash(human, id);
      await drive.putFile(human, "/a.txt", bytes("new"));
      await fails(drive.restore(human, id), "NAME_TAKEN");
      const back = await drive.restore(human, id, { onConflict: "rename" });
      expect(back.name).toBe("a (2).txt");
    });
    it("refuses restore when the parent is trashed or missing, unless told where to go", async () => {
      await drive.putFile(human, "/p/x.txt", bytes("1"), { parents: true });
      const x = await drive.stat(human, "/p/x.txt");
      await drive.trash(human, x.id);
      await drive.trash(human, "/p");
      await fails(drive.restore(human, x.id), "PARENT_GONE");
      const p = (await drive.listTrash(human))[0]!;
      await backend.store.delete("drive_nodes", p.id);
      await fails(drive.restore(human, x.id), "PARENT_GONE");
      expect((await drive.restore(human, x.id, { parentId: "root" })).parentId).toBe("root");
    });
    it("purges a folder with its descendants and their blobs", async () => {
      await drive.putFile(human, "/d/e/x.txt", bytes("1"), { parents: true });
      const x = await drive.stat(human, "/d/e/x.txt");
      await drive.trash(human, "/d");
      const d = (await drive.listTrash(human))[0]!;
      await drive.purge(human, d.id);
      expect(await backend.blobs.get(x.blobKey!)).toBeNull();
      expect(await backend.store.get("drive_nodes", x.id)).toBeNull();
      expect(await drive.listTrash(human)).toEqual([]);
    });
    it("refuses to purge or restore an item that is not in the trash", async () => {
      await drive.mkdir(human, "/a");
      const { id } = await drive.stat(human, "/a");
      await fails(drive.purge(human, id), "NOT_TRASHED");
      await fails(drive.restore(human, id), "NOT_TRASHED");
    });
  });

  describe("files, references, metadata", () => {
    it("refuses to overwrite by default, replaces or renames on request", async () => {
      await drive.putFile(human, "/a.txt", bytes("1"));
      await fails(drive.putFile(human, "/a.txt", bytes("2")), "NAME_TAKEN");
      const kept = await drive.putFile(human, "/a.txt", bytes("22"), { onConflict: "replace" });
      expect(kept.size).toBe(2);
      expect(new TextDecoder().decode((await drive.read(human, "/a.txt")).data)).toBe("22");
      expect((await drive.putFile(human, "/a.txt", bytes("3"), { onConflict: "rename" })).name).toBe("a (2).txt");
      await drive.mkdir(human, "/dir");
      await fails(drive.putFile(human, "/dir", bytes("3"), { onConflict: "replace" }), "NAME_TAKEN");
    });
    it("stores a typed reference and refuses to read it as a file", async () => {
      const ref = await drive.putRef(human, "/plan", "docs:abc123");
      expect(ref).toMatchObject({ kind: "ref", ref: "docs:abc123" });
      await fails(drive.read(human, "/plan"), "NOT_A_FILE");
      await fails(drive.putRef(human, "/bad", "no colon"), "INVALID_REF");
      await fails(drive.putRef(human, "/bad2", "docs:a/b"), "INVALID_REF");
    });
    it("records size, mime, and who made and last changed an item", async () => {
      await drive.putFile(agent, "/n.txt", bytes("abc"), { mime: "text/plain" });
      const made = await drive.stat(human, "/n.txt");
      expect(made).toMatchObject({ size: 3, mime: "text/plain", owner: "u1", createdBy: { id: "bot", kind: "agent_of_human" } });
      await drive.rename(human, "/n.txt", "m.txt");
      const moved = await drive.stat(human, "/m.txt");
      expect(moved.updatedBy).toEqual({ id: "u1", kind: "human" });
      expect(moved.createdBy.kind).toBe("agent_of_human");
      expect(moved.updatedAt).toBeGreaterThan(moved.createdAt);
    });
    it("lists more than one page of children", async () => {
      await drive.mkdir(human, "/many");
      for (let i = 0; i < 230; i++) await drive.putRef(human, `/many/r${String(i).padStart(3, "0")}`, `docs:${i}`);
      expect(await drive.list(human, "/many")).toHaveLength(230);
    });
    it("lets only one of two parallel creates win a name", async () => {
      const results = await Promise.allSettled([drive.putFile(human, "/r.txt", bytes("1")), drive.putFile(human, "/r.txt", bytes("2"))]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await drive.list(human, "/")).toHaveLength(1);
    });
  });

  describe("owners and the can() seam", () => {
    it("hides one owner's items from another", async () => {
      await drive.putFile(human, "/a.txt", bytes("1"));
      const { id } = await drive.stat(human, "/a.txt");
      await fails(drive.stat(stranger, id), "NOT_FOUND");
      expect(await drive.list(stranger, "/")).toEqual([]);
    });
    it("asks can() before each action and stops on a denial", async () => {
      const seen: string[] = [];
      const guarded = createDrive({
        ...backend,
        can: (_ctx, action) => {
          seen.push(action);
          return action !== "write";
        },
      });
      await fails(guarded.mkdir(human, "/a"), "FORBIDDEN");
      await fails(guarded.putFile(human, "/a.txt", bytes("1")), "FORBIDDEN");
      expect(seen).toContain("write");
    });
  });
});

it("keeps data across a reopened file store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-"));
  const open = () => createDrive({ store: createFileStore(join(dir, "s")), blobs: createFileBlobs(join(dir, "b")) });
  await open().putFile(human, "/keep.txt", bytes("kept"));
  expect(new TextDecoder().decode((await open().read(human, "/keep.txt")).data)).toBe("kept");
});

it("exposes DriveError with a code", () => {
  expect(new DriveError("NOT_FOUND", "x")).toMatchObject({ name: "DriveError", code: "NOT_FOUND" });
});

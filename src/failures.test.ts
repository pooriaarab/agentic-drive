// Failure modes first. Each case names a way the drive can lose bytes or build a cycle.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { createDrive, type Ctx } from "./drive.js";
import type { Blobs, Store } from "agentic-identity";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const human: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };

describe("move fails closed at the depth cap", () => {
  const deepChain = async (maxDepth: number) => {
    const drive = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs(), maxDepth });
    const names = Array.from({ length: maxDepth + 4 }, (_, i) => `b${i}`);
    await drive.mkdir(human, `/A/${names.join("/")}`, { parents: true });
    return { drive, deepest: `/A/${names.join("/")}` };
  };
  it("refuses a move into a descendant that is deeper than the cap", async () => {
    const { drive, deepest } = await deepChain(8);
    await expect(drive.move(human, "/A", deepest)).rejects.toMatchObject({ code: "TOO_DEEP" });
    expect((await drive.stat(human, "/A")).parentId).toBe("root");
  });
  it("refuses a move when an ancestor cannot be read", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs() });
    await drive.mkdir(human, "/A/B/C", { parents: true });
    await drive.mkdir(human, "/Z");
    const b = await drive.stat(human, "/A/B");
    const c = await drive.stat(human, "/A/B/C");
    await store.delete("drive_nodes", b.id);
    await expect(drive.move(human, "/Z", c.id)).rejects.toBeDefined();
    expect((await drive.stat(human, "/Z")).parentId).toBe("root");
  });
  it("rejects a path with more than 64 segments", async () => {
    const drive = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
    const path = "/" + Array.from({ length: 65 }, (_, i) => `d${i}`).join("/");
    await expect(drive.mkdir(human, path, { parents: true })).rejects.toMatchObject({ code: "TOO_DEEP" });
  });
});

describe("putFile never deletes the live blob", () => {
  const failingDeletes = (blobs: Blobs, shouldFail: (key: string) => boolean): Blobs => ({
    ...blobs,
    delete: async (key) => {
      if (shouldFail(key)) throw new Error("storage 503");
      await blobs.delete(key);
    },
  });
  it("keeps the new blob and logs an orphan when the old-blob delete fails", async () => {
    const real = createMemoryBlobs();
    const store = createMemoryStore();
    const orphans: string[] = [];
    const first = createDrive({ store, blobs: real });
    const old = await first.putFile(human, "/a.txt", bytes("old"));
    const drive = createDrive({ store, blobs: failingDeletes(real, () => true), onOrphan: (key) => orphans.push(key) });
    const next = await drive.putFile(human, "/a.txt", bytes("new"), { onConflict: "replace" });
    expect(text((await drive.read(human, "/a.txt")).data)).toBe("new");
    expect(await real.get(next.blobKey!)).not.toBeNull();
    expect(orphans).toEqual([old.blobKey]);
  });
  it("deletes the new blob when the commit did not happen", async () => {
    const real = createMemoryBlobs();
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: real });
    await drive.putFile(human, "/a.txt", bytes("old"));
    const keys: string[] = [];
    const spy: Blobs = { ...real, put: async (key, data, opts) => { keys.push(key); return real.put(key, data, opts); } };
    await expect(createDrive({ store, blobs: spy }).putFile(human, "/a.txt", bytes("new"))).rejects.toMatchObject({ code: "NAME_TAKEN" });
    expect(await real.get(keys[0]!)).toBeNull();
    expect(text((await drive.read(human, "/a.txt")).data)).toBe("old");
  });
  it("keeps the new blob when the commit succeeded but the reply was lost", async () => {
    const real = createMemoryBlobs();
    const base = createMemoryStore();
    const lossy: Store = {
      ...base,
      transaction: async (fn) => {
        await base.transaction(fn);
        throw new Error("connection reset");
      },
    };
    const keys: string[] = [];
    const spy: Blobs = { ...real, put: async (key, data, opts) => { keys.push(key); return real.put(key, data, opts); } };
    const drive = createDrive({ store: lossy, blobs: spy, onOrphan: () => undefined });
    await expect(drive.putFile(human, "/a.txt", bytes("new"))).rejects.toThrow("connection reset");
    expect(await real.get(keys[0]!)).not.toBeNull();
    expect(text((await createDrive({ store: base, blobs: real }).read(human, "/a.txt")).data)).toBe("new");
  });
});

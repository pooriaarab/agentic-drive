// Failure modes first. Each case names a way hard delete or export can leak, lose, or escape.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { buildExport } from "./export.js";
import type { Blobs, Store } from "agentic-identity";
import { readZip, safeEntryName, writeZip } from "./zip.js";

const me: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const b = (s: string) => new TextEncoder().encode(s);

function setup(failOn?: (call: number, key: string) => boolean) {
  const inner = createMemoryBlobs();
  const state = { calls: 0, failing: true };
  const blobs: Blobs = {
    ...inner,
    delete: async (key) => {
      state.calls++;
      if (state.failing && failOn?.(state.calls, key)) throw new Error("storage 503");
      await inner.delete(key);
    },
  };
  const store: Store = createMemoryStore();
  return { drive: createDrive({ store, blobs }), store, inner, state };
}
const blobKeys = async (drive: Drive, inner: Blobs) => {
  const keys: string[] = [];
  for (const { node } of await drive.exportData(me)) if (node.blobKey && (await inner.get(node.blobKey))) keys.push(node.blobKey);
  return keys;
};

describe("purge deletes blobs before rows", () => {
  it("keeps every row when a blob delete fails, so a retry finishes the job", async () => {
    const { drive, store, inner, state } = setup((call) => call === 3);
    for (let i = 0; i < 6; i++) await drive.putFile(me, `/d/e/f${i}.txt`, b(`x${i}`), { parents: true });
    const keys = (await drive.exportData(me)).flatMap(({ node }) => (node.blobKey ? [node.blobKey] : []));
    await drive.trash(me, "/d");
    const top = (await drive.listTrash(me))[0]!;
    await expect(drive.purge(me, top.id)).rejects.toThrow("storage 503");
    expect((await store.query("drive_nodes", { limit: 100 })).items).toHaveLength(8);
    state.failing = false;
    expect(await drive.purge(me, top.id)).toEqual({ removed: 8 });
    for (const key of keys) expect(await inner.get(key)).toBeNull();
    expect((await store.query("drive_nodes", { limit: 100 })).items).toHaveLength(0);
  });
  it("purges a nested folder with more than 100 children", async () => {
    const { drive, store } = setup();
    await drive.mkdir(me, "/big/inbox", { parents: true });
    for (let i = 0; i < 150; i++) await drive.putRef(me, `/big/inbox/r${i}`, `docs:${i}`);
    await drive.trash(me, "/big");
    const top = (await drive.listTrash(me))[0]!;
    expect(await drive.purge(me, top.id)).toEqual({ removed: 152 });
    expect((await store.query("drive_nodes", { limit: 100 })).items).toHaveLength(0);
  });
});

describe("deleteAll deletes blobs first and misses nothing", () => {
  it("keeps every row when a blob delete fails, then removes all on retry", async () => {
    const { drive, store, inner, state } = setup((call) => call === 2);
    for (let i = 0; i < 4; i++) await drive.putFile(me, `/f${i}.txt`, b("x"));
    await expect(drive.deleteAll(me)).rejects.toThrow("storage 503");
    // The items are marked for erase and hidden, and every row stays so the retry can finish.
    expect(await drive.list(me, "/")).toHaveLength(0);
    expect((await store.query("drive_nodes", { limit: 100 })).items).toHaveLength(4);
    // An export leaves out items that are marked for erase.
    expect((await drive.exportData(me)).map((e) => e.node.name)).toEqual([]);
    state.failing = false;
    expect(await drive.deleteAll(me)).toEqual({ removed: 4 });
    expect(await blobKeys(drive, inner)).toEqual([]);
  });
  it("also removes a file created while the delete runs", async () => {
    const { drive, store, inner } = setup();
    await drive.putFile(me, "/a.txt", b("1"));
    let raced = false;
    const racing: Blobs = {
      ...inner,
      delete: async (key) => {
        await inner.delete(key);
        if (!raced) {
          raced = true;
          await createDrive({ store, blobs: inner }).putFile(me, "/late.txt", b("2"));
        }
      },
    };
    await createDrive({ store, blobs: racing }).deleteAll(me);
    expect((await store.query("drive_nodes", { limit: 100 })).items).toHaveLength(0);
    expect(await blobKeys(drive, inner)).toEqual([]);
  });
  it.each(["agent_of_human", "agent_of_agent", "agent", "user_token"] as const)("refuses a %s actor that carries the owner id", async (kind) => {
    const { drive } = setup();
    await drive.putFile(me, "/a.txt", b("1"));
    await expect(drive.deleteAll({ owner: "u1", actor: { id: "u1", kind } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await drive.list(me, "/")).toHaveLength(1);
  });
});

describe("export entry names", () => {
  it.each(["..\\..\\x.bat", "../x", "a/../b", "/abs", "\\abs", "C:\\x", "c:x", "a\\b", "a\0b", "a//b", "", "files/./x"])("refuses %j", (name) => {
    expect(safeEntryName(name)).toBe(false);
    expect(() => writeZip([{ name, data: b("x") }], 0)).toThrow(/entry name/);
  });
  it.each(["manifest.json", "files/7f3a-0c", "files/a.b"])("accepts %j", (name) => expect(safeEntryName(name)).toBe(true));
  it("keeps a hostile file name out of every entry name", async () => {
    const { drive } = setup();
    await drive.putFile(me, "/..\\..\\AppData\\Startup\\x.bat", b("evil"));
    const zip = readZip(await buildExport(drive, me));
    for (const name of zip.keys()) expect(safeEntryName(name)).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!));
    expect(manifest.items[0].name).toBe("..\\..\\AppData\\Startup\\x.bat");
  });
  it("records a missing blob in the manifest and keeps going", async () => {
    const { drive, inner } = setup();
    const gone = await drive.putFile(me, "/gone.txt", b("1"));
    await drive.putFile(me, "/kept.txt", b("2"));
    await inner.delete(gone.blobKey!);
    const zip = readZip(await buildExport(drive, me));
    const items = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!)).items as { name: string; missing?: boolean; file: string | null }[];
    expect(items.find((i) => i.name === "gone.txt")).toMatchObject({ missing: true, file: null });
    expect(new TextDecoder().decode(zip.get(items.find((i) => i.name === "kept.txt")!.file!)!)).toBe("2");
  });
});

describe("download names", () => {
  it("signs a name with quotes and answers a lone surrogate with INVALID_NAME", async () => {
    const drive = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
    const ctx = { owner: "u1", actor: { id: "u1", kind: "human" as const } };
    await drive.putFile(ctx, "/it's (1).csv", new Uint8Array([1]));
    expect(await drive.downloadUrl(ctx, "/it's (1).csv")).toContain("filename*%3DUTF-8");
    await expect(drive.putFile(ctx, "/a\ud800.csv", new Uint8Array([1]))).rejects.toMatchObject({ code: "INVALID_NAME" });
  });
});

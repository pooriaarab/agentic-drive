// Failure modes first. Each case names a way two writers, or a half-finished write, can break the rule
// that a live name is unique in its folder. Each store below is its own lock, like a second Worker isolate
// on one database.
//  1. Two stores create the same name at once: both win.
//  2. Two stores move different items to one name at once: both win.
//  3. A trashed item keeps its name, so a new item cannot take it.
//  4. Restore puts a second item under a name that a new item took.
//  5. A claim whose item is gone still blocks the name (fail closed).
//  6. Purge or erase leaves a claim behind, so the name is lost for good.
//  7. Purge of a trashed item deletes the claim of the live item that took its name.
import { Miniflare } from "miniflare";
import { D1_SCHEMA, createD1Store, type D1Like } from "agentic-identity/cloudflare";
import { createMemoryBlobs, createMemoryStore, type Blobs, type Doc, type Query, type Store } from "agentic-identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrive, type Ctx } from "./drive.js";

let mf: Miniflare;
let db: D1Like;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: ["DB"] });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await (db as unknown as { prepare(sql: string): { run(): Promise<unknown> } }).prepare(D1_SCHEMA).run();
});
afterAll(() => mf.dispose());

const store = () => createD1Store(db, { region: "eu" });
const blobs = createMemoryBlobs();
const drive = (s = store()) => createDrive({ store: s, blobs });
let n = 0;
const owner = (): Ctx => ({ owner: `o${++n}`, actor: { id: `o${n}`, kind: "human" } });
const bytes = (s: string) => new TextEncoder().encode(s);
const claims = async (me: Ctx) => (await store().query("drive_names", { where: { owner: me.owner }, limit: 100 })).items.length;

describe("name uniqueness across stores", () => {
  it("lets only one of two stores create a live name", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 15; round++) {
      const me = owner();
      const [a, b] = [drive(), drive()];
      const results = await Promise.allSettled([a.putFile(me, "/r.txt", bytes("1")), b.putFile(me, "/r.txt", bytes("2"))]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { code: string }).code).toBe("NAME_TAKEN");
      expect(await a.list(me, "/")).toHaveLength(1);
    }
  });
  it("lets only one of two stores move into the same name", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 10; round++) {
      const me = owner();
      const [a, b] = [drive(), drive()];
      await a.putFile(me, "/x.txt", bytes("1"));
      await a.putFile(me, "/y.txt", bytes("2"));
      await a.mkdir(me, "/dest");
      const results = await Promise.allSettled([a.move(me, "/x.txt", "/dest", { name: "t.txt" }), b.move(me, "/y.txt", "/dest", { name: "t.txt" })]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(await a.list(me, "/dest")).toHaveLength(1);
    }
  });
  it("never lets two stores move two folders into each other", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 10; round++) {
      const me = owner();
      const [a, b] = [drive(), drive()];
      await a.mkdir(me, "/A");
      await a.mkdir(me, "/B");
      const results = await Promise.allSettled([a.move(me, "/A", "/B"), b.move(me, "/B", "/A")]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const [top] = await a.list(me, "/");
      expect(await a.list(me, "/")).toHaveLength(1);
      expect(await a.list(me, top!.id)).toHaveLength(1);
    }
  });
  it("reruns a transaction whose reads changed before the commit", async () => {
    const [one, two] = [store(), store()];
    const key = `k${++n}`;
    await one.put("counters", key, { v: 1 });
    const seen: number[] = [];
    await one.transaction(async (tx) => {
      const doc = (await tx.get<{ v: number }>("counters", key))!;
      seen.push(doc.v);
      if (seen.length === 1) await two.put("counters", key, { v: 10 });
      await tx.put("counters", key, { v: doc.v + 1 });
    });
    expect(seen).toEqual([1, 10]);
  });
});

describe("claims follow the life of an item", () => {
  it("frees a name when its item is trashed, and refuses to restore into a name that was taken", async () => {
    const me = owner();
    const d = drive();
    const first = await d.putFile(me, "/a.txt", bytes("1"));
    await d.trash(me, "/a.txt");
    expect(await claims(me)).toBe(0);
    await d.putFile(me, "/a.txt", bytes("2"));
    await expect(d.restore(me, first.id)).rejects.toMatchObject({ code: "NAME_TAKEN" });
    expect((await d.restore(me, first.id, { onConflict: "rename" })).name).toBe("a (2).txt");
    expect(await claims(me)).toBe(2);
  });
  it("moves the claim with a move and a rename", async () => {
    const me = owner();
    const d = drive();
    await d.mkdir(me, "/dest");
    await d.putFile(me, "/a.txt", bytes("1"));
    await d.move(me, "/a.txt", "/dest");
    await d.putFile(me, "/a.txt", bytes("2"));
    await expect(d.move(me, "/a.txt", "/dest")).rejects.toMatchObject({ code: "NAME_TAKEN" });
    await d.rename(me, "/dest/a.txt", "b.txt");
    await d.putFile(me, "/dest/a.txt", bytes("3"));
    expect(await claims(me)).toBe(4);
  });
  it("still blocks a name when its claim names no item", async () => {
    const me = owner();
    const s = store();
    const d = drive(s);
    const a = await d.putFile(me, "/ghost.txt", bytes("1"));
    await s.delete("drive_nodes", a.id);
    await expect(d.putFile(me, "/ghost.txt", bytes("2"))).rejects.toMatchObject({ code: "NAME_TAKEN" });
    await expect(d.stat(me, "/ghost.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("leaves no claim after a purge or an erase", async () => {
    const me = owner();
    const d = drive();
    await d.putFile(me, "/p/q/r.txt", bytes("1"), { parents: true });
    await d.trash(me, "/p");
    await d.purge(me, (await d.listTrash(me))[0]!.id);
    expect(await claims(me)).toBe(0);
    await d.putFile(me, "/s/t.txt", bytes("2"), { parents: true });
    await d.deleteAll(me);
    expect(await claims(me)).toBe(0);
    await d.putFile(me, "/s/t.txt", bytes("3"), { parents: true });
  });
  it("keeps the claim of a live item when a trashed item of the same name is purged", async () => {
    const me = owner();
    const d = drive();
    const old = await d.putFile(me, "/same.txt", bytes("1"));
    await d.trash(me, "/same.txt");
    await d.putFile(me, "/same.txt", bytes("2"));
    await d.purge(me, old.id);
    await expect(d.putFile(me, "/same.txt", bytes("3"))).rejects.toMatchObject({ code: "NAME_TAKEN" });
  });
  it("purges a nested folder with more than 100 children", { timeout: 60_000 }, async () => {
    const me = owner();
    const d = drive();
    await d.mkdir(me, "/big/inbox", { parents: true });
    for (let i = 0; i < 101; i++) await d.putRef(me, `/big/inbox/r${i}`, `docs:${i}`);
    await d.trash(me, "/big");
    expect(await d.purge(me, (await d.listTrash(me))[0]!.id)).toEqual({ removed: 103 });
    expect(await d.list(me, "/")).toEqual([]);
    expect(await claims(me)).toBe(0);
  });
});

// A purge works from a snapshot. Each case is a way a change that lands during the purge goes wrong.
//  8. A restore lands after the purge read the tree: the item is deleted, and its claim stays and blocks the name.
//  9. A restore lands between the blob delete and the row delete: the same.
//  10. A move or rename deletes a claim that another item holds.
describe("a purge that races with other changes", () => {
  const setup = () => {
    const inner = createMemoryStore();
    const hooks: { afterQuery?: () => Promise<void>; onBlobDelete?: () => Promise<void> } = {};
    const store: Store = {
      ...inner,
      query: async <T extends Doc>(c: string, q?: Query) => {
        const page = await inner.query<T>(c, q);
        const run = hooks.afterQuery;
        hooks.afterQuery = undefined;
        await run?.();
        return page;
      },
    };
    const plain = createMemoryBlobs();
    const racing: Blobs = {
      ...plain,
      delete: async (key) => {
        const run = hooks.onBlobDelete;
        hooks.onBlobDelete = undefined;
        await run?.();
        await plain.delete(key);
      },
    };
    return { store, inner, hooks, d: createDrive({ store, blobs: racing }) };
  };
  const names = async (store: Store) => (await store.query("drive_names", { limit: 100 })).items;

  const dangling = async (store: Store) => {
    const out: string[] = [];
    for (const { data } of await names(store)) if (!(await store.get("drive_nodes", data.nodeId as string))) out.push(data.nodeId as string);
    return out;
  };

  it("keeps a folder, its files, and their bytes when the folder was restored before the purge marked it", async () => {
    const me = owner();
    const { store, hooks, d } = setup();
    await d.putFile(me, "/box/a.txt", bytes("1"), { parents: true });
    await d.trash(me, "/box");
    const box = (await d.listTrash(me))[0]!;
    hooks.afterQuery = async () => void (await d.restore(me, box.id));
    await expect(d.purge(me, box.id)).rejects.toMatchObject({ code: "BUSY" });
    expect(new TextDecoder().decode((await d.read(me, "/box/a.txt")).data)).toBe("1");
    expect(await dangling(store)).toEqual([]);
    expect(await names(store)).toHaveLength(2);
  });
  it("refuses a restore once the purge has marked the item, so no item comes back without its bytes", async () => {
    const me = owner();
    const { store, hooks, d } = setup();
    await d.putFile(me, "/box/a.txt", bytes("1"), { parents: true });
    await d.trash(me, "/box");
    const box = (await d.listTrash(me))[0]!;
    let refused: unknown;
    hooks.onBlobDelete = async () => void (await d.restore(me, box.id).catch((error) => (refused = error)));
    expect(await d.purge(me, box.id)).toEqual({ removed: 2 });
    expect(refused).toMatchObject({ code: "NOT_FOUND" });
    await expect(d.stat(me, box.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await dangling(store)).toEqual([]);
    expect(await names(store)).toEqual([]);
  });
  it("hides a marked item from every read, and a purge that failed can run again", async () => {
    const me = owner();
    const { store, hooks, d } = setup();
    await d.putFile(me, "/box/a.txt", bytes("1"), { parents: true });
    await d.putFile(me, "/box/b.txt", bytes("2"), { parents: true });
    await d.trash(me, "/box");
    const box = (await d.listTrash(me))[0]!;
    hooks.onBlobDelete = async () => {
      throw new Error("storage 503");
    };
    await expect(d.purge(me, box.id)).rejects.toThrow("storage 503");
    await expect(d.restore(me, box.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await d.listTrash(me)).toEqual([]);
    expect(await d.purge(me, box.id)).toEqual({ removed: 3 });
    expect(await store.query("drive_nodes", { limit: 10 })).toMatchObject({ items: [] });
    expect(await names(store)).toEqual([]);
  });
  it("does not delete the claim of another item when a move leaves a name", async () => {
    const me = owner();
    const { store, d } = setup();
    await d.mkdir(me, "/dest");
    const a = await d.putFile(me, "/a.txt", bytes("1"));
    const claim = (await names(store)).find((e) => e.data.nodeId === a.id);
    const taker = { ...claim!.data, nodeId: "someone-else" };
    await store.put("drive_names", claim!.id, taker);
    await d.move(me, a.id, "/dest");
    expect((await store.get("drive_names", claim!.id))?.nodeId).toBe("someone-else");
  });
});

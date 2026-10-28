// Failure modes first. Each store below is its own lock, like a second Worker isolate on one database.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrive, DRIVE_UNIQUE_INDEXES, type Ctx } from "../drive.js";
import { StoreConflictError } from "../ports.js";
import { createD1Store, type D1Like } from "./d1.js";
import { createMemoryBlobs } from "./memory.js";

let mf: Miniflare;
let db: D1Like;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: ["DB"] });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
});
afterAll(() => mf.dispose());

const store = () => createD1Store(db, { unique: DRIVE_UNIQUE_INDEXES });
const drive = (s = store()) => createDrive({ store: s, blobs: createMemoryBlobs() });
let n = 0;
const owner = (): Ctx => ({ owner: `o${++n}`, actor: { id: `o${n}`, kind: "human" } });
const bytes = (s: string) => new TextEncoder().encode(s);

describe("name uniqueness across isolates", () => {
  it("lets only one of two isolates create a live name", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 15; round++) {
      const me = owner();
      const [a, b] = [drive(), drive()];
      const results = await Promise.allSettled([a.putFile(me, "/r.txt", bytes("1")), b.putFile(me, "/r.txt", bytes("2"))]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "NAME_TAKEN" });
      expect(await a.list(me, "/")).toHaveLength(1);
    }
  });
  it("makes the database refuse a second live row with the same name", async () => {
    const me = owner();
    const row = (id: string, trashed: boolean) => ({ id, owner: me.owner, parentId: "root", nameKey: "x", trashed });
    await store().put("drive_nodes", `${me.owner}-1`, row("1", false));
    await expect(store().put("drive_nodes", `${me.owner}-2`, row("2", false))).rejects.toBeInstanceOf(StoreConflictError);
    await store().put("drive_nodes", `${me.owner}-3`, row("3", true));
  });
});

describe("transactions across isolates", () => {
  it("reruns a transaction whose reads changed before the commit", async () => {
    const [one, two] = [store(), store()];
    const key = `k${++n}`;
    await one.put("counters", key, { v: 1 });
    let runs = 0;
    const seen: number[] = [];
    await one.transaction(async (tx) => {
      runs++;
      const doc = (await tx.get<{ v: number }>("counters", key))!;
      seen.push(doc.v);
      if (runs === 1) await two.put("counters", key, { v: 10 });
      await tx.put("counters", key, { v: doc.v + 1 });
    });
    expect(seen).toEqual([1, 10]);
    expect((await one.get<{ v: number }>("counters", key))!.v).toBe(11);
  });
  it("gives up with a conflict error when the data keeps changing", async () => {
    const [one, two] = [store(), store()];
    const key = `k${++n}`;
    await one.put("counters", key, { v: 0 });
    let runs = 0;
    await expect(
      one.transaction(async (tx) => {
        await tx.get("counters", key);
        await two.put("counters", key, { v: ++runs });
        await tx.put("counters", `${key}-out`, { v: 1 });
      }),
    ).rejects.toBeInstanceOf(StoreConflictError);
    expect(await one.get("counters", `${key}-out`)).toBeNull();
  });
  it("never lets two isolates move two folders into each other", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 15; round++) {
      const me = owner();
      const [a, b] = [drive(), drive()];
      await a.mkdir(me, "/A");
      await a.mkdir(me, "/B");
      const results = await Promise.allSettled([a.move(me, "/A", "/B"), b.move(me, "/B", "/A")]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      // The loser sees the winner's move, so its own path no longer exists or would loop.
      expect(["MOVE_INTO_SELF", "NOT_FOUND"]).toContain(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { code: string }).code);
      const [top] = await a.list(me, "/");
      expect(await a.list(me, "/")).toHaveLength(1);
      expect(await a.list(me, top!.id)).toHaveLength(1);
    }
  });
});

describe("D1 behavior the in-memory store hides", () => {
  it("purges a nested folder with more than 100 children", { timeout: 60_000 }, async () => {
    const me = owner();
    const d = drive();
    await d.mkdir(me, "/big/inbox", { parents: true });
    for (let i = 0; i < 101; i++) await d.putRef(me, `/big/inbox/r${i}`, `docs:${i}`);
    await d.trash(me, "/big");
    const top = (await d.listTrash(me))[0]!;
    expect(await d.purge(me, top.id)).toEqual({ removed: 103 });
    expect(await d.list(me, "/")).toEqual([]);
  });
  it("retries setup after a failed first call", async () => {
    let failures = 1;
    const flaky: D1Like = { ...db, prepare: db.prepare.bind(db), batch: async (s) => { if (failures-- > 0) throw new Error("D1 503"); return db.batch(s); } };
    const s = createD1Store(flaky);
    await expect(s.get("c", "x")).rejects.toThrow("D1 503");
    expect(await s.get("c", "x")).toBeNull();
  });
});

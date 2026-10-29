// Failure modes first. Each case is a way the backfill can leave an old drive unusable or open.
//  1. An item from before sharing gets no resources doc, so its owner still sees NOT_FOUND after the backfill.
//  2. The backfill gives the doc a parent that is not the item's folder, so a folder's role does not reach the item.
//  3. The backfill gives an item a grant, or the root a second owner, so a stranger reads the drive.
//  4. A second run writes again, or overwrites a doc that sharing has since changed.
//  5. A trashed item from before sharing gets no doc, so a restore fails.
import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { describe, expect, it } from "vitest";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { backfillResources } from "./migrate.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const principal = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] });
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
const alice = ctxOf(principal("alice"));
const bob = ctxOf(principal("bob"));
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

/** Items written by 0.1.0: a drive without sharing, on the same store. */
async function oldDrive() {
  const store = createMemoryStore();
  const blobs = createMemoryBlobs();
  const plain = createDrive({ store, blobs, now: () => 1_000_000 });
  await plain.putFile({ owner: "alice", actor: { id: "alice", kind: "human" } }, "/a.txt", bytes("a"));
  await plain.mkdir({ owner: "alice", actor: { id: "alice", kind: "human" } }, "/docs");
  const file = await plain.putFile({ owner: "alice", actor: { id: "alice", kind: "human" } }, "/docs/b.txt", bytes("b"));
  const gone = await plain.putFile({ owner: "alice", actor: { id: "alice", kind: "human" } }, "/gone.txt", bytes("g"));
  await plain.trash({ owner: "alice", actor: { id: "alice", kind: "human" } }, gone.id);
  return { store, blobs, file, gone };
}

/** The Worker's drive: sharing on, on the same store. */
function sharedDrive(store: ReturnType<typeof createMemoryStore>, blobs: ReturnType<typeof createMemoryBlobs>): Drive {
  return createDrive({ store, blobs, sharing: createSharing(store, { now: () => 1_000_000 }), now: () => 1_000_000 });
}

describe("backfillResources", () => {
  it("makes old items reachable for their owner, and nobody else", async () => {
    const { store, blobs, file } = await oldDrive();
    const drive = sharedDrive(store, blobs);
    await fails(drive.stat(alice, "/a.txt"), "NOT_FOUND");
    await fails(drive.stat(alice, file.id), "NOT_FOUND");

    expect(await backfillResources(store)).toEqual({ fixed: 4 });

    expect((await drive.stat(alice, "/a.txt")).name).toBe("a.txt");
    expect((await drive.stat(alice, "/docs/b.txt")).name).toBe("b.txt");
    expect(await drive.read(alice, file.id)).toMatchObject({ node: { name: "b.txt" } });
    await fails(drive.stat(bob, file.id), "NOT_FOUND");
  });

  it("writes a doc that inherits from the item's folder, and the root for top-level items", async () => {
    const { store, file } = await oldDrive();
    await backfillResources(store);
    const nested = await store.get("resources", file.id);
    const folder = (await store.query("drive_nodes", { where: { name: "docs" } })).items[0]!;
    expect(nested).toMatchObject({ type: "drive", parentId: folder.id });
    const top = await store.get("resources", (await store.query("drive_nodes", { where: { name: "a.txt" } })).items[0]!.id);
    expect(top).toMatchObject({ type: "drive", parentId: expect.stringMatching(/^drive-root-/) });
  });

  it("gives a trashed old item its doc, so the owner can restore it", async () => {
    const { store, blobs, gone } = await oldDrive();
    const drive = sharedDrive(store, blobs);
    await backfillResources(store);
    await drive.restore(alice, gone.id);
    expect((await drive.stat(alice, "/gone.txt")).name).toBe("gone.txt");
  });

  it("changes nothing on a second run", async () => {
    const { store, file } = await oldDrive();
    await backfillResources(store);
    const before = await store.get("resources", file.id);
    expect(await backfillResources(store)).toEqual({ fixed: 0 });
    expect(await store.get("resources", file.id)).toEqual(before);
  });

  it("leaves a doc that already exists, even one that differs from the item", async () => {
    const { store, file } = await oldDrive();
    const existing = { id: file.id, type: "drive", parentId: "some-other-resource" };
    await store.put("resources", file.id, existing);
    expect(await backfillResources(store)).toEqual({ fixed: 3 });
    expect(await store.get("resources", file.id)).toEqual(existing);
  });

  it("runs a page at a time, and resumes from the cursor it returns", async () => {
    const store = createMemoryStore();
    const plain = createDrive({ store, blobs: createMemoryBlobs(), now: () => 1_000_000 });
    const owner = { owner: "alice", actor: { id: "alice", kind: "human" } } as const;
    for (let i = 0; i < 25; i++) await plain.putFile(owner, `/f${i}.txt`, bytes("x"));
    let fixed = 0;
    let cursor: string | undefined;
    let calls = 0;
    do {
      const step = await backfillResources(store, { cursor, maxPages: 1 });
      fixed += step.fixed;
      cursor = step.nextCursor;
      calls++;
    } while (cursor !== undefined);
    expect(fixed).toBe(25);
    expect(calls).toBe(3);
  });

  it("stops on a damaged item, and writes no doc with a guessed parent", async () => {
    const store = createMemoryStore();
    await store.put("drive_nodes", "broken", { id: "broken", parentId: "root", kind: "file" });
    await expect(backfillResources(store)).rejects.toThrow(/has no owner or parent/);
    expect(await store.get("resources", "broken")).toBeNull();
  });
});

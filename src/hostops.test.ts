// What a host app needs: find a node by ref, list the trash with paths, put a ref with a role, and the status map.
import { createMemoryBlobs, createSharing, type PrincipalContext } from "agentic-identity";
import { backend } from "./test-backend.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createDrive, ERROR_STATUS, type Ctx, type Drive, type ErrorCode } from "./drive.js";
import * as pkg from "./index.js";
import * as worker from "./worker.js";

const principal = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] });
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
const [A, B] = [ctxOf(principal("alice")), ctxOf(principal("bob"))];
const bytes = (s: string) => new TextEncoder().encode(s);
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

let drive: Drive;
let sharing: ReturnType<typeof createSharing>;
let clock: number;
beforeEach(() => {
  clock = 1_000_000;
  const store = backend.store();
  sharing = createSharing(store, { now: () => clock });
  drive = createDrive({ store, blobs: createMemoryBlobs(), sharing, now: () => ++clock });
});

describe("findByRef", () => {
  it("finds live references with their paths, and nothing else", async () => {
    await drive.putRef(A, "/b/plan", "docs:1", { parents: true });
    await drive.putRef(A, "/a/plan", "docs:1", { parents: true });
    await drive.putRef(A, "/other", "docs:2");
    await drive.putFile(A, "/docs:1", bytes("x"));
    expect((await drive.findByRef(A, "docs:1")).map((r) => r.path)).toEqual(["/a/plan", "/b/plan"]);
    expect(await drive.findByRef(A, "docs:nope")).toEqual([]);
  });
  it("skips trashed references and references under a trashed folder", async () => {
    const one = await drive.putRef(A, "/f/one", "docs:1", { parents: true });
    await drive.putRef(A, "/g/two", "docs:1", { parents: true });
    await drive.trash(A, one.id);
    expect((await drive.findByRef(A, "docs:1")).map((r) => r.path)).toEqual(["/g/two"]);
    await drive.trash(A, "/g");
    expect(await drive.findByRef(A, "docs:1")).toEqual([]);
  });
  it("shows another person nothing, and refuses a malformed ref", async () => {
    await drive.putRef(A, "/plan", "docs:1");
    expect(await drive.findByRef(B, "docs:1")).toEqual([]);
    await fails(drive.findByRef(A, "no colon"), "INVALID_REF");
  });
});

describe("listTrashWithPaths", () => {
  it("gives the path each item had, newest trashed first", async () => {
    const x = await drive.putFile(A, "/dir/x.txt", bytes("x"), { parents: true });
    const y = await drive.putRef(A, "/y", "docs:y");
    await drive.trash(A, x.id);
    await drive.trash(A, y.id);
    const out = await drive.listTrashWithPaths(A);
    expect(out.map((r) => [r.node.id, r.path])).toEqual([[y.id, "/y"], [x.id, "/dir/x.txt"]]);
  });
  it("keeps the path of an item under a trashed folder, and hides other people's trash", async () => {
    await drive.putFile(A, "/f/inner/z.txt", bytes("z"), { parents: true });
    await drive.trash(A, "/f");
    expect((await drive.listTrashWithPaths(A)).map((r) => r.path)).toEqual(["/f"]);
    expect(await drive.listTrashWithPaths(B)).toEqual([]);
  });
  it("is empty for a live drive", async () => {
    await drive.putFile(A, "/a.txt", bytes("a"));
    expect(await drive.listTrashWithPaths(A)).toEqual([]);
  });
});

describe("claimRef", () => {
  it("puts the reference and gives the role in one call", async () => {
    const node = await drive.claimRef(A, "/shared/plan", "docs:1", { subject: { kind: "human", id: "bob" }, role: "editor" }, { parents: true });
    expect(node).toMatchObject({ kind: "ref", ref: "docs:1" });
    expect((await drive.stat(B, node.id)).id).toBe(node.id);
    const shares = await drive.shares(A, node.id);
    expect(shares.grants).toEqual([expect.objectContaining({ subjectId: "bob", role: "editor" })]);
  });
  it("leaves nothing behind when the share fails", async () => {
    await fails(drive.claimRef(A, "/plan", "docs:1", { subject: { kind: "human", id: "bob" }, role: "boss" as never }), "INVALID_SHARE");
    expect(await drive.list(A, "/")).toEqual([]);
    expect(await drive.findByRef(A, "docs:1")).toEqual([]);
    expect(await drive.listTrash(A)).toEqual([]);
    // The name is free again.
    expect((await drive.putRef(A, "/plan", "docs:1")).name).toBe("plan");
  });
  it("rolls back when the caller may not share the new item", async () => {
    await drive.mkdir(A, "/team");
    const team = await drive.stat(A, "/team");
    await drive.shareWith(A, "/team", { kind: "human", id: "bob" }, "editor");
    await fails(drive.claimRef(B, `${team.id}/plan`, "docs:1", { subject: { kind: "human", id: "carol" }, role: "viewer" }), "FORBIDDEN");
    expect(await drive.list(A, "/team")).toEqual([]);
    expect(await drive.findByRef(A, "docs:1")).toEqual([]);
  });
  it("removes the reference but keeps the folders that parents made", async () => {
    await drive.mkdir(A, "/team");
    const team = await drive.stat(A, "/team");
    await drive.shareWith(A, "/team", { kind: "human", id: "bob" }, "editor");
    await fails(drive.claimRef(B, `${team.id}/new/plan`, "docs:1", { subject: { kind: "human", id: "carol" }, role: "viewer" }, { parents: true }), "FORBIDDEN");
    expect(await drive.findByRef(A, "docs:1")).toEqual([]);
    expect((await drive.list(A, "/team")).map((n) => n.name)).toEqual(["new"]);
    expect(await drive.list(A, "/team/new")).toEqual([]);
  });
  it("checks the input before it writes anything", async () => {
    await fails(drive.claimRef(A, "/plan", "bad", { subject: { kind: "human", id: "bob" }, role: "viewer" }), "INVALID_REF");
    await fails(drive.claimRef(A, "/plan", "docs:1", { subject: { kind: "robot" as never, id: "bob" }, role: "viewer" }), "INVALID_SHARE");
    expect(await drive.list(A, "/")).toEqual([]);
  });
  it("refuses a caller with no principal before it writes", async () => {
    const { principal: _p, ...bare } = A;
    await fails(drive.claimRef(bare, "/plan", "docs:1", { subject: { kind: "human", id: "bob" }, role: "viewer" }), "FORBIDDEN");
    expect(await drive.list(A, "/")).toEqual([]);
  });
  it("needs sharing", async () => {
    const plain = createDrive({ store: backend.store(), blobs: createMemoryBlobs() });
    await fails(plain.claimRef(A, "/plan", "docs:1", { subject: { kind: "human", id: "bob" }, role: "viewer" }), "INVALID_SHARE");
  });
  it("does not replace a taken name", async () => {
    await drive.putRef(A, "/plan", "docs:0");
    await fails(drive.claimRef(A, "/plan", "docs:1", { subject: { kind: "human", id: "bob" }, role: "viewer" }), "NAME_TAKEN");
    expect((await drive.findByRef(A, "docs:0")).length).toBe(1);
  });
});

describe("exports for hosts", () => {
  const all: ErrorCode[] = [
    "REF_CONFLICT", "NOT_FOUND", "NAME_TAKEN", "BLOB_EXISTS", "INVALID_NAME", "INVALID_PATH", "INVALID_REF", "NOT_A_FOLDER", "NOT_A_FILE", "MOVE_INTO_SELF", "TOO_DEEP",
    "PARENT_GONE", "TRASHED", "NOT_TRASHED", "IS_ROOT", "FORBIDDEN", "BLOB_MISSING", "TOO_LARGE", "INVALID_EXPIRY", "BUSY", "CROSS_DRIVE", "INVALID_SHARE", "TOO_MANY_ITEMS",
  ];
  it("maps every error code to an HTTP error status, from the package and the worker entry", () => {
    expect(pkg.ERROR_STATUS).toBe(ERROR_STATUS);
    expect(worker.ERROR_STATUS).toBe(ERROR_STATUS);
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...all].sort());
    expect(Object.isFrozen(ERROR_STATUS)).toBe(true);
    expect(ERROR_STATUS).toMatchObject({ NOT_FOUND: 404, FORBIDDEN: 403, NAME_TAKEN: 409, TOO_LARGE: 413, INVALID_REF: 400 });
  });
});

// Failure cases: two hosts race, existing sharing has another owner, a path
// conflicts, trash frees ownership, restore conflicts, and removal frees it.
describe("trusted resource references", () => {
  const ownership = (id: string) => ({ resourceId: "app-document", type: "doc", subject: { kind: "human" as const, id } });
  it("allows only one subject across two drive instances", async () => {
    const store = backend.store();
    const sharing = createSharing(store);
    const deps = { store, sharing, blobs: createMemoryBlobs() };
    const a = createDrive(deps), b = createDrive(deps);
    const results = await Promise.allSettled([
      a.claimResourceRef(A, "/a", "docs:1", ownership("alice")),
      b.claimResourceRef(B, "/b", "docs:1", ownership("bob")),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "REF_CONFLICT" } });
    expect((await store.query("drive_nodes", { where: { kind: "ref" } })).items).toHaveLength(1);
  });
  it("repeats the same claim without host conflict recovery", async () => {
    const nodes = await Promise.all(Array.from({ length: 4 }, () => drive.claimResourceRef(A, "/same", "docs:1", ownership("alice"))));
    expect(new Set(nodes.map(n => n.id)).size).toBe(1);
    await fails(drive.claimResourceRef(A, "/same", "docs:2", ownership("alice")), "REF_CONFLICT");
  });
  it("rolls back a reference when existing ownership conflicts", async () => {
    await sharing.claimResource("app-document", { kind: "human", id: "bob" }, "external", async (_tx, claims) => { claims.ensureOwner("doc"); });
    await fails(drive.claimResourceRef(A, "/a", "docs:1", ownership("alice")), "REF_CONFLICT");
    expect(await drive.findByRef(A, "docs:1")).toEqual([]);
  });
  it("keeps ownership until the last reference is released", async () => {
    const a = await drive.claimResourceRef(A, "/a", "docs:1", ownership("alice"));
    const b = await drive.claimResourceRef(A, "/b", "docs:1", ownership("alice"));
    await drive.trash(A, a.id);
    await fails(drive.claimResourceRef(B, "/b", "docs:1", ownership("bob")), "REF_CONFLICT");
    await drive.trash(A, b.id);
    expect((await drive.claimResourceRef(B, "/b", "docs:1", ownership("bob"))).ref).toBe("docs:1");
  });
  it("releases a live child when a trashed folder is purged", async () => {
    await drive.claimResourceRef(A, "/folder/plan", "docs:1", ownership("alice"), { parents: true });
    await drive.trash(A, "/folder");
    await drive.purge(A, (await drive.listTrash(A))[0]!.id);
    expect((await drive.claimResourceRef(B, "/plan", "docs:1", ownership("bob"))).ref).toBe("docs:1");
  });
  it("keeps claims through failed paths and releases on trash and purge", async () => {
    const a = await drive.claimResourceRef(A, "/a", "docs:1", ownership("alice"));
    await fails(drive.claimResourceRef(A, "/a", "docs:2", ownership("alice")), "REF_CONFLICT");
    await drive.trash(A, a.id);
    const b = await drive.claimResourceRef(B, "/b", "docs:1", ownership("bob"));
    await fails(drive.restore(A, a.id), "REF_CONFLICT");
    expect((await drive.listTrash(A)).map(n => n.id)).toContain(a.id);
    await drive.trash(B, b.id);
    await drive.restore(A, a.id);
    await drive.trash(A, a.id);
    await drive.purge(A, a.id);
    expect((await drive.claimResourceRef(B, "/c", "docs:1", ownership("bob"))).ref).toBe("docs:1");
  });
});

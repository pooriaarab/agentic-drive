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
    "NOT_FOUND", "NAME_TAKEN", "BLOB_EXISTS", "INVALID_NAME", "INVALID_PATH", "INVALID_REF", "NOT_A_FOLDER", "NOT_A_FILE", "MOVE_INTO_SELF", "TOO_DEEP",
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

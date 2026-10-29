// Failure modes first. Each case is a way sharing can give too much, give too little, or lose its rules.
//  1. A viewer writes, trashes, moves, shares, or purges.
//  2. An editor shares or purges.
//  3. A person with no role learns that an id exists (anything but NOT_FOUND).
//  4. A role on a folder does not reach a file that moves into it, or still reaches one that moves out.
//  5. A role on one file reaches its sibling.
//  6. An agent that acts for an owner gets more than its scopes.
//  7. A link works after its expiry or its revoke, for another item, or for an anonymous visitor when it needs sign-in.
//  8. An invite is accepted by the wrong email, or twice.
//  9. A collaborator's item breaks name uniqueness, or lands in the collaborator's own drive.
//  10. An item moves into another person's drive.
//  11. A caller names an owner that is not the root of its chain.
//  12. A denied request leaves no audit entry.
//  13. A purge leaves the shares of the purged item.
//  14. An item whose sharing record is gone is readable by anyone (fail closed).
//  15. A listing of shares shows a link token, or shows to a non-owner.
//  16. An item sits deeper than sharing can follow, and nobody, the owner included, can reach it.
//  17. A path walk shows an existing folder to a caller whose scopes do not cover the drive.
//  18. An editor with a share on one item cannot rename it, because its folder is out of reach.
//  19. A purge or an erase leaves links, invites, or grants (past the first page) behind, and old shares then apply to new files.
//  20. A restore into a parent id tells a caller which ids exist.
//  21. An agent principal, with a forged human actor, erases a drive.
//  22. A restore puts a subtree deeper than sharing can follow.
//  23. A path walk reaches an item that an id lookup denies, because its sharing record is gone.
//  24. A folder whose parent is missing takes new items.
//  25. A restore reads a whole subtree for a caller who has no role, so cost and status show that the id exists.
//  26. A move or restore reads an unbounded subtree, and a big folder can never move.
//  27. rename("/") fails with a plain error, not IS_ROOT.
//  28. The root claims it was made by a person when a machine owns the drive.
//  29. An editor, or an agent of an editor with fewer scopes, moves an item into a folder they own, and becomes its owner.
//  30. Counting a height reads file pages, so a folder of files runs past a query cap.
//  31. A big folder cannot move up, rename, or restore to its own parent, because its height is counted when it cannot get deeper.
//  32. mkdir -p returns an existing folder whose sharing record is gone.
//  33. A purge or an erase leaves the audit entries of the erased item, because identity was not asked to erase the resource.
//  34. A grant for an agent is read as a grant for a person with the same id, or an unknown kind is taken for a person.
import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, it } from "vitest";
import { createDrive, subjectKindOf, type Ctx, type Drive } from "./drive.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const principal = (id: string, kind: PrincipalContext["kind"] = "human", scopes = ["drive:admin"], chain?: PrincipalContext["chain"]): PrincipalContext => ({
  principalId: id, kind, chain: chain ?? [{ id, kind }], scopes,
});
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });

const alice = principal("alice");
const bob = principal("bob");
const carol = principal("carol");
const botOf = (scopes: string[]) => principal("bot", "agent_of_human", scopes, [{ id: "alice", kind: "human" }, { id: "bot", kind: "agent_of_human" }]);
const [A, B, C] = [ctxOf(alice), ctxOf(bob), ctxOf(carol)];

let clock = 1_000_000;
let store: ReturnType<typeof createMemoryStore>;
let drive: Drive;
let sharing: ReturnType<typeof createSharing>;
beforeEach(() => {
  clock = 1_000_000;
  store = createMemoryStore();
  sharing = createSharing(store, { now: () => clock });
  drive = createDrive({ store, blobs: createMemoryBlobs(), sharing, now: () => ++clock });
});
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
/** Alice makes /team/docs/a.txt and shares /team with Bob as `role`. */
async function team(role: "viewer" | "commenter" | "editor") {
  const file = await drive.putFile(A, "/team/docs/a.txt", bytes("a"), { parents: true });
  const folder = await drive.stat(A, "/team");
  await drive.shareWith(A, "/team", { kind: "human", id: "bob" }, role);
  return { file, folder };
}

describe("roles on a folder", () => {
  it("lets a viewer read everything below and nothing else", async () => {
    const { file, folder } = await team("viewer");
    expect((await drive.stat(B, file.id)).name).toBe("a.txt");
    expect(new TextDecoder().decode((await drive.read(B, file.id)).data)).toBe("a");
    expect((await drive.list(B, folder.id)).map((n) => n.name)).toEqual(["docs"]);
    await fails(drive.putFile(B, `${folder.id}/new.txt`, bytes("x")), "FORBIDDEN");
    await fails(drive.mkdir(B, `${folder.id}/more`), "FORBIDDEN");
    await fails(drive.trash(B, file.id), "FORBIDDEN");
    await fails(drive.rename(B, file.id, "b.txt"), "FORBIDDEN");
    await fails(drive.move(B, file.id, folder.id), "FORBIDDEN");
    await fails(drive.shareWith(B, folder.id, { kind: "human", id: "carol" }, "viewer"), "FORBIDDEN");
    await fails(drive.createLink(B, folder.id, { role: "viewer" }), "FORBIDDEN");
    await fails(drive.shares(B, folder.id), "FORBIDDEN");
    await drive.trash(A, file.id);
    await fails(drive.purge(B, file.id), "FORBIDDEN");
  });
  it("lets an editor change content, but neither share nor purge", async () => {
    const { file, folder } = await team("editor");
    const made = await drive.putFile(B, `${folder.id}/docs/b.txt`, bytes("b"));
    expect(made.owner).toBe("alice");
    await drive.rename(B, file.id, "c.txt");
    await drive.trash(B, made.id);
    await fails(drive.shareWith(B, folder.id, { kind: "human", id: "carol" }, "viewer"), "FORBIDDEN");
    await fails(drive.invite(B, folder.id, { role: "viewer", email: "c@example.com" }), "FORBIDDEN");
    await fails(drive.purge(B, made.id), "FORBIDDEN");
    // Erase works on the caller's own drive only.
    expect(await drive.deleteAll(B)).toEqual({ removed: 0 });
    expect((await drive.stat(A, "/team/docs/c.txt")).id).toBe(file.id);
  });
  it("answers NOT_FOUND to a person with no role, for every kind of read and write", async () => {
    const { file, folder } = await team("viewer");
    for (const call of [
      () => drive.stat(C, file.id), () => drive.list(C, folder.id), () => drive.read(C, file.id), () => drive.downloadUrl(C, file.id),
      () => drive.putFile(C, `${folder.id}/x.txt`, bytes("x")), () => drive.trash(C, file.id), () => drive.shareWith(C, folder.id, { kind: "human", id: "carol" }, "owner"),
    ]) await fails(call(), "NOT_FOUND");
    await fails(drive.stat(C, "nope"), "NOT_FOUND");
  });
  it("gives a grant on one file to that file only", async () => {
    const one = await drive.putFile(A, "/one.txt", bytes("1"));
    const two = await drive.putFile(A, "/two.txt", bytes("2"));
    await drive.shareWith(A, one.id, { kind: "human", id: "bob" }, "viewer");
    expect((await drive.stat(B, one.id)).name).toBe("one.txt");
    await fails(drive.stat(B, two.id), "NOT_FOUND");
    expect(await drive.list(B, "/")).toEqual([]);
  });
  it("follows an item that moves between folders", async () => {
    await drive.mkdir(A, "/open");
    await drive.mkdir(A, "/closed");
    const file = await drive.putFile(A, "/closed/f.txt", bytes("f"));
    await drive.shareWith(A, "/open", { kind: "human", id: "bob" }, "viewer");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await drive.move(A, file.id, "/open");
    expect((await drive.stat(B, file.id)).name).toBe("f.txt");
    await drive.move(A, file.id, "/closed");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await drive.trash(A, file.id);
    await drive.restore(A, file.id, { parentId: (await drive.stat(A, "/open")).id });
    expect((await drive.stat(B, file.id)).name).toBe("f.txt");
  });
  it("loses a share when the role is revoked, and keeps the last owner", async () => {
    const { file } = await team("viewer");
    await drive.unshare(A, "/team", { kind: "human", id: "bob" });
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await fails(drive.unshare(A, "/", { kind: "human", id: "alice" }), "INVALID_SHARE");
  });
  it("rejects a bad role and a bad subject as INVALID_SHARE", async () => {
    await drive.mkdir(A, "/x");
    await fails(drive.shareWith(A, "/x", { kind: "human", id: "bob" }, "boss" as never), "INVALID_SHARE");
    await fails(drive.shareWith(A, "/x", { kind: "human", id: "../etc" }, "viewer"), "INVALID_SHARE");
  });
});

describe("names and drives", () => {
  it("keeps a name unique in a shared folder across people", async () => {
    const { folder } = await team("editor");
    await drive.putFile(B, `${folder.id}/x.txt`, bytes("1"));
    await fails(drive.putFile(A, "/team/x.txt", bytes("2")), "NAME_TAKEN");
    await fails(drive.putFile(B, `${folder.id}/X.TXT`, bytes("3")), "NAME_TAKEN");
    expect((await drive.list(A, "/team")).map((n) => n.name).sort()).toEqual(["docs", "x.txt"]);
  });
  it("refuses to move an item into another person's drive", async () => {
    const { file } = await team("editor");
    await fails(drive.move(B, file.id, "/"), "CROSS_DRIVE");
    await drive.trash(B, file.id);
    await fails(drive.restore(B, file.id, { parentId: "root" }), "CROSS_DRIVE");
  });
  it("refuses a caller whose owner is not the root of its chain", async () => {
    await drive.mkdir(A, "/x");
    await fails(drive.list({ ...B, owner: "alice" }, "/"), "FORBIDDEN");
    await fails(drive.stat({ ...A, principal: bob }, "/x"), "FORBIDDEN");
  });
  it("keeps drives apart", async () => {
    await drive.mkdir(A, "/mine");
    expect(await drive.list(B, "/")).toEqual([]);
    await fails(drive.stat(B, "/mine"), "NOT_FOUND");
  });
});

describe("agents", () => {
  it("narrows an agent to its scopes, whatever its owner may do", async () => {
    const { file } = await team("viewer");
    const reader = ctxOf(botOf(["drive:read"]));
    expect((await drive.stat(reader, "/team")).name).toBe("team");
    await fails(drive.putFile(reader, "/new.txt", bytes("x")), "FORBIDDEN");
    await fails(drive.trash(reader, file.id), "FORBIDDEN");
    const writer = ctxOf(botOf(["drive:write"]));
    const made = await drive.putFile(writer, "/by-bot.txt", bytes("x"));
    expect(made.createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
    expect(made.owner).toBe("alice");
    await fails(drive.shareWith(writer, "/team", { kind: "human", id: "carol" }, "viewer"), "FORBIDDEN");
    await fails(drive.deleteAll(writer), "FORBIDDEN");
    await fails(drive.stat(ctxOf(botOf(["other:admin"])), "/team"), "NOT_FOUND");
  });
});

describe("links and invites", () => {
  it("lets a visitor read below a linked folder, and nowhere else", async () => {
    const { file, folder } = await team("viewer");
    const other = await drive.putFile(A, "/private.txt", bytes("p"));
    const { token } = await drive.createLink(A, "/team", { role: "viewer" });
    expect((await drive.openShared(null, file.id, token)).name).toBe("a.txt");
    expect((await drive.listShared(null, folder.id, token)).map((n) => n.name)).toEqual(["docs"]);
    expect(new TextDecoder().decode((await drive.readShared(null, file.id, token)).data)).toBe("a");
    await fails(drive.openShared(null, other.id, token), "NOT_FOUND");
    await fails(drive.openShared(null, file.id, "wrong-token"), "NOT_FOUND");
    await fails(drive.openShared(null, file.id), "NOT_FOUND");
    await fails(drive.openShared(null, "root", token), "NOT_FOUND");
  });
  it("stops a link at its expiry and at its revoke", async () => {
    const { file } = await team("viewer");
    const soon = await drive.createLink(A, "/team", { role: "viewer", expiresAt: clock + 5_000 });
    const gone = await drive.createLink(A, "/team", { role: "viewer" });
    await drive.openShared(null, file.id, soon.token);
    clock += 5_000;
    await fails(drive.openShared(null, file.id, soon.token), "NOT_FOUND");
    await drive.revokeLink(A, gone.id);
    await fails(drive.openShared(null, file.id, gone.token), "NOT_FOUND");
    await fails(drive.createLink(A, "/team", { role: "viewer", expiresAt: clock - 1 }), "INVALID_SHARE");
    await fails(drive.createLink(A, "/team", { role: "viewer", expiresAt: Number.NaN }), "INVALID_SHARE");
    await fails(drive.createLink(A, "/team", { role: "owner" as never }), "INVALID_SHARE");
  });
  it("needs a sign-in for a link that asks for one", async () => {
    const { file } = await team("viewer");
    const { token } = await drive.createLink(A, "/team", { role: "viewer", signedInOnly: true });
    await fails(drive.openShared(null, file.id, token), "NOT_FOUND");
    expect((await drive.openShared(carol, file.id, token)).name).toBe("a.txt");
  });
  it("stops serving a trashed item to a link visitor", async () => {
    const { file } = await team("viewer");
    const { token } = await drive.createLink(A, "/team", { role: "viewer" });
    await drive.trash(A, "/team");
    await fails(drive.openShared(null, file.id, token), "TRASHED");
  });
  it("accepts an invite by verified email once, and only for that email", async () => {
    const { file, folder } = await team("viewer");
    await drive.unshare(A, folder.id, { kind: "human", id: "bob" });
    const { id } = await drive.invite(A, folder.id, { role: "editor", email: "Bob@Example.com" });
    await fails(drive.acceptInvite(B, id, { email: "mallory@example.com" }), "FORBIDDEN");
    await fails(drive.acceptInvite(B, id, {}), "FORBIDDEN");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await drive.acceptInvite(B, id, { email: "bob@example.com" });
    expect((await drive.stat(B, file.id)).name).toBe("a.txt");
    await fails(drive.acceptInvite(B, id, { email: "bob@example.com" }), "FORBIDDEN");
  });
  it("accepts an invite by handle only for an agent with its own identity", async () => {
    const { folder } = await team("viewer");
    const { id } = await drive.invite(A, folder.id, { role: "viewer", handle: "reporter" });
    const agent = ctxOf(principal("reporter-1", "agent"));
    await fails(drive.acceptInvite(B, id, { handle: "reporter" }), "FORBIDDEN");
    await drive.acceptInvite(agent, id, { handle: "reporter" });
    expect((await drive.stat(agent, folder.id)).name).toBe("team");
    await fails(drive.invite(A, folder.id, { role: "viewer" }), "INVALID_SHARE");
    await fails(drive.invite(A, folder.id, { role: "viewer", email: "a@b.c", handle: "h" }), "INVALID_SHARE");
  });
});

describe("the share list, the audit, and fail-closed storage", () => {
  it("lists shares to an owner, without link tokens", async () => {
    const { folder } = await team("viewer");
    const link = await drive.createLink(A, "/team", { role: "viewer" });
    await drive.invite(A, "/team", { role: "viewer", email: "x@example.com" });
    const shown = await drive.shares(A, "/team");
    expect(shown.grants).toEqual([{ subjectKind: "human", subjectId: "bob", role: "viewer" }]);
    expect(shown.links).toEqual([{ id: link.id, role: "viewer", signedInOnly: false, expiresAt: null, revoked: false }]);
    expect(JSON.stringify(shown)).not.toContain(link.token);
    expect(shown.invites).toHaveLength(1);
    await fails(drive.shares(C, folder.id), "NOT_FOUND");
  });
  it("records a denied request in the audit trail, with the kind of the caller", async () => {
    const { file, folder } = await team("viewer");
    await fails(drive.putFile(B, `${folder.id}/x.txt`, bytes("x")), "FORBIDDEN");
    await fails(drive.stat(C, file.id), "NOT_FOUND");
    const { entries } = await sharing.listAudit(alice, folder.id);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ principalId: "bob", outcome: "denied", action: "write", principalKind: "human" })]));
    const agentCtx = ctxOf(botOf(["drive:read"]));
    await fails(drive.trash(agentCtx, file.id), "FORBIDDEN");
    expect((await sharing.listAudit(alice, file.id)).entries.some((e) => e.principalId === "bot" && e.machineMade && e.outcome === "denied")).toBe(true);
  });
  it("deletes the shares of an item when the item is purged", async () => {
    const { file } = await team("viewer");
    await drive.shareWith(A, file.id, { kind: "human", id: "carol" }, "viewer");
    await drive.trash(A, "/team");
    await drive.purge(A, (await drive.listTrash(A))[0]!.id);
    expect((await store.query("grants", { where: { resourceId: file.id } })).items).toEqual([]);
    expect(await store.get("resources", file.id)).toBeNull();
  });
  it("denies everyone, the owner too, when the sharing record of an item is gone", async () => {
    const { file } = await team("viewer");
    await store.delete("resources", file.id);
    await fails(drive.stat(A, file.id), "NOT_FOUND");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await fails(drive.read(A, file.id), "NOT_FOUND");
  });
  it("denies when a stored role is not a role", async () => {
    const { file } = await team("viewer");
    await store.put("grants", "team-corrupt", { resourceId: file.id, subjectId: "carol", role: 7 });
    await store.put("grants", `${file.id}:carol`, { resourceId: file.id, subjectId: "carol", role: { admin: true } });
    await fails(drive.stat(C, file.id), "NOT_FOUND");
  });
  it("refuses sharing calls when sharing is off", async () => {
    const plain = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
    await plain.mkdir(A, "/x");
    await fails(plain.shareWith(A, "/x", { kind: "human", id: "bob" }, "viewer"), "INVALID_SHARE");
    await fails(plain.openShared(null, "x", "t"), "INVALID_SHARE");
  });
});

describe("depth, scope, and in-place changes", () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join("/");
  it("stops a folder chain at the depth that sharing can follow, and creates nothing", async () => {
    await fails(drive.mkdir(A, `/${chain(16)}`, { parents: true }), "TOO_DEEP");
    expect(await drive.list(A, "/")).toEqual([]);
    const deepest = await drive.mkdir(A, `/${chain(14)}`, { parents: true });
    expect((await drive.stat(A, deepest.id)).name).toBe("d13");
    expect((await drive.putFile(A, `${deepest.id}/f.txt`, bytes("f"))).name).toBe("f.txt");
    await fails(drive.putFile(A, `${deepest.id}/sub/g.txt`, bytes("g"), { parents: true }), "TOO_DEEP");
  });
  it("refuses a move that would push a subtree past that depth", async () => {
    await drive.mkdir(A, `/${chain(10)}`, { parents: true });
    await drive.mkdir(A, "/s/t/u/v/w/x", { parents: true });
    await fails(drive.move(A, "/s", `/${chain(10)}`), "TOO_DEEP");
    expect((await drive.stat(A, "/s/t/u/v/w/x")).name).toBe("x");
    await drive.move(A, "/s/t/u/v/w/x", `/${chain(10)}`);
  });
  it("shows nothing about an existing path to a caller whose scopes miss the drive", async () => {
    await drive.mkdir(A, "/secret/inner", { parents: true });
    const stray = ctxOf(botOf(["docs:read"]));
    await fails(drive.mkdir(stray, "/secret/inner", { parents: true }), "NOT_FOUND");
    await fails(drive.mkdir(stray, "/secret", { parents: true }), "NOT_FOUND");
    await fails(drive.putFile(stray, "/secret/x.txt", bytes("x")), "NOT_FOUND");
    await fails(drive.stat(stray, "/secret"), "NOT_FOUND");
    await fails(drive.list(stray, "/"), "NOT_FOUND");
  });
  it("lets an editor rename an item that was shared on its own", async () => {
    await drive.putFile(A, "/top.txt", bytes("t"));
    await drive.putFile(A, "/priv/in.txt", bytes("i"), { parents: true });
    await drive.mkdir(A, "/team");
    for (const path of ["/top.txt", "/priv/in.txt", "/team"]) await drive.shareWith(A, path, { kind: "human", id: "bob" }, "editor");
    const ids = [await drive.stat(A, "/top.txt"), await drive.stat(A, "/priv/in.txt"), await drive.stat(A, "/team")];
    for (const [i, node] of ids.entries()) expect((await drive.rename(B, node.id, `renamed${i}`)).name).toBe(`renamed${i}`);
    expect((await drive.stat(A, "/priv/renamed1")).id).toBe(ids[1]!.id);
    await fails(drive.move(B, ids[1]!.id, (await drive.stat(A, "/priv")).id), "NOT_FOUND");
  });
  it("deletes links, invites, and every grant of a purged item", { timeout: 60_000 }, async () => {
    const file = await drive.putFile(A, "/f.txt", bytes("f"));
    for (let i = 0; i < 105; i++) await drive.shareWith(A, file.id, { kind: "human", id: `friend-${i}` }, "viewer");
    const link = await drive.createLink(A, file.id, { role: "viewer" });
    await drive.invite(A, file.id, { role: "viewer", email: "gone@example.com" });
    await drive.trash(A, file.id);
    await drive.purge(A, file.id);
    for (const collection of ["grants", "links", "invites", "resources"]) expect((await store.query(collection, { limit: 500 })).items.filter((e) => e.data.resourceId === file.id || e.id === file.id), collection).toEqual([]);
    await fails(drive.openShared(null, file.id, link.token), "NOT_FOUND");
  });
  it("erases the shares of the drive root too, so an old share does not reach new files", async () => {
    await drive.putFile(A, "/old.txt", bytes("o"));
    await drive.shareWith(A, "/", { kind: "human", id: "bob" }, "viewer");
    await drive.createLink(A, "/", { role: "viewer" });
    await drive.invite(A, "/", { role: "viewer", email: "gone@example.com" });
    await drive.deleteAll(A);
    const fresh = await drive.putFile(A, "/new.txt", bytes("n"));
    await fails(drive.stat(B, fresh.id), "NOT_FOUND");
    expect((await store.query("invites", { limit: 10 })).items).toEqual([]);
    expect((await store.query("links", { limit: 10 })).items).toEqual([]);
    expect((await drive.stat(A, fresh.id)).name).toBe("new.txt");
  });
  it("answers PARENT_GONE to a restore into a parent that is missing, unreadable, or not a folder", async () => {
    const { file } = await team("editor");
    await drive.putFile(A, "/priv/x.txt", bytes("x"), { parents: true });
    const priv = await drive.stat(A, "/priv");
    const loose = await drive.putFile(A, "/loose.txt", bytes("l"));
    await drive.trash(B, file.id);
    for (const parentId of ["no-such-id", priv.id, loose.id]) await fails(drive.restore(B, file.id, { parentId }), "PARENT_GONE");
  });
  it("erases only when the principal is the owner in person", async () => {
    const forged: Ctx = { owner: "alice", actor: { id: "alice", kind: "human" }, principal: principal("alice", "agent", ["drive:admin"], [{ id: "alice", kind: "agent" }]) };
    await fails(drive.deleteAll(forged), "FORBIDDEN");
    const delegated: Ctx = { ...ctxOf(botOf(["drive:admin"])), actor: { id: "alice", kind: "human" } };
    await fails(drive.deleteAll(delegated), "FORBIDDEN");
  });
  it("refuses a restore that would put a subtree too deep, and leaves it in the trash", async () => {
    await drive.mkdir(A, `/${chain(14)}`, { parents: true });
    await drive.putFile(A, "/s/t/u/v.txt", bytes("v"), { parents: true });
    const deepest = await drive.stat(A, `/${chain(14)}`);
    await drive.trash(A, "/s");
    const s1 = (await drive.listTrash(A))[0]!;
    await fails(drive.restore(A, s1.id, { parentId: deepest.id }), "TOO_DEEP");
    expect((await drive.listTrash(A)).map((n) => n.id)).toEqual([s1.id]);
    await drive.restore(A, s1.id);
    expect((await drive.stat(A, "/s/t/u/v.txt")).name).toBe("v.txt");
  });
  it("denies a path to an item whose sharing record is gone, as it denies the id", async () => {
    const { file, folder } = await team("viewer");
    await store.delete("resources", file.id);
    await fails(drive.read(A, "/team/docs/a.txt"), "NOT_FOUND");
    await fails(drive.read(B, `${folder.id}/docs/a.txt`), "NOT_FOUND");
    await fails(drive.stat(A, "/team/docs/a.txt"), "NOT_FOUND");
  });
  it("refuses new items under a folder whose parent is missing", async () => {
    const inner = await drive.mkdir(A, "/a/b", { parents: true });
    await store.delete("drive_nodes", (await drive.stat(A, "/a")).id);
    await fails(drive.putFile(A, `${inner.id}/x.txt`, bytes("x")), "TRASHED");
  });
  it("reads no subtree for a caller with no role, and answers NOT_FOUND", async () => {
    await drive.mkdir(A, "/big", { parents: true });
    for (let i = 0; i < 30; i++) await drive.mkdir(A, `/big/f${i}`);
    const big = await drive.stat(A, "/big");
    await drive.trash(A, "/big");
    let queries = 0;
    const counted = createDrive({ store: { ...store, query: async (c, q) => (queries++, store.query(c, q)), transaction: (fn) => store.transaction(fn) } as typeof store, blobs: createMemoryBlobs(), sharing });
    await fails(counted.restore(B, big.id, { parentId: "root" }), "NOT_FOUND");
    expect(queries).toBeLessThan(5);
  });
  it("refuses to move a folder with too many subfolders to count, and moves a smaller one", { timeout: 120_000 }, async () => {
    await drive.mkdir(A, "/dest");
    await drive.mkdir(A, "/wide");
    for (let i = 0; i < 201; i++) await drive.mkdir(A, `/wide/f${i}`);
    await fails(drive.move(A, "/wide", "/dest"), "TOO_MANY_ITEMS");
    expect((await drive.stat(A, "/wide")).parentId).toBe("root");
    await drive.mkdir(A, "/narrow");
    for (let i = 0; i < 150; i++) await drive.mkdir(A, `/narrow/f${i}`);
    expect((await drive.move(A, "/narrow", "/dest")).name).toBe("narrow");
  });
  it("answers IS_ROOT to a rename of the root", async () => {
    await fails(drive.rename(A, "/", "x"), "IS_ROOT");
    await fails(drive.trash(A, "/"), "IS_ROOT");
  });
  it("names the kind of the owner on the root, whatever that kind is", async () => {
    const robot = ctxOf(principal("robo", "agent"));
    expect((await drive.stat(robot, "/")).createdBy).toEqual({ id: "robo", kind: "agent" });
    expect((await drive.stat(A, "/")).createdBy).toEqual({ id: "alice", kind: "human" });
  });
  it("stops an editor from becoming owner of an item by moving it into a folder they own", async () => {
    await drive.putFile(A, "/f/x.txt", bytes("x"), { parents: true });
    await drive.mkdir(A, "/g");
    await drive.shareWith(A, "/f", { kind: "human", id: "bob" }, "editor");
    await drive.shareWith(A, "/g", { kind: "human", id: "bob" }, "owner");
    const [x, f, g] = [await drive.stat(A, "/f/x.txt"), await drive.stat(A, "/f"), await drive.stat(A, "/g")];
    await fails(drive.move(B, x.id, g.id), "FORBIDDEN");
    // An agent with fewer scopes than its person must not do what the person may not.
    const bobBot = ctxOf(principal("bobbot", "agent_of_human", ["drive:write"], [{ id: "bob", kind: "human" }, { id: "bobbot", kind: "agent_of_human" }]));
    await fails(drive.move(bobBot, x.id, g.id), "FORBIDDEN");
    await drive.trash(B, x.id);
    await fails(drive.restore(bobBot, x.id, { parentId: g.id }), "FORBIDDEN");
    await fails(drive.restore(B, x.id, { parentId: g.id }), "FORBIDDEN");
    await drive.restore(B, x.id);
    await fails(drive.createLink(B, x.id, { role: "viewer" }), "FORBIDDEN");
    // Inside a folder where the caller has the same role everywhere, a move is fine.
    await drive.mkdir(B, `${f.id}/sub`);
    expect((await drive.move(B, x.id, `${f.id}/sub`)).parentId).not.toBe(f.id);
    // An owner of both folders may move between them.
    await drive.move(A, x.id, g.id);
    expect((await drive.move(B, x.id, f.id)).parentId).toBe(f.id);
  });
  it("counts a height from folders only, never from file pages", async () => {
    await drive.mkdir(A, "/many");
    for (let i = 0; i < 300; i++) await drive.putFile(A, `/many/f${i}.txt`, bytes("x"));
    await drive.mkdir(A, "/dest");
    let queries = 0;
    const counted = createDrive({ store: { ...store, query: async (c, q) => (queries++, store.query(c, q)) } as typeof store, blobs: createMemoryBlobs(), sharing });
    await counted.move(A, "/many", "/dest");
    expect(queries).toBeLessThan(10);
  });
  it("moves a big folder up, renames it, and restores it to its own parent", { timeout: 120_000 }, async () => {
    await drive.mkdir(A, "/up/wide", { parents: true });
    for (let i = 0; i < 201; i++) await drive.mkdir(A, `/up/wide/f${i}`);
    expect((await drive.rename(A, "/up/wide", "wider")).name).toBe("wider");
    expect((await drive.move(A, "/up/wider", "/")).parentId).toBe("root");
    await drive.trash(A, "/wider");
    const wider = (await drive.listTrash(A))[0]!;
    expect((await drive.restore(A, wider.id, { parentId: "root" })).name).toBe("wider");
  });
  it("refuses mkdir -p on an existing folder that the caller cannot read", async () => {
    const dir = await drive.mkdir(A, "/gone");
    await store.delete("resources", dir.id);
    await fails(drive.mkdir(A, "/gone", { parents: true }), "NOT_FOUND");
  });
});

describe("identity erase and kinds", () => {
  const entriesOf = async (resourceId: string) => (await store.query("audit", { where: { resourceId }, limit: 100 })).items;
  it("asks identity to erase a purged item, audit entries included", async () => {
    const file = await drive.putFile(A, "/p.txt", bytes("p"));
    await drive.shareWith(A, file.id, { kind: "human", id: "bob" }, "viewer");
    await drive.stat(B, file.id);
    expect((await entriesOf(file.id)).length).toBeGreaterThan(0);
    await drive.trash(A, file.id);
    await drive.purge(A, file.id);
    expect(await entriesOf(file.id)).toEqual([]);
    expect((await store.query("grants", { where: { resourceId: file.id } })).items).toEqual([]);
  });
  it("erases the audit entries of the drive root with the drive", async () => {
    await drive.putFile(A, "/p.txt", bytes("p"));
    const root = (await store.query("resources", { where: { type: "drive" }, limit: 5 })).items[0]!.id;
    await sharing.can(alice, "read", root);
    expect((await entriesOf(root)).length).toBeGreaterThan(0);
    await drive.deleteAll(A);
    expect(await entriesOf(root)).toEqual([]);
  });
  it("erases the audit entries of a purged folder and everything under it", async () => {
    const file = await drive.putFile(A, "/dir/sub/f.txt", bytes("f"), { parents: true });
    const ids = [file.id, file.parentId!, (await drive.stat(A, "/dir")).id];
    await drive.stat(A, file.id);
    await drive.trash(A, "/dir");
    await drive.purge(A, ids[2]!);
    for (const id of ids) expect(await entriesOf(id)).toEqual([]);
    expect((await store.query("resources", { limit: 50 })).items.map((r) => r.id)).not.toEqual(expect.arrayContaining(ids));
  });
  it("lets a purge run again after a failed transaction", async () => {
    let fail = false;
    const flaky = { ...store, transaction: ((fn: never) => (fail ? Promise.reject(new Error("transient")) : store.transaction(fn))) as typeof store.transaction } as typeof store;
    const d = createDrive({ store: flaky, blobs: createMemoryBlobs(), sharing, now: () => ++clock });
    const file = await d.putFile(A, "/r.txt", bytes("r"));
    await d.trash(A, file.id);
    fail = true;
    await expect(d.purge(A, file.id)).rejects.toThrow("transient");
    fail = false;
    expect(await d.purge(A, file.id)).toEqual({ removed: 1 });
    expect(await entriesOf(file.id)).toEqual([]);
    expect(await store.get("resources", file.id)).toBeNull();
  });
  it("finishes a purge that failed after identity erased the shares", async () => {
    let calls = 0;
    let failAt = 0;
    const flaky = { ...store, transaction: ((fn: never) => (++calls === failAt ? Promise.reject(new Error("transient")) : store.transaction(fn))) as typeof store.transaction } as typeof store;
    const d = createDrive({ store: flaky, blobs: createMemoryBlobs(), sharing, now: () => ++clock });
    const file = await d.putFile(A, "/dir/f.txt", bytes("f"), { parents: true });
    const dir = await d.stat(A, "/dir");
    await d.shareWith(A, file.id, { kind: "human", id: "bob" }, "viewer");
    await d.stat(B, file.id);
    await d.trash(A, "/dir");
    // The drive makes transaction 1 to mark the items, and transaction 2 to delete their rows. Identity runs on the plain store.
    calls = 0;
    failAt = 2;
    await expect(d.purge(A, dir.id)).rejects.toThrow("transient");
    expect((await store.query("grants", { where: { resourceId: file.id } })).items).toEqual([]);
    expect(await d.purge(A, dir.id)).toEqual({ removed: 2 });
    for (const id of [file.id, dir.id]) {
      expect(await entriesOf(id)).toEqual([]);
      expect(await store.get("resources", id)).toBeNull();
      expect(await store.get("drive_nodes", id)).toBeNull();
    }
  });
  it("does not let anyone but the person in person finish a purge that lost its sharing record", async () => {
    const file = await drive.putFile(A, "/g.txt", bytes("g"));
    await drive.trash(A, file.id);
    await store.put("drive_nodes", file.id, { ...(await store.get("drive_nodes", file.id))!, purging: true });
    await store.delete("resources", file.id);
    await fails(drive.purge(B, file.id), "NOT_FOUND");
    await fails(drive.purge(ctxOf(botOf(["drive:admin"])), file.id), "NOT_FOUND");
    expect(await drive.purge(A, file.id)).toEqual({ removed: 1 });
  });
  it("leaves a grant with no kind out of the share list, because identity does not honor it", async () => {
    const file = await drive.putFile(A, "/old.txt", bytes("o"));
    await store.put("grants", `${file.id}:carol`, { resourceId: file.id, subjectId: "carol", role: "viewer" });
    const { grants } = await drive.shares(A, file.id);
    expect(grants.map((g) => g.subjectId)).not.toContain("carol");
    await fails(drive.stat(C, file.id), "NOT_FOUND");
  });
  it("keeps a person and an agent with one id apart", async () => {
    const file = await drive.putFile(A, "/k.txt", bytes("k"));
    await drive.shareWith(A, file.id, { kind: "agent", id: "bob" }, "viewer");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    expect((await drive.shares(A, file.id)).grants).toContainEqual({ subjectKind: "agent", subjectId: "bob", role: "viewer" });
  });
  it("refuses a subject with no kind or an unknown kind", async () => {
    await drive.putFile(A, "/k.txt", bytes("k"));
    for (const subject of [{ id: "bob" }, { kind: "user_token", id: "bob" }, { kind: "robot", id: "bob" }, { kind: "human", id: "" }]) {
      await fails(drive.shareWith(A, "/k.txt", subject as never, "viewer"), "INVALID_SHARE");
      await fails(drive.unshare(A, "/k.txt", subject as never), "INVALID_SHARE");
    }
  });
  it("maps the root kinds of a chain and throws on any other kind", () => {
    expect(["human", "agent"].map(subjectKindOf)).toEqual(["human", "agent"]);
    for (const bad of [undefined, "", "robot", "Human", "user_token", "agent_of_human", "agent_of_agent"]) expect(() => subjectKindOf(bad)).toThrow(/cannot hold a role/);
  });
});

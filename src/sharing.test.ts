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
import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, it } from "vitest";
import { createDrive, type Ctx, type Drive } from "./drive.js";

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
  await drive.shareWith(A, "/team", "bob", role);
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
    await fails(drive.shareWith(B, folder.id, "carol", "viewer"), "FORBIDDEN");
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
    await fails(drive.shareWith(B, folder.id, "carol", "viewer"), "FORBIDDEN");
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
      () => drive.putFile(C, `${folder.id}/x.txt`, bytes("x")), () => drive.trash(C, file.id), () => drive.shareWith(C, folder.id, "carol", "owner"),
    ]) await fails(call(), "NOT_FOUND");
    await fails(drive.stat(C, "nope"), "NOT_FOUND");
  });
  it("gives a grant on one file to that file only", async () => {
    const one = await drive.putFile(A, "/one.txt", bytes("1"));
    const two = await drive.putFile(A, "/two.txt", bytes("2"));
    await drive.shareWith(A, one.id, "bob", "viewer");
    expect((await drive.stat(B, one.id)).name).toBe("one.txt");
    await fails(drive.stat(B, two.id), "NOT_FOUND");
    expect(await drive.list(B, "/")).toEqual([]);
  });
  it("follows an item that moves between folders", async () => {
    await drive.mkdir(A, "/open");
    await drive.mkdir(A, "/closed");
    const file = await drive.putFile(A, "/closed/f.txt", bytes("f"));
    await drive.shareWith(A, "/open", "bob", "viewer");
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
    await drive.unshare(A, "/team", "bob");
    await fails(drive.stat(B, file.id), "NOT_FOUND");
    await fails(drive.unshare(A, "/", "alice"), "INVALID_SHARE");
  });
  it("rejects a bad role and a bad subject as INVALID_SHARE", async () => {
    await drive.mkdir(A, "/x");
    await fails(drive.shareWith(A, "/x", "bob", "boss" as never), "INVALID_SHARE");
    await fails(drive.shareWith(A, "/x", "../etc", "viewer"), "INVALID_SHARE");
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
    await fails(drive.shareWith(writer, "/team", "carol", "viewer"), "FORBIDDEN");
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
    await drive.unshare(A, folder.id, "bob");
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
    expect(shown.grants).toEqual([{ subjectId: "bob", role: "viewer" }]);
    expect(shown.links).toEqual([{ id: link.id, role: "viewer", signedInOnly: false, expiresAt: null, revoked: false }]);
    expect(JSON.stringify(shown)).not.toContain(link.token);
    expect(shown.invites).toHaveLength(1);
    await fails(drive.shares(C, folder.id), "NOT_FOUND");
  });
  it("records a denied request in the audit trail, with the kind of the caller", async () => {
    const { file, folder } = await team("viewer");
    await fails(drive.putFile(B, `${folder.id}/x.txt`, bytes("x")), "FORBIDDEN");
    await fails(drive.stat(C, file.id), "NOT_FOUND");
    const entries = await sharing.listAudit(alice, folder.id);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ principalId: "bob", outcome: "denied", action: "write", principalKind: "human" })]));
    const agentCtx = ctxOf(botOf(["drive:read"]));
    await fails(drive.trash(agentCtx, file.id), "FORBIDDEN");
    expect((await sharing.listAudit(alice, file.id)).some((e) => e.principalId === "bot" && e.machineMade && e.outcome === "denied")).toBe(true);
  });
  it("deletes the shares of an item when the item is purged", async () => {
    const { file } = await team("viewer");
    await drive.shareWith(A, file.id, "carol", "viewer");
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
    await fails(plain.shareWith(A, "/x", "bob", "viewer"), "INVALID_SHARE");
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
    for (const path of ["/top.txt", "/priv/in.txt", "/team"]) await drive.shareWith(A, path, "bob", "editor");
    const ids = [await drive.stat(A, "/top.txt"), await drive.stat(A, "/priv/in.txt"), await drive.stat(A, "/team")];
    for (const [i, node] of ids.entries()) expect((await drive.rename(B, node.id, `renamed${i}`)).name).toBe(`renamed${i}`);
    expect((await drive.stat(A, "/priv/renamed1")).id).toBe(ids[1]!.id);
    await fails(drive.move(B, ids[1]!.id, (await drive.stat(A, "/priv")).id), "NOT_FOUND");
  });
  it("deletes links, invites, and every grant of a purged item", { timeout: 60_000 }, async () => {
    const file = await drive.putFile(A, "/f.txt", bytes("f"));
    for (let i = 0; i < 105; i++) await drive.shareWith(A, file.id, `friend-${i}`, "viewer");
    const link = await drive.createLink(A, file.id, { role: "viewer" });
    await drive.invite(A, file.id, { role: "viewer", email: "gone@example.com" });
    await drive.trash(A, file.id);
    await drive.purge(A, file.id);
    for (const collection of ["grants", "links", "invites", "resources"]) expect((await store.query(collection, { limit: 500 })).items.filter((e) => e.data.resourceId === file.id || e.id === file.id), collection).toEqual([]);
    await fails(drive.openShared(null, file.id, link.token), "NOT_FOUND");
  });
  it("erases the shares of the drive root too, so an old share does not reach new files", async () => {
    await drive.putFile(A, "/old.txt", bytes("o"));
    await drive.shareWith(A, "/", "bob", "viewer");
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
});

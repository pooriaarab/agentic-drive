// Failure modes first. Each case is a way app documents, export, or erase can lose, leak, or keep data.
//  1. The home view hides a reference, shows a folder, or counts a trashed item.
//  2. A document registered twice makes two items, or a bad reference or name gets in.
//  3. Forgetting a document trashes a reference of another document, or fails on one in a trashed folder.
//  4. An export misses what the person made in other drives, the shares they hold, or their audit entries,
//     or it holds a link token, an invitee email, or the data of another person.
//  5. An erase leaves the drive, its shares, a held share, or a sent invite. It erases another person's data.
//  6. An erase deletes what others own, or drops the machine label from what a machine made.
//  7. An agent, or another person, erases or exports a person.
//  8. An erase that stops halfway cannot run again.
//  9. An agent exports a person, with their audit trail from every app.
//  10. An export shows the person the current name, owner, or editor of an item they can no longer read.
//  11. An erase leaves the person's id on items from before the author ids, or on half-updated items.
//  12. An erase deletes grants and invites of other apps, and leaves a resource with no owner.
//  13. An agent of the person leaves its id behind on items, in invites, or in the audit export.
//  14. A document is registered twice because its first item is hidden, or because the folder is in another drive,
//      or because more than 100 copies of its reference sit in the trash.
import { createMemoryBlobs, createMemoryStore, createSharing, type Blobs, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, it } from "vitest";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { buildExport } from "./export.js";
import { backfillAuthorIds } from "./migrate.js";
import { readZip } from "./zip.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const principal = (id: string, kind: PrincipalContext["kind"] = "human", scopes = ["drive:admin"], chain?: PrincipalContext["chain"]): PrincipalContext => ({
  principalId: id, kind, chain: chain ?? [{ id, kind }], scopes,
});
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
const [A, B] = [ctxOf(principal("alice")), ctxOf(principal("bob"))];
const aliceBot = ctxOf(principal("bot", "agent_of_human", ["drive:admin"], [{ id: "alice", kind: "human" }, { id: "bot", kind: "agent_of_human" }]));
const bobBot = ctxOf(principal("bobbot", "agent_of_human", ["drive:write"], [{ id: "bob", kind: "human" }, { id: "bobbot", kind: "agent_of_human" }]));

let store: ReturnType<typeof createMemoryStore>;
let sharing: ReturnType<typeof createSharing>;
let drive: Drive;
let blobs: Blobs;
let breakBlobDeletes = false;
beforeEach(() => {
  store = createMemoryStore();
  sharing = createSharing(store);
  const real = createMemoryBlobs();
  breakBlobDeletes = false;
  blobs = { ...real, delete: async (key) => { if (breakBlobDeletes) throw new Error("storage 503"); await real.delete(key); } };
  drive = createDrive({ store, blobs, sharing });
});
const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
const rootOf = async (owner: string) => `drive-root-${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
const manifestOf = async (ctx: Ctx) => JSON.parse(new TextDecoder().decode(readZip(await buildExport(drive, ctx)).get("manifest.json")!));

describe("app documents", () => {
  it("lists files and every app's documents together, newest first, and filters by app", async () => {
    await drive.putFile(A, "/notes.txt", bytes("n"));
    await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" });
    await drive.registerDocument(A, { ref: "sheets:s1", name: "Budget", folder: "/Finance" });
    await drive.registerDocument(A, { ref: "docs:d2", name: "Memo", folder: "/Finance" });
    const all = await drive.home(A);
    expect(all.items.map((i) => i.node.name)).toEqual(["Memo", "Budget", "Plan", "notes.txt"]);
    expect(all.items.map((i) => i.app)).toEqual(["docs", "sheets", "docs", null]);
    expect(all.items.map((i) => i.path)).toEqual(["/Finance/Memo", "/Finance/Budget", "/Plan", "/notes.txt"]);
    expect(all.apps).toEqual({ docs: 2, sheets: 1 });
    expect(all.files).toBe(1);
    const docs = await drive.home(A, { app: "docs" });
    expect(docs.items.map((i) => i.node.name)).toEqual(["Memo", "Plan"]);
    expect(docs.apps).toEqual({ docs: 2, sheets: 1 });
    expect((await drive.search(A, { app: "sheets" })).map((r) => r.node.name)).toEqual(["Budget"]);
    expect((await drive.home(A, { limit: 1 })).items).toHaveLength(1);
    await expect(drive.home(A, { limit: 0 })).rejects.toThrow(RangeError);
  });
  it("leaves out a trashed item and an item in a trashed folder", async () => {
    await drive.registerDocument(A, { ref: "docs:d1", name: "Plan", folder: "/Old" });
    await drive.registerDocument(A, { ref: "docs:d2", name: "Memo" });
    await drive.trash(A, "/Old");
    expect((await drive.home(A)).items.map((i) => i.node.name)).toEqual(["Memo"]);
    await drive.trash(A, "/Memo");
    expect((await drive.home(A)).apps).toEqual({});
  });
  it("returns the item of a document that is already registered, and renames a clash", async () => {
    const first = await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" });
    expect((await drive.registerDocument(A, { ref: "docs:d1", name: "Other name", folder: "/Else" })).id).toBe(first.id);
    const clash = await drive.registerDocument(A, { ref: "docs:d2", name: "Plan" });
    expect(clash.name).toBe("Plan (2)");
    expect(clash.kind).toBe("ref");
    expect(clash.ref).toBe("docs:d2");
  });
  it("keeps drives apart: the same document in two drives is two items", async () => {
    const [a, b] = [await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" }), await drive.registerDocument(B, { ref: "docs:d1", name: "Plan" })];
    expect(a.id).not.toBe(b.id);
    expect((await drive.home(B)).items.map((i) => i.node.owner)).toEqual(["bob"]);
  });
  it("does not return an item that a trashed folder hides, and registers the document again", async () => {
    const hidden = await drive.registerDocument(A, { ref: "docs:d1", name: "Plan", folder: "/Old" });
    await drive.trash(A, "/Old");
    const again = await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" });
    expect(again.id).not.toBe(hidden.id);
    expect((await drive.home(A)).items.map((i) => i.node.id)).toEqual([again.id]);
  });
  it("registers into a folder of another drive once, and finds it by the owner of that folder", async () => {
    await drive.mkdir(B, "/shared");
    const folder = await drive.stat(B, "/shared");
    await drive.shareWith(B, "/shared", "alice", "editor");
    const first = await drive.registerDocument(A, { ref: "docs:d1", name: "Plan", folder: folder.id });
    const second = await drive.registerDocument(A, { ref: "docs:d1", name: "Plan", folder: folder.id });
    expect(second.id).toBe(first.id);
    expect(first.owner).toBe("bob");
    await fails(drive.registerDocument(A, { ref: "docs:d2", name: "x", folder: "no-such-folder" }), "NOT_FOUND");
  });
  it("finds a document among more than 100 trashed copies of its reference", { timeout: 120_000 }, async () => {
    for (let i = 0; i < 101; i++) {
      await drive.putRef(A, `/old${i}`, "docs:busy");
      await drive.trash(A, `/old${i}`);
    }
    const live = await drive.registerDocument(A, { ref: "docs:busy", name: "Live" });
    expect((await drive.registerDocument(A, { ref: "docs:busy", name: "Again" })).id).toBe(live.id);
    expect(await drive.forgetDocument(A, "docs:busy")).toEqual({ trashed: 1 });
  });
  it("refuses a bad reference or a name with a slash", async () => {
    for (const ref of ["", "docs", "Docs:1", "docs:a/b", "docs:a b", "1docs:x"]) await fails(drive.registerDocument(A, { ref, name: "x" }), "INVALID_REF");
    for (const name of ["a/b", "", "..", "x\u0000y"]) await fails(drive.registerDocument(A, { ref: "docs:ok", name }), "INVALID_NAME");
    await fails(drive.forgetDocument(A, "nope"), "INVALID_REF");
    expect((await drive.home(A)).items).toEqual([]);
  });
  it("refuses an agent without a drive scope", async () => {
    const stray = ctxOf(principal("stray", "agent_of_human", ["docs:write"], [{ id: "alice", kind: "human" }, { id: "stray", kind: "agent_of_human" }]));
    await fails(drive.registerDocument(stray, { ref: "docs:x", name: "x" }), "FORBIDDEN");
    await fails(drive.home(stray), "FORBIDDEN");
    const reader = ctxOf(principal("reader", "agent_of_human", ["drive:read"], [{ id: "alice", kind: "human" }, { id: "reader", kind: "agent_of_human" }]));
    await fails(drive.registerDocument(reader, { ref: "docs:x", name: "x" }), "FORBIDDEN");
  });
  it("trashes every reference to a forgotten document, and no other", async () => {
    await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" });
    await drive.registerDocument(A, { ref: "docs:d2", name: "Memo" });
    await drive.mkdir(A, "/more");
    await drive.putRef(A, "/more/again", "docs:d1");
    await drive.putRef(A, "/hidden", "docs:d1", { onConflict: "rename" });
    await drive.trash(A, "/more");
    expect(await drive.forgetDocument(A, "docs:d1")).toEqual({ trashed: 2 });
    expect((await drive.home(A)).items.map((i) => i.node.ref)).toEqual(["docs:d2"]);
    expect(await drive.forgetDocument(A, "docs:d1")).toEqual({ trashed: 0 });
  });
});

describe("export and erase of a person", () => {
  /** Bob shares /team with Alice as editor. Alice writes there, holds the share, and sent an invite. */
  async function setup() {
    await drive.putFile(B, "/team/b.txt", bytes("b"), { parents: true });
    const team = await drive.stat(B, "/team");
    await drive.shareWith(B, "/team", "alice", "editor");
    await drive.putFile(A, "/mine/a.txt", bytes("alice file"), { parents: true });
    await drive.registerDocument(A, { ref: "docs:d1", name: "Plan" });
    const byAlice = await drive.putFile(A, `${team.id}/from-alice.txt`, bytes("x"));
    const byBot = await drive.putFile(aliceBot, `${team.id}/from-bot.txt`, bytes("y"));
    await drive.shareWith(A, "/mine", "bob", "viewer");
    const invite = await drive.invite(A, "/mine", { role: "viewer", email: "friend@example.com" });
    const link = await drive.createLink(A, "/mine", { role: "viewer" });
    await drive.rename(B, byAlice.id, "renamed-by-bob.txt");
    return { team, byAlice, byBot, invite, link };
  }
  it("exports the person, what they made elsewhere, their shares and invites, and their audit entries", async () => {
    const { team, byAlice, byBot, invite, link } = await setup();
    const manifest = await manifestOf(A);
    expect(manifest).toMatchObject({ format: "agentic-drive-export", version: 2, owner: "alice", subject: { id: "alice", kind: "human" } });
    expect(manifest.items.map((i: { name: string }) => i.name).sort()).toEqual(["Plan", "a.txt", "mine"]);
    expect(manifest.authored.map((a: { id: string }) => a.id)).toEqual([byAlice.id]);
    expect(manifest.authored[0]).toMatchObject({ kind: "file", created: true, updated: false, by: [{ id: "alice", kind: "human" }] });
    // Nothing about the owner of the item or its current name: only what the person wrote.
    expect(Object.keys(manifest.authored[0]).sort()).toEqual(["by", "created", "createdAt", "id", "kind", "updated", "updatedAt"]);
    expect(JSON.stringify(manifest.authored)).not.toContain("bob");
    expect(manifest.shares.held).toEqual(expect.arrayContaining([{ resourceId: team.id, role: "editor" }]));
    expect(manifest.shares.invitesCreated).toEqual([expect.objectContaining({ id: invite.id, role: "viewer", accepted: false })]);
    expect(manifest.audit.length).toBeGreaterThan(0);
    expect(manifest.audit.every((e: { principalKind: string }) => e.principalKind === "human")).toBe(true);
    const text = JSON.stringify(manifest);
    for (const secret of [link.token, "friend@example.com", "renamed-by-bob", byBot.id]) expect(text).not.toContain(secret);
    expect(text).not.toContain("tokenHash");
  });
  it("exports an agent's work under its person, and nothing of another person", async () => {
    const { byBot } = await setup();
    const forBob = await manifestOf(B);
    expect(forBob.subject).toEqual({ id: "bob", kind: "human" });
    expect(forBob.items.map((i: { name: string }) => i.name).sort()).toEqual(["b.txt", "from-alice.txt", "from-bot.txt", "team"].map((n) => (n === "from-alice.txt" ? "renamed-by-bob.txt" : n)).sort());
    expect(JSON.stringify(forBob)).not.toContain("alice file");
    expect(forBob.authored.map((a: { id: string }) => a.id)).toEqual([]);
    expect(byBot.createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
  });
  it("erases the person, and only the person", async () => {
    const { team, byAlice, byBot, invite, link } = await setup();
    await fails(drive.erasePerson(aliceBot), "FORBIDDEN");
    await fails(drive.erasePerson({ ...A, actor: { id: "alice", kind: "agent" } }), "FORBIDDEN");
    const result = await drive.erasePerson(A);
    // Three items of Alice's own went with her drive. She held one share, and made one item in Bob's folder.
    expect(result).toMatchObject({ removed: 3, grants: 1, anonymized: 1 });
    // Alice's drive and its shares are gone. Read the store first: a call by Alice would make her root again.
    expect((await store.query("drive_nodes", { where: { owner: "alice" } })).items).toEqual([]);
    expect((await store.query("invites", { limit: 10 })).items).toEqual([]);
    expect((await store.query("links", { limit: 10 })).items).toEqual([]);
    expect((await store.query("grants", { where: { subjectId: "alice" } })).items).toEqual([]);
    expect((await store.query("resources", { where: { type: "drive" }, limit: 50 })).items.map((r) => r.id)).not.toContain(await rootOf("alice"));
    expect((await drive.home(A)).items).toEqual([]);
    await fails(drive.openShared(null, byAlice.id, link.token), "NOT_FOUND");
    expect(invite.id).toBeTruthy();
    // What Bob owns stays whole. Alice's id is gone from it, and the machine label stays.
    expect((await drive.list(B, team.id)).map((n) => n.name).sort()).toEqual(["b.txt", "from-bot.txt", "renamed-by-bob.txt"]);
    const bobsFile = await drive.stat(B, byAlice.id);
    expect(bobsFile.createdBy).toEqual({ id: "erased", kind: "human" });
    expect(bobsFile.updatedBy).toEqual({ id: "bob", kind: "human" });
    const botsFile = await drive.stat(B, byBot.id);
    expect(botsFile.createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
    expect((await drive.read(B, "/team/b.txt")).data).toEqual(bytes("b"));
    // Bob's share of Alice's folder went with it, and Alice lost her share of Bob's folder.
    await fails(drive.stat(A, team.id), "NOT_FOUND");
  });
  it("keeps what an agent of the erased person made in another drive, with its machine label", async () => {
    await drive.putFile(A, "/mine/a.txt", bytes("a"), { parents: true });
    const mine = await drive.stat(A, "/mine");
    await drive.shareWith(A, "/mine", "bob", "editor");
    const byBob = await drive.putFile(B, `${mine.id}/by-bob.txt`, bytes("1"));
    const byBobBot = await drive.putFile(bobBot, `${mine.id}/by-bobbot.txt`, bytes("2"));
    await drive.erasePerson(B);
    expect((await drive.stat(A, byBob.id)).createdBy).toEqual({ id: "erased", kind: "human" });
    // The agent is not known as an agent of Bob here, so its id stays. The next test shows the known case.
    expect((await drive.stat(A, byBobBot.id)).createdBy).toEqual({ id: "bobbot", kind: "agent_of_human" });
    expect((await drive.list(A, mine.id)).map((n) => n.name).sort()).toEqual(["a.txt", "by-bob.txt", "by-bobbot.txt"]);
  });
  it("lets a person start again after an erase, with no old share", async () => {
    await setup();
    await drive.erasePerson(A);
    const fresh = await drive.putFile(A, "/fresh.txt", bytes("f"));
    await fails(drive.stat(B, fresh.id), "NOT_FOUND");
    expect((await drive.home(A)).items.map((i) => i.node.name)).toEqual(["fresh.txt"]);
  });
  it("runs again after a failed erase and then finishes", async () => {
    const { byAlice } = await setup();
    breakBlobDeletes = true;
    await expect(drive.erasePerson(A)).rejects.toThrow("storage 503");
    expect((await store.query("invites", { limit: 10 })).items).toHaveLength(1);
    breakBlobDeletes = false;
    await drive.erasePerson(A);
    expect((await store.query("invites", { limit: 10 })).items).toEqual([]);
    expect((await drive.stat(B, byAlice.id)).createdBy.id).toBe("erased");
    expect(await drive.erasePerson(A)).toMatchObject({ removed: 0, grants: 0, invites: 0, anonymized: 0 });
  });
  it("gives an agent no part of the person's export beyond the drive itself", async () => {
    await setup();
    const forBot = await manifestOf(aliceBot);
    expect(forBot).toMatchObject({ partial: true, subject: { id: "alice", kind: "human" }, authored: [], shares: { held: [], invitesCreated: [] }, audit: [] });
    const reader = ctxOf(principal("readbot", "agent_of_human", ["drive:read"], [{ id: "alice", kind: "human" }, { id: "readbot", kind: "agent_of_human" }]));
    await sharing.can(A.principal!, "read", "docs-doc");
    expect((await drive.exportPerson(reader)).audit).toEqual([]);
    expect((await manifestOf(A)).partial).toBe(false);
  });
  it("shows no item the person can no longer read, and no name or owner", async () => {
    const { team, byAlice } = await setup();
    await drive.unshare(B, "/team", "alice");
    await drive.rename(B, byAlice.id, "bob-secret-plans.txt");
    await fails(drive.stat(A, byAlice.id), "NOT_FOUND");
    const text = JSON.stringify((await manifestOf(A)).authored);
    expect(text).not.toContain("bob-secret-plans");
    expect(text).not.toContain("bob");
    expect(team.id).toBeTruthy();
  });
  it("finds and anonymizes items from before the author ids, and a backfill makes them findable", async () => {
    const { team, byAlice } = await setup();
    const old = (await store.get("drive_nodes", byAlice.id))!;
    const { createdById: _c, updatedById: _u, ...rest } = old;
    await store.put("drive_nodes", byAlice.id, rest);
    expect((await manifestOf(A)).authored).toEqual([]);
    expect(await backfillAuthorIds(store)).toEqual({ fixed: expect.any(Number) });
    expect((await manifestOf(A)).authored.map((a: { id: string }) => a.id)).toEqual([byAlice.id]);
    expect(await backfillAuthorIds(store)).toEqual({ fixed: 0 });
    // A half-updated item: made before the ids, changed after, with only the updated id set.
    await store.put("drive_nodes", byAlice.id, { ...rest, updatedById: "alice" });
    await drive.erasePerson(A);
    const after = await drive.stat(B, byAlice.id);
    expect(after.createdBy.id).toBe("erased");
    expect(after.createdById).toBe("erased");
    expect(team.id).toBeTruthy();
  });
  it("sets both author ids on an item from before them when anyone changes it", async () => {
    const { byBot } = await setup();
    const old = (await store.get("drive_nodes", byBot.id))!;
    const { createdById: _c, updatedById: _u, ...rest } = old;
    await store.put("drive_nodes", byBot.id, rest);
    await drive.rename(B, byBot.id, "again.txt");
    expect(await store.get("drive_nodes", byBot.id)).toMatchObject({ createdById: "bot", updatedById: "bob" });
  });
  it("leaves the grants, invites, and owners of other apps alone", async () => {
    const wide = ctxOf(principal("alice", "human", ["*:admin"]));
    await drive.putFile(A, "/mine.txt", bytes("m"));
    await sharing.createResource(wide.principal!, { id: "doc-1", type: "docs" });
    await sharing.grant(wide.principal!, "doc-1", "bob", "editor");
    await sharing.createInvite(wide.principal!, "doc-1", { role: "viewer", email: "x@example.com" });
    await drive.erasePerson(A);
    expect((await store.get("resources", "doc-1"))?.type).toBe("docs");
    expect((await store.query("grants", { where: { resourceId: "doc-1" } })).items.map((g) => g.data.subjectId).sort()).toEqual(["alice", "bob"]);
    expect((await store.query("invites", { where: { resourceId: "doc-1" } })).items).toHaveLength(1);
  });
  it("treats the agents of a person as part of the person on export and erase", async () => {
    await store.put("principals", "bot", { id: "bot", kind: "agent_of_human", parentId: "alice", scopes: ["drive:admin"] });
    const { team, byBot } = await setup();
    await drive.invite(aliceBot, "/mine", { role: "viewer", handle: "someone" });
    const manifest = await manifestOf(A);
    expect(manifest.authored.map((a: { id: string }) => a.id).sort()).toEqual([byBot.id, (await store.query("drive_nodes", { where: { createdById: "alice", parentId: team.id } })).items[0]!.id].sort());
    expect(manifest.audit.some((e: { principalId: string }) => e.principalId === "bot")).toBe(true);
    expect(manifest.shares.invitesCreated).toHaveLength(2);
    await drive.erasePerson(A);
    const botsFile = await drive.stat(B, byBot.id);
    expect(botsFile.createdBy).toEqual({ id: "erased", kind: "agent_of_human" });
    expect((await store.query("invites", { limit: 10 })).items).toEqual([]);
  });
  it("works on a local drive with no sharing", async () => {
    const local = createDrive({ store: createMemoryStore(), blobs: createMemoryBlobs() });
    const me: Ctx = { owner: "me", actor: { id: "me", kind: "human" } };
    await local.putFile(me, "/a.txt", bytes("a"));
    await local.registerDocument(me, { ref: "docs:1", name: "Doc" });
    expect((await local.exportPerson(me)).subject).toEqual({ id: "me", kind: "human" });
    const agent: Ctx = { owner: "me", actor: { id: "bot", kind: "agent_of_human" } };
    expect((await local.exportPerson(agent)).subject).toEqual({ id: "me", kind: null });
    await fails(local.erasePerson(agent), "FORBIDDEN");
    expect(await local.erasePerson(me)).toMatchObject({ removed: 2 });
  });
});

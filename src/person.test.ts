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
import { createMemoryBlobs, createMemoryStore, createSharing, type Blobs, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, it } from "vitest";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { buildExport } from "./export.js";
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
    await fails(drive.home(A, { limit: 0 }) as Promise<never>, "x").catch(() => undefined);
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
    expect(manifest.authored[0]).toMatchObject({ owner: "bob", name: "renamed-by-bob.txt", createdBy: { id: "alice", kind: "human" }, updatedBy: { id: "bob" } });
    expect(manifest.shares.held).toEqual(expect.arrayContaining([{ resourceId: team.id, role: "editor" }]));
    expect(manifest.shares.invitesCreated).toEqual([expect.objectContaining({ id: invite.id, role: "viewer", accepted: false })]);
    expect(manifest.audit.length).toBeGreaterThan(0);
    expect(manifest.audit.every((e: { principalKind: string }) => e.principalKind === "human")).toBe(true);
    const text = JSON.stringify(manifest);
    for (const secret of [link.token, "friend@example.com", "bob/", byBot.id]) expect(text).not.toContain(secret);
    expect(text).not.toContain("tokenHash");
  });
  it("exports an agent's work under its person, and nothing of another person", async () => {
    const { byBot } = await setup();
    const forBob = await manifestOf(B);
    expect(forBob.subject).toEqual({ id: "bob", kind: "human" });
    expect(forBob.items.map((i: { name: string }) => i.name).sort()).toEqual(["b.txt", "from-alice.txt", "from-bot.txt", "team"].map((n) => (n === "from-alice.txt" ? "renamed-by-bob.txt" : n)).sort());
    expect(JSON.stringify(forBob)).not.toContain("alice file");
    expect(forBob.authored.map((a: { id: string }) => a.id)).toEqual([]);
    const botExport = await drive.exportPerson(aliceBot);
    expect(botExport.subject).toEqual({ id: "alice", kind: "human" });
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

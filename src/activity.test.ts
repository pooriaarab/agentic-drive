// The activity log: one entry per change, with who made it. Each case names a way the log can lie or leak.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { createDrive, type Ctx } from "./drive.js";
import { buildExport } from "./export.js";
import { readZip } from "./zip.js";
import { createApp } from "./worker.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const human: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const bot: Ctx = { owner: "u1", actor: { id: "bot", kind: "agent_of_human" } };
const stranger: Ctx = { owner: "u2", actor: { id: "u2", kind: "human" } };

function setup() {
  const store = createMemoryStore();
  let clock = 1000;
  return { store, drive: createDrive({ store, blobs: createMemoryBlobs(), now: () => ++clock }) };
}
const actions = (entries: { action: string }[]) => entries.map((e) => e.action);

describe("activity log", () => {
  it("records each kind of change, newest first, with the actor kind", async () => {
    const { drive } = setup();
    await drive.mkdir(human, "/docs");
    const file = await drive.putFile(human, "/docs/a.txt", bytes("one"));
    await drive.putFile(bot, "/docs/a.txt", bytes("two"), { onConflict: "replace" });
    await drive.rename(bot, file.id, "b.txt");
    await drive.move(human, file.id, "/");
    await drive.trash(bot, file.id);
    await drive.restore(human, file.id);
    const log = await drive.listActivity(human, file.id);
    expect(actions(log)).toEqual(["restore", "delete", "move", "rename", "update", "create"]);
    expect(log.map((e) => e.actor.kind)).toEqual(["human", "agent", "human", "agent", "agent", "human"]);
    expect(log[1]).toMatchObject({ actor: { id: "bot", kind: "agent" }, principalKind: "agent_of_human", itemId: file.id });
    expect(log[3]!.detail).toEqual({ from: "a.txt", to: "b.txt" });
  });

  it("labels a later change by an agent to an item that a person made", async () => {
    const { drive } = setup();
    const file = await drive.putFile(human, "/n.txt", bytes("x"));
    await drive.rename(bot, file.id, "m.txt");
    const [last, first] = await drive.listActivity(human, file.id);
    expect(last).toMatchObject({ action: "rename", actor: { kind: "agent" } });
    expect(first).toMatchObject({ action: "create", actor: { kind: "human" } });
  });

  it("treats every non-person principal as an agent", async () => {
    const { drive } = setup();
    const viaToken: Ctx = { owner: "u1", actor: { id: "u1", kind: "user_token" } };
    const file = await drive.putFile(viaToken, "/t.txt", bytes("x"));
    expect((await drive.listActivity(human, file.id))[0]!.actor.kind).toBe("agent");
  });

  it("keeps a failed change out of the log", async () => {
    const { drive } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await drive.putFile(human, "/b.txt", bytes("y"));
    await expect(drive.rename(human, file.id, "b.txt")).rejects.toMatchObject({ code: "NAME_TAKEN" });
    expect(actions(await drive.listActivity(human, file.id))).toEqual(["create"]);
  });

  it("hides the log from a caller who cannot read the item", async () => {
    const { drive } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await expect(drive.listActivity(stranger, file.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("limits the entries and rejects a bad limit", async () => {
    const { drive } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await drive.rename(human, file.id, "b.txt");
    expect(actions(await drive.listActivity(human, file.id, { limit: 1 }))).toEqual(["rename"]);
    await expect(drive.listActivity(human, file.id, { limit: 0 })).rejects.toThrow(RangeError);
  });

  it("reads the log of a trashed item by id, and deletes it with the item on purge", async () => {
    const { drive, store } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await drive.trash(human, file.id);
    expect(actions(await drive.listActivity(human, file.id))).toEqual(["delete", "create"]);
    await drive.purge(human, file.id);
    expect((await store.query("drive_activity", { where: { itemId: file.id }, limit: 10 })).items).toEqual([]);
  });

  it("records a share and an unshare", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
    const p: PrincipalContext = { principalId: "u1", kind: "human", chain: [{ id: "u1", kind: "human" }], scopes: ["drive:admin"] };
    const ctx: Ctx = { ...human, principal: p };
    const file = await drive.putFile(ctx, "/a.txt", bytes("x"));
    await drive.shareWith(ctx, file.id, { kind: "human", id: "u2" }, "viewer");
    await drive.unshare(ctx, file.id, { kind: "human", id: "u2" });
    const log = await drive.listActivity(ctx, file.id);
    expect(actions(log)).toEqual(["unshare", "share", "create"]);
    expect(log[1]!.detail).toEqual({ subjectKind: "human", subjectId: "u2", role: "viewer" });
  });

  it("keeps the roots of two drives apart, and removes the root log with the drive", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
    const ctxOf = (id: string): Ctx => ({ owner: id, actor: { id, kind: "human" }, principal: { principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] } });
    await drive.shareWith(ctxOf("ann"), "/", { kind: "human", id: "carol" }, "editor");
    expect(actions(await drive.listActivity(ctxOf("ann"), "/"))).toEqual(["share"]);
    expect(await drive.listActivity(ctxOf("eve"), "/")).toEqual([]);
    await drive.deleteAll(ctxOf("ann"));
    expect((await store.query("drive_activity", { where: { itemId: "root" }, limit: 10 })).items).toEqual([]);
  });

  it("writes no audit entry when it decides what to show", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
    const p = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] });
    const ann: Ctx = { owner: "ann", actor: { id: "ann", kind: "human" }, principal: p("ann") };
    const bob: Ctx = { owner: "bob", actor: { id: "bob", kind: "human" }, principal: p("bob") };
    const file = await drive.putFile(ann, "/a.txt", bytes("x"));
    await drive.shareWith(ann, file.id, { kind: "human", id: "bob" }, "viewer");
    await drive.listActivity(bob, file.id);
    const audit = (await store.query("audit", { where: { principalId: "bob" }, limit: 50 })).items.map((e) => e.data.action);
    expect(audit).not.toContain("admin");
  });

  it("shows who got a role to an owner only", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
    const ctxOf = (id: string): Ctx => ({ owner: id === "bob" ? "u1" : id, actor: { id, kind: "human" }, principal: { principalId: id, kind: "human", chain: [{ id: id === "bob" ? "u1" : id, kind: "human" }], scopes: ["drive:admin"] } });
    const bobAsReader: Ctx = { owner: "u2", actor: { id: "bob", kind: "human" }, principal: { principalId: "bob", kind: "human", chain: [{ id: "bob", kind: "human" }], scopes: ["drive:admin"] } };
    const ann = ctxOf("u1");
    const file = await drive.putFile(ann, "/g.txt", bytes("x"));
    await drive.shareWith(ann, file.id, { kind: "human", id: "bob" }, "viewer");
    await drive.shareWith(ann, file.id, { kind: "human", id: "dave" }, "editor");
    const seen = await drive.listActivity({ ...bobAsReader, owner: "bob" }, file.id);
    expect(actions(seen)).toEqual(["share", "share", "create"]);
    expect(seen[0]).not.toHaveProperty("detail");
    expect((await drive.listActivity(ann, file.id))[0]!.detail).toMatchObject({ subjectId: "dave", role: "editor" });
  });

  it("refuses a change by an actor with no valid kind, and labels a stored bad kind as a machine", async () => {
    const { drive, store } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await expect(drive.rename({ owner: "u1", actor: { id: "u1", kind: "Human" as never } }, file.id, "b.txt")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(actions(await drive.listActivity(human, file.id))).toEqual(["create"]);
    const [stored] = (await store.query("drive_activity", { where: { itemId: file.id }, limit: 1 })).items;
    await store.put("drive_activity", stored!.id, { ...stored!.data, principalKind: "weird", actor: { id: "u1", kind: "human" } });
    // A kind that is not a principal kind is not turned into one: the entry is left out.
    expect(await drive.listActivity(human, file.id)).toEqual([]);
    await store.put("drive_activity", stored!.id, { ...stored!.data, principalKind: "agent_of_human", actor: { id: "u1", kind: "human" } });
    expect((await drive.listActivity(human, file.id))[0]).toMatchObject({ actor: { kind: "agent" }, principalKind: "agent_of_human" });
    await store.put("drive_activity", "broken", { id: "broken", itemId: file.id, owner: "u1", at: 5, action: "create" });
    await store.put("drive_activity", "odd", { id: "odd", itemId: file.id, owner: "u1", at: 6, action: "format-disk", actor: { id: "x", kind: "human" }, principalKind: "human" });
    expect(await drive.listActivity(human, file.id)).toHaveLength(1);
  });

  it("logs a role by claimRef and by invite, and no unshare of a role nobody held", async () => {
    const store = createMemoryStore();
    const drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
    const p = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] });
    const ann: Ctx = { owner: "ann", actor: { id: "ann", kind: "human" }, principal: p("ann") };
    const bob: Ctx = { owner: "bob", actor: { id: "bob", kind: "human" }, principal: p("bob") };
    const ref = await drive.claimRef(ann, "/c", "docs:c1", { subject: { kind: "human", id: "bob" }, role: "editor" });
    expect((await drive.listActivity(ann, ref.id))[0]).toMatchObject({ action: "share", detail: { subjectId: "bob", role: "editor" } });
    const file = await drive.putFile(ann, "/f.txt", bytes("x"));
    const invite = await drive.invite(ann, file.id, { role: "viewer", email: "bob@example.com" });
    await drive.acceptInvite(bob, invite.id, { email: "bob@example.com" });
    expect((await drive.listActivity(ann, file.id))[0]).toMatchObject({ action: "share", actor: { id: "bob" }, detail: { subjectId: "bob", role: "viewer" } });
    await drive.unshare(ann, file.id, { kind: "human", id: "nobody" });
    expect(actions(await drive.listActivity(ann, file.id))).toEqual(["share", "create"]);
  });

  it("keeps names out of the export for a drive that the person does not own", async () => {
    const { drive } = setup();
    const theirs = await drive.putFile(stranger, "/secret-name.txt", bytes("x"));
    const visitor: Ctx = { owner: "u2", actor: { id: "u1", kind: "human" } };
    await drive.rename(visitor, theirs.id, "other-secret.txt");
    await drive.putFile(human, "/mine.txt", bytes("y"));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(await buildExport(drive, human)).get("manifest.json")!));
    const foreign = manifest.activity.find((e: { itemId: string }) => e.itemId === theirs.id);
    expect(foreign).toMatchObject({ action: "rename", actor: { id: "u1", kind: "human" } });
    expect(foreign).not.toHaveProperty("detail");
    expect(manifest.activity.find((e: { itemId: string }) => e.itemId !== theirs.id).detail).toMatchObject({ name: "mine.txt" });
  });

  it("puts the activity of the actor in the export, with the kind", async () => {
    const { drive } = setup();
    const file = await drive.putFile(human, "/a.txt", bytes("x"));
    await drive.rename(human, file.id, "b.txt");
    const manifest = JSON.parse(new TextDecoder().decode(readZip(await buildExport(drive, human)).get("manifest.json")!));
    expect(manifest.activity.map((e: { action: string }) => e.action)).toEqual(["create", "rename"]);
    expect(manifest.activity[0]).toMatchObject({ itemId: file.id, actor: { id: "u1", kind: "human" } });
    expect(manifest.activity[0]).not.toHaveProperty("actorId");
  });

  it("keeps the agent label but drops the id when a person is erased", async () => {
    const { drive, store } = setup();
    await store.put("principals", "u1", { id: "u1", kind: "human" });
    await store.put("principals", "bot9", { id: "bot9", kind: "agent_of_human", parentId: "u1" });
    const theirs = await drive.putFile(stranger, "/shared.txt", bytes("x"));
    // u1 and an agent of u1 change an item in the drive of u2.
    await drive.rename({ owner: "u2", actor: { id: "bot9", kind: "agent_of_human" } }, theirs.id, "a.txt");
    await drive.rename({ owner: "u2", actor: { id: "u1", kind: "human" } }, theirs.id, "b.txt");
    // A share entry that names the person, and one that names an agent with the same id.
    const named = (id: string, kind: string) => store.put("drive_activity", id, { id, itemId: theirs.id, owner: "u2", at: id === "s1" ? 50 : 51, action: "share", actor: { id: "u2", kind: "human" }, actorId: "u2", principalKind: "human", subjectId: "u1", subjectKind: kind, detail: { subjectId: "u1", subjectKind: kind, role: "viewer" } });
    await named("s1", "human");
    await named("s2", "agent");
    await drive.erasePerson(human);
    const shares = (await drive.listActivity(stranger, theirs.id)).filter((e) => e.action === "share").map((e) => e.detail!.subjectId);
    expect(shares).toEqual(["u1", "erased"]);
    const log = (await drive.listActivity(stranger, theirs.id)).filter((e) => e.action !== "share");
    expect(log.map((e) => e.actor)).toEqual([{ id: "erased", kind: "human" }, { id: "erased", kind: "agent" }, { id: "u2", kind: "human" }]);
  });
});

describe("HTTP", () => {
  const principal = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["drive:admin"] });
  const app = createApp({
    store: createMemoryStore(), blobs: createMemoryBlobs(),
    auth: (r) => {
      const who = r.headers.get("x-user");
      return who ? { owner: who, actor: { id: who, kind: "human" }, principal: principal(who) } : null;
    },
  });
  const call = (path: string, init: RequestInit = {}, user = "ann") =>
    app.fetch(new Request(`http://x/api/v1/drive${path}`, { ...init, headers: { "x-user": user } }), {} as never);

  it("answers GET /items/:id/activity and 404s for a stranger", async () => {
    const made = (await (await call("/files?path=/a.txt", { method: "PUT", body: "x" })).json()) as { id: string };
    await call("/move", { method: "POST", body: JSON.stringify({ src: made.id, folder: "/", name: "b.txt" }) });
    const res = await call(`/items/${made.id}/activity`);
    expect(res.status).toBe(200);
    const log = (await res.json()) as { action: string; actor: { id: string; kind: string } }[];
    expect(log.map((e) => e.action)).toEqual(["rename", "create"]);
    expect(log[0]!.actor).toEqual({ id: "ann", kind: "human" });
    expect(log[0]).not.toHaveProperty("actorId");
    expect(((await (await call(`/items/${made.id}/activity?limit=1`)).json()) as unknown[]).length).toBe(1);
    expect((await call(`/items/${made.id}/activity`, {}, "bob")).status).toBe(404);
    expect((await call("/items/activity-of-nothing/activity")).status).toBe(404);
    expect((await call(`/items/${made.id}/activity?limit=0`)).status).toBe(400);
    expect((await call(`/items/${made.id}/activity?limit=1.5`)).status).toBe(400);
    expect((await app.fetch(new Request(`http://x/api/v1/drive/items/${made.id}/activity`), {} as never)).status).toBe(401);
  });
});

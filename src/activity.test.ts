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
    await drive.erasePerson(human);
    const log = await drive.listActivity(stranger, theirs.id);
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
    expect((await app.fetch(new Request(`http://x/api/v1/drive/items/${made.id}/activity`), {} as never)).status).toBe(401);
  });
});

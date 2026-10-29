// Failure cases for the account contract, written before the code.
//  1. A bad subject, or a context for someone else, is refused: it would export or erase another drive.
//  2. Export holds the subject's own data in every collection, as plain JSON, and none of another person's.
//  3. Export keeps no storage keys, and holds the bytes as base64.
//  4. Erase removes the drive, held grants, and sent invites, and anonymises what the subject made elsewhere.
//  5. A second erase counts zero. An agent subject cannot erase.
import { createMemoryBlobs, createSharing, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, it } from "vitest";
import { driveAccount } from "./account.js";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { backend } from "./test-backend.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const principal = (id: string, kind: PrincipalContext["kind"] = "human", chain?: PrincipalContext["chain"]): PrincipalContext => ({ principalId: id, kind, chain: chain ?? [{ id, kind }], scopes: ["drive:admin"] });
const ctxOf = (p: PrincipalContext): Ctx => ({ owner: p.chain[0]!.id, actor: { id: p.principalId, kind: p.kind }, principal: p });
const [A, B] = [ctxOf(principal("alice")), ctxOf(principal("bob"))];
const ALICE = { id: "alice", kind: "human" as const };
const BOT = ctxOf(principal("bot", "agent_of_human", [{ id: "alice", kind: "human" }, { id: "bot", kind: "agent_of_human" }]));
const OWN = ctxOf(principal("robo", "agent"));
const ROBO = { id: "robo", kind: "agent" as const };

let drive: Drive;
let store: ReturnType<typeof backend.store>;
beforeEach(() => {
  store = backend.store();
  drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
});
const rowsIn = async (collection: string) => (await store.query(collection, { where: {}, limit: 1000 })).items.length;
const deps = (ctx: Ctx) => ({ drive, ctx });

async function seed() {
  await drive.putFile(A, "/mine/a.txt", bytes("alice file"), { parents: true });
  await drive.putFile(A, "/gone.txt", bytes("x"));
  await drive.trash(A, "/gone.txt");
  await drive.mkdir(B, "/team");
  const team = await drive.stat(B, "/team");
  await drive.putFile(B, "/b.txt", bytes("bob secret"));
  await drive.shareWith(B, "/team", { kind: "human", id: "alice" }, "editor");
  await drive.putFile(A, `${team.id}/by-alice.txt`, bytes("1"));
  await drive.invite(A, "/mine", { role: "viewer", email: "x@example.com" });
  return team;
}

describe("subject", () => {
  it("refuses a bad subject and a context for someone else", async () => {
    for (const bad of [{ id: "", kind: "human" }, { id: "alice" }, { id: "alice", kind: "wizard" }, { id: "alice", kind: "agent_of_human" }, { id: "alice", kind: "user_token" }, null]) {
      await expect(driveAccount.exportAccount(bad as never, deps(A))).rejects.toThrow(TypeError);
      await expect(driveAccount.eraseAccount(bad as never, deps(A))).rejects.toThrow(TypeError);
    }
    await expect(driveAccount.exportAccount(ALICE, deps(B))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, deps(BOT))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Same owner and actor, but the principal runs through an agent: a whole export would look partial, so it is refused.
    const VIA_BOT = { ...A, principal: BOT.principal };
    await expect(driveAccount.exportAccount(ALICE, deps(VIA_BOT))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, deps(VIA_BOT))).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A principal with two links, or whose first link is an agent, is not the person alone.
    for (const principalCtx of [principal("alice", "human", [ALICE, ALICE]), principal("alice", "human", [{ id: "alice", kind: "agent" }])]) {
      const ctx = { ...A, principal: principalCtx };
      await expect(driveAccount.exportAccount(ALICE, deps(ctx))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(driveAccount.eraseAccount(ALICE, deps(ctx))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(driveAccount.exportAccount(ALICE, {} as never)).rejects.toThrow("needs deps.drive");
    await expect(driveAccount.eraseAccount(ALICE, undefined as never)).rejects.toThrow("needs deps.drive");
  });
});

describe("each guard on its own", () => {
  // Each case reaches the drive, which would answer, so only the one guard named here refuses it.
  it("refuses a context for someone else that has no principal, and leaves their drive", async () => {
    // A drive with sharing refuses a principal-less context by itself, so this drive has none.
    const bare = createDrive({ store: backend.store(), blobs: createMemoryBlobs() });
    await bare.putFile(B, "/b.txt", bytes("bob secret"));
    const bobNoPrincipal = { owner: B.owner, actor: B.actor } as Ctx;
    await expect(driveAccount.exportAccount(ALICE, { drive: bare, ctx: bobNoPrincipal })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, { drive: bare, ctx: bobNoPrincipal })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await bare.read(B, "/b.txt")).data).toEqual(bytes("bob secret"));
  });

  it("refuses a principal that is another person, with Alice's own owner and actor", async () => {
    await seed();
    const mallory = { ...A, principal: principal("mallory", "human", [ALICE]) };
    await expect(driveAccount.exportAccount(ALICE, deps(mallory))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, deps(mallory))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await drive.read(A, "/mine/a.txt")).data).toEqual(bytes("alice file"));
  });

  it("refuses an agent subject whose chain has two links, where the drive would answer empty", async () => {
    await seed();
    const twoLinks = { ...OWN, principal: principal("robo", "agent", [ROBO, ROBO]) };
    await expect(driveAccount.exportAccount(ROBO, deps(twoLinks))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an actor of another kind, with no principal", async () => {
    await seed();
    const asAgent = { owner: A.owner, actor: { id: "alice", kind: "agent" } } as Ctx;
    await expect(driveAccount.exportAccount(ALICE, deps(asAgent))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, deps(asAgent))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await drive.read(A, "/mine/a.txt")).data).toEqual(bytes("alice file"));
  });

  // The drive refuses these contexts by itself, so a stub answers the way a permissive drive would. It pins the package's own guards.
  const permissive = (partial: boolean) =>
    ({
      exportData: async () => [],
      exportPerson: async () => ({ subject: ALICE, partial, authored: [], agents: [], shares: { held: [], invitesCreated: [] }, audit: [] }),
      erasePerson: async () => ({ removed: 0, grants: 0, invites: 0, anonymized: 0 }),
    }) as unknown as Drive;

  it("refuses a person's export that comes back partial", async () => {
    await expect(driveAccount.exportAccount(ALICE, { drive: permissive(true), ctx: A })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an actor of another kind when the drive would answer", async () => {
    const asAgent = { owner: A.owner, actor: { id: "alice", kind: "agent" } } as Ctx;
    await expect(driveAccount.exportAccount(ALICE, { drive: permissive(false), ctx: asAgent })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // Each case differs from Alice in one field only, so one guard is the only thing that can refuse it.
  it("refuses each mismatched field when the drive would answer", async () => {
    const cases = [
      { owner: "bob", actor: { id: "alice", kind: "human" }, principal: principal("alice") }, // owner
      { owner: "alice", actor: { id: "bob", kind: "human" } }, // actor id
      { ...A, principal: principal("alice", "agent", [ALICE]) }, // principal kind
      { ...A, principal: principal("alice", "human", [{ id: "bob", kind: "human" }]) }, // first chain link id
    ] as Ctx[];
    for (const ctx of cases) {
      await expect(driveAccount.exportAccount(ALICE, { drive: permissive(false), ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(driveAccount.eraseAccount(ALICE, { drive: permissive(false), ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

describe("exportAccount", () => {
  it("holds the subject's data under stable names, as plain JSON, and nothing of others", async () => {
    const team = await seed();
    const out = await driveAccount.exportAccount(ALICE, deps(A));
    expect(Object.keys(out)).toEqual(["items", "authored", "agents", "grants", "invites", "audit", "activity"]);
    expect(out.activity.length).toBeGreaterThan(0);
    const names = out.items.map((i) => i.name).sort();
    expect(names).toEqual(["a.txt", "gone.txt", "mine"]);
    const file = out.items.find((i) => i.name === "a.txt")!;
    expect(file).toMatchObject({ path: "/mine/a.txt", data: Buffer.from("alice file").toString("base64"), machineMade: false });
    expect(out.items.find((i) => i.name === "gone.txt")).toMatchObject({ trashed: true });
    expect(file).not.toHaveProperty("blobKey");
    expect(file).not.toHaveProperty("nameKey");
    expect(out.authored.map((a) => a.id)).toHaveLength(1);
    expect(out.grants).toContainEqual({ subjectKind: "human", subjectId: "alice", resourceId: team.id, role: "editor" });
    expect(out.invites).toHaveLength(1);
    expect(out.audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("bob secret");
    expect(JSON.stringify(out)).not.toContain("x@example.com");
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });

  it("refuses an in-person key with no drive scope on an empty drive that holds a share", async () => {
    // Alice holds an editor share on Bob's folder, and has never written to her own drive: no root, no items.
    await drive.mkdir(B, "/team");
    await drive.shareWith(B, "/team", { kind: "human", id: "alice" }, "editor");
    const docsOnly: Ctx = { owner: "alice", actor: { id: "alice", kind: "human" }, principal: { ...principal("alice"), scopes: ["docs:read"] as PrincipalContext["scopes"] } };
    await expect(drive.exportData(docsOnly)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(drive.exportPerson(docsOnly)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.exportAccount(ALICE, { drive, ctx: docsOnly })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("marks a file whose bytes are gone, so a lost file is not read as an empty one", async () => {
    const blobs = createMemoryBlobs();
    const own = createDrive({ store, blobs, sharing: createSharing(store) });
    await own.putFile(A, "/gone.txt", bytes("lost"));
    const [entry] = await own.exportData(A);
    await blobs.delete(entry!.node.blobKey!);
    const out = await driveAccount.exportAccount(ALICE, { drive: own, ctx: A });
    expect(out.items.find((i) => i.name === "gone.txt")).toMatchObject({ data: null, missing: true });
  });

  it("lists only the shares on drive items, as erase sweeps them", async () => {
    const team = await seed();
    const sharing = createSharing(store);
    const wide: PrincipalContext = { ...principal("alice"), scopes: ["*:admin"] as PrincipalContext["scopes"] };
    await sharing.createResource(wide, { id: "doc-1", type: "docs" });
    await sharing.grant(wide, "doc-1", { kind: "human", id: "bob" }, "editor");
    await sharing.createInvite(wide, "doc-1", { role: "viewer", email: "x@example.com" });
    const out = await driveAccount.exportAccount(ALICE, deps(A));
    expect(out.grants.map((g) => g.resourceId)).toContain(team.id);
    expect(out.grants.map((g) => g.resourceId)).not.toContain("doc-1");
    expect(out.invites).toHaveLength(1);
    expect(out.invites.map((i) => i.resourceId)).not.toContain("doc-1");
  });

  it("returns plain JSON, with undefined keys dropped and dates as strings", async () => {
    const stub = {
      exportData: async () => [],
      exportPerson: async () => ({ partial: false, authored: [{ id: "x", at: new Date(0), gone: undefined }], agents: [], shares: { held: [], invitesCreated: [] }, audit: [], activity: [] }),
      erasePerson: async () => ({ removed: 0, grants: 0, invites: 0, anonymized: 0 }),
    } as unknown as Drive;
    const out = await driveAccount.exportAccount(ALICE, { drive: stub, ctx: A });
    expect(out.authored).toEqual([{ id: "x", at: new Date(0).toISOString() }]);
    expect(out.authored[0]).not.toHaveProperty("gone");
  });

  it("refuses a delegate with no drive role, on a drive with items and on one with a root", async () => {
    // A drive from before roots: items written with no sharing, so the drive has no root resource.
    await createDrive({ store, blobs: createMemoryBlobs() }).putFile(A, "/secret.txt", bytes("alice secret"));
    const weak: Ctx = { owner: "alice", actor: { id: "bot", kind: "agent_of_human" }, principal: { ...BOT.principal!, scopes: ["docs:read"] as PrincipalContext["scopes"] } };
    await expect(drive.exportData(weak)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(drive.exportPerson(weak)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The owner in person still reads the items, and the read makes the root.
    expect((await drive.exportData(A)).map((e) => e.path)).toEqual(["/secret.txt"]);
    // With a root, the role check runs too.
    await expect(drive.exportData(weak)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(drive.exportPerson(weak)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gives an agent subject no person data", async () => {
    await seed();
    const out = await driveAccount.exportAccount(ROBO, deps(OWN));
    expect(out).toMatchObject({ items: [], authored: [], grants: [], invites: [], audit: [] });
  });
});

describe("eraseAccount", () => {
  it("removes the drive, grants, and invites, anonymises other drives, and a second erase counts zero", async () => {
    const team = await seed();
    const first = await driveAccount.eraseAccount(ALICE, deps(A));
    expect(first).toMatchObject({ items: 3, grants: 1, invites: 0, anonymized: 1 });
    const after = await driveAccount.exportAccount(ALICE, deps(A));
    expect(after).toMatchObject({ items: [], grants: [], invites: [] });
    expect((await drive.list(B, team.id)).map((n) => n.createdBy.id)).toEqual(["erased"]);
    expect((await drive.read(B, "/b.txt")).data).toEqual(bytes("bob secret"));
    expect(await driveAccount.eraseAccount(ALICE, deps(A))).toEqual({ items: 0, grants: 0, invites: 0, anonymized: 0 });
  });

  // The checks of an export write access-log rows (audit), as every read does. They do not write the person's data back.
  it("adds no root or grant when an export runs after the erase", async () => {
    await seed();
    await driveAccount.eraseAccount(ALICE, deps(A));
    const before = [await rowsIn("resources"), await rowsIn("grants")];
    await driveAccount.exportAccount(ALICE, deps(A));
    expect([await rowsIn("resources"), await rowsIn("grants")]).toEqual(before);
  });

  it("refuses an agent subject", async () => {
    await seed();
    await expect(driveAccount.eraseAccount(ROBO, deps(OWN))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

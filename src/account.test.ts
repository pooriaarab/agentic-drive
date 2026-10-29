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
beforeEach(() => {
  const store = backend.store();
  drive = createDrive({ store, blobs: createMemoryBlobs(), sharing: createSharing(store) });
});
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
    for (const bad of [{ id: "", kind: "human" }, { id: "alice" }, { id: "alice", kind: "wizard" }, null]) {
      await expect(driveAccount.exportAccount(bad as never, deps(A))).rejects.toThrow(TypeError);
      await expect(driveAccount.eraseAccount(bad as never, deps(A))).rejects.toThrow(TypeError);
    }
    await expect(driveAccount.exportAccount(ALICE, deps(B))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.eraseAccount(ALICE, deps(BOT))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(driveAccount.exportAccount(ALICE, {} as never)).rejects.toThrow("needs deps.drive");
    await expect(driveAccount.eraseAccount(ALICE, undefined as never)).rejects.toThrow("needs deps.drive");
  });
});

describe("exportAccount", () => {
  it("holds the subject's data under stable names, as plain JSON, and nothing of others", async () => {
    const team = await seed();
    const out = await driveAccount.exportAccount(ALICE, deps(A));
    expect(Object.keys(out)).toEqual(["items", "authored", "agents", "grants", "invites", "audit"]);
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
    expect(after).toMatchObject({ items: [], invites: [] });
    expect((await drive.list(B, team.id)).map((n) => n.createdBy.id)).toEqual(["erased"]);
    expect((await drive.read(B, "/b.txt")).data).toEqual(bytes("bob secret"));
    expect(await driveAccount.eraseAccount(ALICE, deps(A))).toEqual({ items: 0, grants: 0, invites: 0, anonymized: 0 });
  });

  it("refuses an agent subject", async () => {
    await seed();
    await expect(driveAccount.eraseAccount(ROBO, deps(OWN))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

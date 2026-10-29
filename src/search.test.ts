// Ways search, export, and hard delete can leak or lose data.
import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import { buildExport } from "./export.js";
import type { Blobs } from "agentic-identity";
import { readZip } from "./zip.js";

const me: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const bot: Ctx = { owner: "u1", actor: { id: "bot", kind: "agent_of_human" } };
const other: Ctx = { owner: "u2", actor: { id: "u2", kind: "human" } };
const b = (s: string) => new TextEncoder().encode(s);
const fails = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

let drive: Drive;
let blobs: Blobs;
beforeEach(async () => {
  blobs = createMemoryBlobs();
  drive = createDrive({ store: createMemoryStore(), blobs });
  await drive.putFile(me, "/docs/Résumé.pdf", b("pdf"), { mime: "application/pdf", parents: true });
  await drive.putFile(bot, "/docs/notes.txt", b("hello"), { mime: "text/plain" });
  await drive.putFile(me, "/pics/cat.png", b("png!"), { mime: "image/png", parents: true });
  await drive.putRef(me, "/docs/plan", "docs:abc");
  await drive.putFile(other, "/docs/secret.txt", b("theirs"), { parents: true });
});

describe("search", () => {
  const names = async (q: Parameters<Drive["search"]>[1], ctx = me) => (await drive.search(ctx, q)).map((r) => r.path);
  it("matches names without regard to case or Unicode form", async () => {
    expect(await names({ name: "RE\u0301SUME\u0301" })).toEqual(["/docs/R\u00e9sum\u00e9.pdf"]);
    expect(await names({ name: "NOTES" })).toEqual(["/docs/notes.txt"]);
  });
  it("filters by type, kind, size, and who made it", async () => {
    expect(await names({ mime: "image/*" })).toEqual(["/pics/cat.png"]);
    expect(await names({ kind: "ref" })).toEqual(["/docs/plan"]);
    expect(await names({ minSize: 4, maxSize: 4, kind: "file" })).toEqual(["/pics/cat.png"]);
    expect(await names({ maxSize: 3, kind: "file" })).toEqual(["/docs/Résumé.pdf"]);
    expect(await names({ createdByKind: "agent_of_human" })).toEqual(["/docs/notes.txt"]);
  });
  it("never shows trashed items, their descendants, or another owner's items", async () => {
    await drive.trash(me, "/docs");
    expect(await names({})).toEqual(["/pics", "/pics/cat.png"]);
    expect(await names({ name: "secret" })).toEqual([]);
    expect(await names({ name: "secret" }, other)).toEqual(["/docs/secret.txt"]);
  });
  it("honors the limit and rejects a bad one", async () => {
    expect(await names({ limit: 2 })).toHaveLength(2);
    await expect(drive.search(me, { limit: 0 })).rejects.toThrow(RangeError);
  });
});

describe("export", () => {
  it("builds a valid zip with a manifest, the bytes, and trashed items flagged", async () => {
    await drive.trash(me, "/docs/notes.txt");
    const zip = readZip(await buildExport(drive, me, () => 1_700_000_000_000));
    const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!));
    expect(manifest).toMatchObject({ format: "agentic-drive-export", version: 1, owner: "u1" });
    const byPath = Object.fromEntries(manifest.items.map((i: { path: string }) => [i.path, i]));
    expect(byPath["/docs/notes.txt"]).toMatchObject({ trashed: true, createdBy: { kind: "agent_of_human" } });
    expect(byPath["/docs/plan"]).toMatchObject({ kind: "ref", ref: "docs:abc", file: null });
    const file = byPath["/docs/Résumé.pdf"].file as string;
    expect(new TextDecoder().decode(zip.get(file)!)).toBe("pdf");
    expect(JSON.stringify(manifest)).not.toContain("secret");
    expect(manifest.items.some((i: { owner: string }) => i.owner !== "u1")).toBe(false);
  });
  it("exports an empty drive as an empty manifest", async () => {
    const zip = readZip(await buildExport(drive, { owner: "u3", actor: { id: "u3", kind: "human" } }));
    expect(JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!)).items).toEqual([]);
  });
  it("rejects a zip with a changed byte", async () => {
    const bytes = await buildExport(drive, me);
    bytes[bytes.indexOf(0x70) + 0] ^= 0xff;
    expect(() => readZip(bytes)).toThrow(/zip/i);
  });
});

describe("hard delete", () => {
  it("removes every node and byte of one owner and nothing of another", async () => {
    const mine = await drive.stat(me, "/pics/cat.png");
    await drive.trash(me, "/docs/notes.txt");
    const { removed } = await drive.deleteAll(me);
    expect(removed).toBe(6);
    expect(await blobs.get(mine.blobKey!)).toBeNull();
    expect(await drive.list(me, "/")).toEqual([]);
    expect(await drive.listTrash(me)).toEqual([]);
    expect((await drive.list(other, "/docs")).map((n) => n.name)).toEqual(["secret.txt"]);
  });
  it("refuses an agent acting for the owner", async () => {
    await fails(drive.deleteAll(bot), "FORBIDDEN");
    expect(await drive.list(me, "/")).not.toEqual([]);
  });
});

// Ways an upload can fail: too big, wrong type claim, broken stream, name clash.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { createDrive, type Ctx, type Drive } from "./drive.js";
import type { Blobs, Store } from "agentic-identity";
import { sniffMime, upload } from "./upload.js";

const me: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunks = (...parts: number[][]) => (async function* () { for (const p of parts) yield new Uint8Array(p); })();
const text = (s: string) => Array.from(new TextEncoder().encode(s));

describe("upload", () => {
  let store: Store;
  let blobs: Blobs;
  let drive: Drive;
  let puts: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    store = createMemoryStore();
    const inner = createMemoryBlobs();
    puts = vi.fn(inner.put);
    blobs = { ...inner, put: puts as Blobs["put"] };
    drive = createDrive({ store, blobs });
  });
  const nodes = async () => (await store.query("drive_nodes")).items.length;
  const fails = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

  it("stops at the cap before it stores anything", async () => {
    await fails(upload(drive, me, "/big", chunks([1, 2, 3], [4, 5, 6]), { maxBytes: 5 }), "TOO_LARGE");
    expect(puts).not.toHaveBeenCalled();
    expect(await nodes()).toBe(0);
  });
  it("accepts a file of exactly the cap and an empty file", async () => {
    expect((await upload(drive, me, "/a", chunks([1, 2, 3]), { maxBytes: 3 })).size).toBe(3);
    expect((await upload(drive, me, "/b", chunks(), { maxBytes: 3 })).size).toBe(0);
  });
  it("stores nothing when the stream breaks half way", async () => {
    const broken = (async function* () { yield new Uint8Array([1]); throw new Error("socket closed"); })();
    await expect(upload(drive, me, "/x", broken)).rejects.toThrow("socket closed");
    expect(puts).not.toHaveBeenCalled();
    expect(await nodes()).toBe(0);
  });
  it("leaves no stored bytes when the name is taken", async () => {
    await upload(drive, me, "/a", chunks([1]));
    await fails(upload(drive, me, "/a", chunks([2])), "NAME_TAKEN");
    expect(await nodes()).toBe(1);
  });
  it("hashes the bytes with sha256", async () => {
    const node = await upload(drive, me, "/abc", chunks(text("a"), text("bc")));
    expect(node.hash).toBe(createHash("sha256").update("abc").digest("hex"));
  });
  it("trusts the bytes over a false type claim, even when the magic bytes split across chunks", async () => {
    const node = await upload(drive, me, "/pic", chunks(PNG.slice(0, 3), PNG.slice(3), [0, 0]), { mime: "text/plain" });
    expect(node.mime).toBe("image/png");
  });
  it("keeps a declared text type, and falls back for unknown bytes", async () => {
    expect((await upload(drive, me, "/c.csv", chunks(text("a,b\n1,2")), { mime: "text/csv" })).mime).toBe("text/csv");
    expect((await upload(drive, me, "/n.txt", chunks(text("hello")))).mime).toBe("text/plain");
    expect((await upload(drive, me, "/z.bin", chunks([0, 1, 2, 255, 254]))).mime).toBe("application/octet-stream");
  });
  it("reads a web ReadableStream", async () => {
    const stream = new Blob([new Uint8Array(text("web"))]).stream();
    expect((await upload(drive, me, "/w", stream)).size).toBe(3);
  });
  it("sniffs common signatures", () => {
    expect(sniffMime(new Uint8Array(text("%PDF-1.7")))).toBe("application/pdf");
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array(text("PK\u0003\u0004")))).toBe("application/zip");
    expect(sniffMime(new Uint8Array(text("hello")))).toBeNull();
  });
  it("gives a download URL only for a file", async () => {
    await upload(drive, me, "/a", chunks([1]));
    expect(await drive.downloadUrl(me, "/a", 60)).toMatch(/^memory:\/\//);
    await drive.mkdir(me, "/d");
    await fails(drive.downloadUrl(me, "/d", 60), "NOT_A_FILE");
  });
});

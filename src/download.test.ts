// Failure modes first. Each case names a way a signed URL can serve bytes the owner never meant to share.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "./adapters/memory.js";
import { createR2Blobs, type R2BucketLike } from "./adapters/r2.js";
import { createDrive, safeMime, type Ctx } from "./drive.js";
import type { Blobs } from "./ports.js";
import { upload } from "./upload.js";

const me: Ctx = { owner: "u1", actor: { id: "u1", kind: "human" } };
const one = (text: string) => (async function* () { yield new TextEncoder().encode(text); })();

function spyDrive() {
  const inner = createMemoryBlobs();
  const calls: Parameters<Blobs["signedUrl"]>[1][] = [];
  const blobs: Blobs = { ...inner, signedUrl: async (key, options) => { calls.push(options); return inner.signedUrl(key, options); } };
  return { drive: createDrive({ store: createMemoryStore(), blobs }), calls };
}

describe("signed URL lifetime", () => {
  it("defaults to 15 minutes", async () => {
    const { drive, calls } = spyDrive();
    await upload(drive, me, "/a", one("x"));
    await drive.downloadUrl(me, "/a");
    expect(calls[0]!.expiresInSeconds).toBe(900);
  });
  it("allows up to one hour and refuses more", async () => {
    const { drive, calls } = spyDrive();
    await upload(drive, me, "/a", one("x"));
    await drive.downloadUrl(me, "/a", 3600);
    expect(calls[0]!.expiresInSeconds).toBe(3600);
    await expect(drive.downloadUrl(me, "/a", 3601)).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    await expect(drive.downloadUrl(me, "/a", 604800)).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
  });
  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses the lifetime %s", async (seconds) => {
    const { drive, calls } = spyDrive();
    await upload(drive, me, "/a", one("x"));
    await expect(drive.downloadUrl(me, "/a", seconds)).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    expect(calls).toEqual([]);
  });
});

describe("signed URL response headers", () => {
  const mimeOf = async (claimed: string) => {
    const { drive, calls } = spyDrive();
    const node = await upload(drive, me, "/f", one("<script>alert(1)</script>"), { mime: claimed });
    await drive.downloadUrl(me, "/f");
    return { node, call: calls[0]! };
  };
  it("always asks for an attachment with the stored type", async () => {
    const { node, call } = await mimeOf("text/csv");
    expect(call.responseContentDisposition).toBe("attachment");
    expect(call.responseContentType).toBe(node.mime);
    expect(node.mime).toBe("text/csv");
  });
  it.each(["text/html", "TEXT/HTML", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "text/javascript"])(
    "stores a claimed %s as an opaque download",
    async (claimed) => {
      const { node, call } = await mimeOf(claimed);
      expect(node.mime).toBe("application/octet-stream");
      expect(call.responseContentType).toBe("application/octet-stream");
    },
  );
  it.each(["text/plain\r\nx-evil: 1", "no-slash", "", "a/b c", `text/${"x".repeat(200)}`])("replaces the malformed type %j", (claimed) => {
    expect(safeMime(claimed)).toBe("application/octet-stream");
  });
  it("sends an unsafe stored type as octet-stream even when a node holds it", async () => {
    const store = createMemoryStore();
    const inner = createMemoryBlobs();
    const calls: Parameters<Blobs["signedUrl"]>[1][] = [];
    const drive = createDrive({ store, blobs: { ...inner, signedUrl: async (k, o) => { calls.push(o); return inner.signedUrl(k, o); } } });
    const node = await drive.putFile(me, "/f", new Uint8Array([1]));
    await store.put("drive_nodes", node.id, { ...node, mime: "text/html" });
    await drive.downloadUrl(me, "/f");
    expect(calls[0]!.responseContentType).toBe("application/octet-stream");
  });
});

describe("R2 signed URL", () => {
  const bucket = {} as R2BucketLike;
  const signing = { accountId: "acct", bucketName: "drive", accessKeyId: "AK", secretAccessKey: "SK", jurisdiction: "eu" as const };
  it("signs the disposition and type into the query", async () => {
    const blobs = createR2Blobs({ bucket, signing });
    const url = new URL(await blobs.signedUrl("u1/a", { method: "GET", expiresInSeconds: 60, responseContentDisposition: "attachment", responseContentType: "text/csv" }));
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
    expect(url.searchParams.get("response-content-type")).toBe("text/csv");
    const bare = new URL(await blobs.signedUrl("u1/a", { method: "GET", expiresInSeconds: 60 }));
    expect(url.searchParams.get("X-Amz-Signature")).not.toBe(bare.searchParams.get("X-Amz-Signature"));
  });
});

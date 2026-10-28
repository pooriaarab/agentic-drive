import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrive } from "../drive.js";
import { createMemoryStore } from "./memory.js";
import { createR2Blobs, type R2BucketLike } from "./r2.js";
import { presignUrl } from "./sigv4.js";

const signing = { accountId: "acct", bucketName: "drive", accessKeyId: "AK", secretAccessKey: "SK", jurisdiction: "eu" as const };

describe("signed URLs", () => {
  it("match the published AWS Signature V4 example", async () => {
    const url = await presignUrl({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresInSeconds: 86400, at: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

describe("R2 adapter on Miniflare", () => {
  let mf: Miniflare;
  let bucket: R2BucketLike;
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", r2Buckets: ["BUCKET"] });
    bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2BucketLike;
  });
  afterAll(() => mf.dispose());

  it("refuses an eu adapter without an eu jurisdiction", () => {
    expect(() => createR2Blobs({ bucket, signing: { ...signing, jurisdiction: undefined } })).toThrow(/jurisdiction/);
    expect(createR2Blobs({ bucket, signing, region: "any" }).region).toBe("any");
  });
  it("stores, reads, and deletes bytes with their type", async () => {
    const blobs = createR2Blobs({ bucket, signing });
    expect(blobs.region).toBe("eu");
    await blobs.put("u1/a", new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    expect(await blobs.get("u1/a")).toEqual({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    await blobs.delete("u1/a");
    expect(await blobs.get("u1/a")).toBeNull();
    await blobs.delete("u1/a");
  });
  it("signs download URLs for the EU endpoint and rejects bad lifetimes", async () => {
    const blobs = createR2Blobs({ bucket, signing, now: () => Date.UTC(2026, 9, 28) });
    const url = new URL(await blobs.signedUrl("u1/a b", { method: "GET", expiresInSeconds: 60 }));
    expect(url.host).toBe("acct.eu.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/drive/u1/a%20b");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    await expect(blobs.signedUrl("k", { method: "GET", expiresInSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(blobs.signedUrl("k", { method: "GET", expiresInSeconds: 604801 })).rejects.toThrow(RangeError);
  });
  it("runs the whole drive on R2 bytes", async () => {
    const drive = createDrive({ store: createMemoryStore(), blobs: createR2Blobs({ bucket, signing }) });
    const me = { owner: "u1", actor: { id: "u1", kind: "human" as const } };
    const node = await drive.putFile(me, "/x.txt", new TextEncoder().encode("on r2"), { mime: "text/plain" });
    expect(new TextDecoder().decode((await drive.read(me, "/x.txt")).data)).toBe("on r2");
    await drive.trash(me, "/x.txt");
    await drive.purge(me, node.id);
    expect(await bucket.get(node.blobKey!)).toBeNull();
  });
});

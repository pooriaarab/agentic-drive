// Failure modes first. Each case names a way a signed URL can serve bytes the owner never meant to share.
import { describe, expect, it } from "vitest";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { createDrive, safeMime, type Ctx } from "./drive.js";
import type { Blobs } from "agentic-identity";
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

describe("stored types", () => {
  it.each(["text/html", "TEXT/HTML", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "text/javascript"])(
    "stores a claimed %s as an opaque download",
    async (claimed) => {
      const { drive } = spyDrive();
      const node = await upload(drive, me, "/f", one("<script>alert(1)</script>"), { mime: claimed });
      expect(node.mime).toBe("application/octet-stream");
    },
  );
  it("keeps a safe claimed type", async () => {
    const { drive } = spyDrive();
    expect((await upload(drive, me, "/f", one("a,b"), { mime: "text/csv" })).mime).toBe("text/csv");
  });
  it.each(["text/plain\r\nx-evil: 1", "no-slash", "", "a/b c", `text/${"x".repeat(200)}`])("replaces the malformed type %j", (claimed) => {
    expect(safeMime(claimed)).toBe("application/octet-stream");
  });
});

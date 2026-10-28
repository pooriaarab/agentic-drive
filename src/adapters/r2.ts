import type { AdapterOptions, Blobs, Region } from "../ports.js";
import { presignUrl } from "./sigv4.js";

/** The part of an R2 bucket binding that this adapter uses. */
export interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

/** Keys for S3 signed URLs. A binding cannot sign, so these come from an R2 API token. */
export interface R2Signing {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The bucket's jurisdiction. Create the bucket with the same one. */
  jurisdiction?: "eu" | "fedramp";
}

export interface R2Options extends AdapterOptions {
  bucket: R2BucketLike;
  signing: R2Signing;
}

/**
 * Blobs on Cloudflare R2. The region defaults to "eu". An "eu" adapter needs an
 * "eu" jurisdiction in `signing`, so a signed URL never points at a bucket outside the EU.
 */
export function createR2Blobs(options: R2Options): Blobs {
  const region: Region = options.region ?? "eu";
  const { signing, bucket } = options;
  if (region === "eu" && signing.jurisdiction !== "eu") {
    throw new Error('an "eu" R2 adapter needs signing.jurisdiction "eu"');
  }
  const now = options.now ?? Date.now;
  const host = `${signing.accountId}.${signing.jurisdiction ? `${signing.jurisdiction}.` : ""}r2.cloudflarestorage.com`;
  return {
    region,
    async put(key, data, opts) {
      await bucket.put(key, data, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
    },
    async get(key) {
      const found = await bucket.get(key);
      if (!found) return null;
      const contentType = found.httpMetadata?.contentType;
      return { data: new Uint8Array(await found.arrayBuffer()), ...(contentType ? { contentType } : {}) };
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async signedUrl(key, { method, expiresInSeconds }) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      return presignUrl({
        method, host, path: `/${signing.bucketName}/${key}`, region: "auto", expiresInSeconds,
        accessKeyId: signing.accessKeyId, secretAccessKey: signing.secretAccessKey, at: new Date(now()),
      });
    },
  };
}

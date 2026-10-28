import type { Ctx, Drive, Node, OnConflict } from "./drive.js";
import { DriveError } from "./drive.js";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const SIGNATURES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
  [[0x25, 0x50, 0x44, 0x46, 0x2d], "application/pdf"],
  [[0x50, 0x4b, 0x03, 0x04], "application/zip"],
  [[0x1f, 0x8b], "application/gzip"],
];

/** The type named by the first bytes, or null when they match no known signature. */
export function sniffMime(head: Uint8Array): string | null {
  const hit = SIGNATURES.find(([sig]) => sig.every((byte, i) => head[i] === byte));
  if (hit) return hit[1];
  const isWebp = [..."RIFF"].every((c, i) => head[i] === c.charCodeAt(0)) && [..."WEBP"].every((c, i) => head[8 + i] === c.charCodeAt(0));
  return isWebp ? "image/webp" : null;
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  // A multi-byte character cut at the end is fine. Drop up to 3 bytes.
  for (let cut = 0; cut < 4 && cut <= head.length; cut++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - cut));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function* iterate(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface UploadOptions {
  /** Refuse a stream longer than this. Defaults to 25 MiB. */
  maxBytes?: number;
  /** The type the caller claims. Known file signatures override it. */
  mime?: string;
  parents?: boolean;
  onConflict?: OnConflict;
}

/** Reads the stream with a size cap, finds the type, hashes the bytes, then stores the file. */
export async function upload(
  drive: Drive,
  ctx: Ctx,
  path: string,
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  opts: UploadOptions = {},
): Promise<Node> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of iterate(source)) {
    size += chunk.byteLength;
    if (size > max) throw new DriveError("TOO_LARGE", `upload is over the limit of ${max} bytes`);
    parts.push(chunk);
  }
  const data = new Uint8Array(size);
  for (let at = 0, i = 0; i < parts.length; at += parts[i]!.byteLength, i++) data.set(parts[i]!, at);
  const head = data.subarray(0, 512);
  const mime = sniffMime(head) ?? opts.mime ?? (looksLikeText(head) ? "text/plain" : "application/octet-stream");
  return drive.putFile(ctx, path, data, { mime, hash: await sha256Hex(data), parents: opts.parents, onConflict: opts.onConflict });
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await globalThis.crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return globalThis.crypto.subtle.sign("HMAC", k, enc.encode(data) as BufferSource);
}

export interface PresignInput {
  method: "GET" | "PUT";
  host: string;
  /** The URL path, such as `/bucket/some/key`. Each segment is encoded here. */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  at: Date;
}

/** An AWS Signature V4 query-string signed URL for an S3 compatible service. */
export async function presignUrl(input: PresignInput): Promise<string> {
  const stamp = input.at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const path = input.path.split("/").map(uriEncode).join("/");
  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = params.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).sort().join("&");
  const canonical = [input.method, path, query, `host:${input.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await globalThis.crypto.subtle.digest("SHA-256", enc.encode(canonical) as BufferSource))].join("\n");
  let key = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), day);
  for (const part of [input.region, "s3", "aws4_request"]) key = await hmac(key, part);
  return `https://${input.host}${path}?${query}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}

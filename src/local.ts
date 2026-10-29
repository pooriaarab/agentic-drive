import { createHash } from "node:crypto";
import { join } from "node:path";
import { isMachineMade, isScope, issueCredential, revokeCredential, type Doc, type Store } from "agentic-identity";
import { createFileBlobs, createFileStore } from "./adapters/fs.js";
import { DriveError, createDrive, type Ctx, type Drive, type Node } from "./drive.js";
import { authenticate } from "./auth.js";

/** The drive and the store behind it, both kept in `dir`. The store holds the principals and keys too. */
export function openLocal(dir: string): { drive: Drive; store: Store } {
  const store = createFileStore(join(dir, "db"));
  return { store, drive: createDrive({ store, blobs: createFileBlobs(join(dir, "blobs")) }) };
}

/** Why no caller could be named. The CLI turns it into exit code 3. */
export class AuthError extends Error {
  readonly code = "UNAUTHENTICATED";
}

export const NO_TOKEN = "no principal: pass --token <key> or set AGENTIC_DRIVE_TOKEN to an API key";
const BAD_TOKEN = "the key is not valid: it is unknown, revoked, or expired, or its principal is revoked";

/**
 * The caller behind `token`, resolved through agentic-identity like the Worker does. The owner is the root
 * of the delegation chain, and the actor is the principal itself, so an agent key shows as a machine.
 */
export async function resolveToken(store: Store, token: string | undefined): Promise<Ctx> {
  if (!token) throw new AuthError(NO_TOKEN);
  let request: Request;
  try {
    request = new Request("http://local", { headers: { authorization: `Bearer ${token}` } });
  } catch {
    // The Headers error would echo the secret, so say nothing of it.
    throw new AuthError(BAD_TOKEN);
  }
  const ctx = await authenticate(request, store);
  if (!ctx) throw new AuthError(BAD_TOKEN);
  return ctx;
}

/** Make a principal. One with a parent is an agent of that human. One without is a human. Local data is the trust boundary. */
export async function addPrincipal(store: Store, id: string, opts: { parent?: string; scopes?: string[] }): Promise<Doc> {
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(id)) throw new Error(`invalid principal id "${id}"`);
  const scopes = opts.scopes?.length ? opts.scopes : [opts.parent ? "drive:write" : "drive:admin"];
  const bad = scopes.find((s) => !isScope(s));
  if (bad !== undefined) throw new Error(`invalid scope "${bad}"`);
  if (await store.get("principals", id)) throw new Error(`principal "${id}" exists`);
  if (opts.parent && !(await store.get("principals", opts.parent))) throw new Error(`parent "${opts.parent}" does not exist`);
  const parent = opts.parent ? await store.get("principals", opts.parent) : null;
  if (parent && parent.kind !== "human") throw new Error(`parent "${opts.parent}" is not a person`);
  const doc: Doc = opts.parent ? { id, kind: "agent_of_human", parentId: opts.parent, scopes } : { id, kind: "human", scopes };
  await store.put("principals", id, doc);
  return doc;
}

/** Stop a principal. Every agent below it stops too, because its chain is no longer live. */
export async function revokePrincipal(store: Store, id: string): Promise<void> {
  const doc = await store.get("principals", id);
  if (!doc) throw new DriveError("NOT_FOUND", `principal "${id}" does not exist`);
  await store.put("principals", id, { ...doc, revokedAt: Date.now() });
}

/** Issue an API key for a principal. The token is shown once. */
export async function issueKey(store: Store, principalId: string, label?: string): Promise<string> {
  if (!(await store.get("principals", principalId))) throw new Error(`principal "${principalId}" does not exist`);
  return issueCredential(store, { principalId, kind: "api_key", ...(label ? { label } : {}) });
}

export async function revokeKey(store: Store, token: string): Promise<void> {
  if (!(await store.get("credentials", createHash("sha256").update(token).digest("hex")))) throw new DriveError("NOT_FOUND", "no such key");
  await revokeCredential(store, token, Date.now());
}

/** A node as the CLI and MCP print it: no storage keys. `machineMade` is true when the creator is not a human principal. */
export function publicNode(node: Node, path?: string) {
  const { nameKey: _nameKey, blobKey: _blobKey, purging: _purging, ...rest } = node;
  const shown = { ...rest, machineMade: isMachineMade(node.createdBy.kind) };
  return path === undefined ? shown : { path, ...shown };
}

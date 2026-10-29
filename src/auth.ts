import { createStoreAuth, type Store } from "agentic-identity";
import { requirePrincipal } from "agentic-identity/http";
import type { ActorKind, Ctx } from "./drive.js";

/**
 * The caller behind a bearer token, resolved by the store-backed Auth of agentic-identity: the credential
 * names a principal, and the whole delegation chain must be live. Only a bearer token counts. A session
 * cookie is refused, because no check of the request origin stands behind it here. Any problem gives null.
 */
export async function authenticate(request: Request, store: Store, now?: () => number): Promise<Ctx | null> {
  if (!request.headers.has("authorization")) return null;
  const principal = await requirePrincipal(request, createStoreAuth(store, now ? { now } : {}));
  if (principal instanceof Response) return null;
  return { owner: principal.chain[0]!.id, actor: { id: principal.principalId, kind: principal.kind as ActorKind }, principal };
}

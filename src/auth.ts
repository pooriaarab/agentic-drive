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

/**
 * What an invite is matched against: the verified email of the caller and the handle of the agent, both read from
 * the store, never from the request. An unverified email is left out.
 */
export async function inviteIdentity(store: Store, actorId: string): Promise<{ email?: string; handle?: string }> {
  const user = await store.get("users", actorId);
  const agent = await store.get("principals", actorId);
  return {
    ...(user?.emailVerified === true && typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof agent?.handle === "string" ? { handle: agent.handle } : {}),
  };
}

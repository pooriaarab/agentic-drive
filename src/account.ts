// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape matches the plug-in of the other apps: `(subject, deps)`
// in, plain JSON records or counts out.
import { PRINCIPAL_KINDS } from "agentic-identity";
import { DriveError, type Actor, type Ctx, type Drive } from "./drive.js";
import { publicNode } from "./local.js";

export interface DriveAccountDeps {
  drive: Drive;
  /** The subject's own context. The package checks that it names the subject, in person. */
  ctx: Ctx;
}

type JsonRecord = Record<string, unknown>;

export interface DriveAccount {
  id: "drive";
  /**
   * Collections: `items` (the subject's own drive, trashed ones flagged, a file with its bytes as base64 in `data`),
   * `authored` (ids of items the subject made or changed in other drives), `agents` (the drives of agents
   * that belong to the subject, with no bytes), `grants` (shares the subject holds), `invites` (invites the subject sent),
   * and `audit` (what the subject did). An agent subject gets empty collections.
   */
  exportAccount(subject: Actor, deps: DriveAccountDeps): Promise<Record<"items" | "authored" | "agents" | "grants" | "invites" | "audit", JsonRecord[]>>;
  /**
   * Erases the subject's drive with all its bytes, the shares they hold, and the invites they sent, on drive items only.
   * What the subject made in other drives stays, with the id set to "erased" and the kind kept. Counts by `items`, `grants`,
   * `invites`, and `anonymized`. A repeat counts what is left, so it is zero after a full run. Only the person in person
   * may erase: an agent subject is refused.
   */
  eraseAccount(subject: Actor, deps: DriveAccountDeps): Promise<Record<"items" | "grants" | "invites" | "anonymized", number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): JsonRecord[] => JSON.parse(JSON.stringify(value)) as JsonRecord[];

function check(subject: Actor, deps: DriveAccountDeps): void {
  const { drive, ctx } = deps ?? ({} as Partial<DriveAccountDeps>);
  if (typeof drive?.exportData !== "function" || typeof drive.exportPerson !== "function" || typeof drive.erasePerson !== "function" || typeof ctx !== "object" || ctx === null) throw new TypeError("driveAccount needs deps.drive and deps.ctx");
  const known = (PRINCIPAL_KINDS as readonly unknown[]).includes(subject?.kind);
  if (typeof subject?.id !== "string" || subject.id.trim() === "" || !known) throw new TypeError("subject needs an id and a known kind");
  // The drive of the subject is the one they own, and the caller is the subject. A context for someone else would export or erase that drive.
  if (ctx.owner !== subject.id || ctx.actor?.id !== subject.id || ctx.actor.kind !== subject.kind) throw new DriveError("FORBIDDEN", "context does not match the subject");
}

const b64 = (data: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const driveAccount: DriveAccount = {
  id: "drive",
  async exportAccount(subject, deps) {
    check(subject, deps);
    const { drive, ctx } = deps;
    const person = await drive.exportPerson(ctx);
    const items = (await drive.exportData(ctx)).map(({ node, path, data, missing }) => ({ ...publicNode(node, path), data: data ? b64(data) : null, ...(missing ? { missing: true } : {}) }));
    return {
      items: plain(items),
      authored: plain(person.authored),
      agents: plain(person.agents),
      grants: plain(person.shares.held),
      invites: plain(person.shares.invitesCreated),
      audit: plain(person.audit),
    };
  },
  async eraseAccount(subject, deps) {
    check(subject, deps);
    const { removed, grants, invites, anonymized } = await deps.drive.erasePerson(deps.ctx);
    return { items: removed, grants, invites, anonymized };
  },
};

import type { Ctx, Drive } from "./drive.js";
import { writeZip, type ZipEntry } from "./zip.js";

/**
 * Everything one owner has, as a zip. `manifest.json` names the person (id and kind), lists each item with its
 * metadata and, for a file, the entry that holds its bytes, and adds what the person made in other drives, the
 * shares they hold, the invites they sent, and the audit entries of what they did. It also adds the activity log entries of their changes to items. Each has the actor kind, `human` or `agent`. An entry in the drive of another person has no names. Only the person in person gets
 * those parts, and the items of their agents that have an identity of their own (no bytes). For an agent the
 * manifest says `partial: true`. Trashed items are included and flagged.
 * Entries are named by item id, never by file name. A file whose bytes are gone is marked `missing`.
 */
export async function buildExport(drive: Drive, ctx: Ctx, now: () => number = Date.now): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const items = (await drive.exportData(ctx)).map(({ node, path, data, missing }) => {
    const file = data ? `files/${node.id}` : null;
    if (data && file) entries.push({ name: file, data });
    return {
      id: node.id, owner: node.owner, path, parentId: node.parentId, kind: node.kind, name: node.name, size: node.size, mime: node.mime,
      hash: node.hash, ref: node.ref, createdAt: node.createdAt, updatedAt: node.updatedAt, createdBy: node.createdBy,
      updatedBy: node.updatedBy, trashed: node.trashed, trashedAt: node.trashedAt, file, ...(missing ? { missing: true } : {}),
    };
  });
  const person = await drive.exportPerson(ctx);
  const manifest = { format: "agentic-drive-export", version: 2, exportedAt: now(), owner: ctx.owner, subject: person.subject, partial: person.partial, items, authored: person.authored, agents: person.agents, shares: person.shares, audit: person.audit, activity: person.activity };
  return writeZip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }, ...entries], now());
}

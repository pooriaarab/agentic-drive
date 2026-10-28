import type { Ctx, Drive } from "./drive.js";
import { writeZip, type ZipEntry } from "./zip.js";

/**
 * Everything one owner has, as a zip. `manifest.json` lists each item with its
 * metadata and, for a file, the entry that holds its bytes. Trashed items are included and flagged.
 */
export async function buildExport(drive: Drive, ctx: Ctx, now: () => number = Date.now): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const items = (await drive.exportData(ctx)).map(({ node, path, data }) => {
    const file = data ? `files/${node.id}/${node.name}` : null;
    if (data && file) entries.push({ name: file, data });
    return {
      id: node.id, owner: node.owner, path, parentId: node.parentId, kind: node.kind, name: node.name, size: node.size, mime: node.mime,
      hash: node.hash, ref: node.ref, createdAt: node.createdAt, updatedAt: node.updatedAt, createdBy: node.createdBy,
      updatedBy: node.updatedBy, trashed: node.trashed, trashedAt: node.trashedAt, file,
    };
  });
  const manifest = { format: "agentic-drive-export", version: 1, exportedAt: now(), owner: ctx.owner, items };
  return writeZip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }, ...entries], now());
}

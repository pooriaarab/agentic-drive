import type { Doc, Store, StoreOps } from "agentic-identity";
import { ROOT_ID, rootResource } from "./drive.js";

/** Items per page. Small, so one page fits in the query cap of a Worker call. */
const PAGE = 10;

export type BackfillOptions = {
  /** Where the last call stopped. Pass the `nextCursor` it returned. */
  cursor?: string;
  /** How many pages this call runs. The default runs them all. */
  maxPages?: number;
};
export type BackfillResult = { fixed: number; nextCursor?: string };

/**
 * Walks the items one page at a time. `fix` returns how many items it wrote on the page. A call stops after
 * `maxPages`, and it returns `nextCursor` while items remain. A second full run writes nothing.
 */
async function walk(
  store: Store,
  options: BackfillOptions,
  fix: (tx: StoreOps, items: { id: string; data: Doc }[]) => Promise<number>,
): Promise<BackfillResult> {
  let fixed = 0;
  let cursor = options.cursor;
  for (let pages = 0; options.maxPages === undefined || pages < options.maxPages; pages++) {
    const page = await store.query("drive_nodes", { limit: PAGE, cursor });
    fixed += await store.transaction(async (tx) => {
      const items: { id: string; data: Doc }[] = [];
      for (const item of page.items) {
        const data = await tx.get("drive_nodes", item.id);
        if (data) items.push({ id: item.id, data });
      }
      return fix(tx, items);
    });
    cursor = page.nextCursor;
    if (!cursor) return { fixed };
  }
  return { fixed, nextCursor: cursor };
}

/**
 * Items made before drive kept `createdById` and `updatedById` have no such fields, so an export or an erase
 * cannot find what a person made in other drives. It sets the two fields from `createdBy` and `updatedBy`. It
 * changes nothing else. Run it on the store once, after the old Worker has stopped writing. It returns how
 * many items it fixed, and `nextCursor` while items remain.
 */
export function backfillAuthorIds(store: Store, options: BackfillOptions = {}): Promise<BackfillResult> {
  return walk(store, options, async (tx, items) => {
    let count = 0;
    for (const { id, data } of items) {
      const created = (data.createdBy as { id?: unknown } | undefined)?.id;
      const updated = (data.updatedBy as { id?: unknown } | undefined)?.id;
      if (typeof created !== "string" || typeof updated !== "string") continue;
      if (data.createdById === created && data.updatedById === updated) continue;
      await tx.put("drive_nodes", id, { ...data, createdById: created, updatedById: updated });
      count++;
    }
    return count;
  });
}

/**
 * Items made before sharing was on have no `resources` doc. With sharing on, their owner gets NOT_FOUND. This
 * writes the doc of each such item, with the parent a new item gets: its folder, or the drive root. An item
 * that has a doc is left alone, so a second run changes nothing. A damaged item stops the run, because a doc
 * with a guessed parent would give access that nobody granted. Run it after the old Worker has stopped
 * writing, and before the new Worker serves the drive.
 */
export function backfillResources(store: Store, options: BackfillOptions = {}): Promise<BackfillResult> {
  return walk(store, options, async (tx, items) => {
    const missing: { id: string; parentId: string }[] = [];
    for (const { id, data } of items) {
      if (typeof data.owner !== "string" || typeof data.parentId !== "string") {
        throw new Error(`item ${id} has no owner or parent. Fix it before you run the backfill again.`);
      }
      if (await tx.get("resources", id)) continue;
      missing.push({ id, parentId: data.parentId === ROOT_ID ? await rootResource(data.owner) : data.parentId });
    }
    for (const { id, parentId } of missing) await tx.put("resources", id, { id, type: "drive", parentId });
    return missing.length;
  });
}

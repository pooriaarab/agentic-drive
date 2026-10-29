import type { Doc, Store } from "agentic-identity";

/**
 * Items made before drive kept `createdById` and `updatedById` have no such fields, so an export or an erase
 * cannot find what a person made in other drives. Run this once on a store of that age. It reads every item,
 * and it sets the two fields from `createdBy` and `updatedBy`. It changes nothing else, and a second run
 * changes nothing. It returns how many items it fixed.
 */
export async function backfillAuthorIds(store: Store): Promise<{ fixed: number }> {
  let fixed = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await store.query("drive_nodes", { limit: 25, cursor });
    fixed += await store.transaction(async (tx) => {
      let count = 0;
      const current: { id: string; data: Doc }[] = [];
      for (const item of page.items) {
        const data = await tx.get("drive_nodes", item.id);
        if (data) current.push({ id: item.id, data });
      }
      for (const { id, data } of current) {
        const created = (data.createdBy as { id?: unknown } | undefined)?.id;
        const updated = (data.updatedBy as { id?: unknown } | undefined)?.id;
        if (typeof created !== "string" || typeof updated !== "string") continue;
        if (data.createdById === created && data.updatedById === updated) continue;
        await tx.put("drive_nodes", id, { ...data, createdById: created, updatedById: updated });
        count++;
      }
      return count;
    });
    if (!page.nextCursor) return { fixed };
    cursor = page.nextCursor;
  }
}

// The file adapters run the shared contract suites. Two more ways they can fail:
//  1. A restart loses a committed write, or replays a write that a transaction rolled back.
//  2. A transaction that reran writes twice into the journal.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, it } from "vitest";
import { createFileBlobs, createFileStore } from "./fs.js";

const fresh = () => mkdtempSync(join(tmpdir(), "drive-fs-"));
const shared = new Map<string, string>();

runStoreContract((options) => {
  // Stores that share a name share one directory and one live dataset.
  const dir = options.shared === undefined ? fresh() : (shared.get(options.shared) ?? shared.set(options.shared, fresh()).get(options.shared)!);
  return createFileStore(dir, options);
});
runBlobsContract((options) => createFileBlobs(fresh(), options));

describe("file store journal", () => {
  it("keeps committed writes across a restart and drops rolled-back ones", async () => {
    const dir = fresh();
    const one = createFileStore(dir);
    await one.put("docs", "a", { v: 1 });
    await one.transaction(async (tx) => {
      await tx.put("docs", "b", { v: 2 });
      await tx.delete("docs", "a");
    });
    await expect(
      one.transaction(async (tx) => {
        await tx.put("docs", "c", { v: 3 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const two = createFileStore(dir);
    expect(await two.get("docs", "a")).toBeNull();
    expect(await two.get("docs", "b")).toEqual({ v: 2 });
    expect(await two.get("docs", "c")).toBeNull();
  });
  it("writes one journal line for a transaction that ran twice", async () => {
    const dir = fresh();
    const store = createFileStore(dir, { shared: `rerun-${dir}` });
    const other = createFileStore(dir, { shared: `rerun-${dir}` });
    await store.put("counters", "k", { v: 1 });
    let runs = 0;
    await store.transaction(async (tx) => {
      const doc = (await tx.get<{ v: number }>("counters", "k"))!;
      if (++runs === 1) await other.put("counters", "k", { v: 10 });
      await tx.put("counters", "k", { v: doc.v + 1 });
    });
    expect(runs).toBe(2);
    expect((await createFileStore(dir).get<{ v: number }>("counters", "k"))!.v).toBe(11);
  });
});

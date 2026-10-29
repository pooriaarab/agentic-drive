// The file adapters run the shared contract suites. Two more ways they can fail:
//  1. A restart loses a committed write, or replays a write that a transaction rolled back.
//  2. A transaction that reran writes twice into the journal.
//  3. A crash cut the last journal line, and the store cannot open.
//  4. A bad line in the middle is skipped, so the data is quietly wrong.
//  6. A crash cut the journal exactly before the newline, and the next write is glued onto the last line.
//  5. An append fails, and the store goes on reading a state that a restart would lose.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, it } from "vitest";
import { createFileBlobs, createFileStore } from "./fs.js";

const fresh = () => mkdtempSync(join(tmpdir(), "drive-fs-"));
const shared = new Map<string, string>();

// Instances that share a name share one directory and one live dataset.
const dirFor = (name: string | undefined) => (name === undefined ? fresh() : (shared.get(name) ?? shared.set(name, fresh()).get(name)!));

runStoreContract((options) => createFileStore(dirFor(options.shared), options));
runBlobsContract((options) => createFileBlobs(dirFor(options.shared), options));

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
  it("cuts off a half-written last line and keeps everything before it", async () => {
    const dir = fresh();
    const one = createFileStore(dir);
    await one.put("docs", "a", { v: 1 });
    await one.put("docs", "b", { v: 2 });
    appendFileSync(join(dir, "store.jsonl"), '[["docs","c",{"v"');
    const two = createFileStore(dir);
    expect(await two.get("docs", "b")).toEqual({ v: 2 });
    expect(await two.get("docs", "c")).toBeNull();
    await two.put("docs", "d", { v: 4 });
    const three = createFileStore(dir);
    expect(await three.get("docs", "d")).toEqual({ v: 4 });
    expect(readFileSync(join(dir, "store.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });
  it("refuses to open a journal with a bad line in the middle", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "store.jsonl"), '[["docs","a",{"v":1}]]\nnot json\n[["docs","b",{"v":2}]]\n');
    await expect(createFileStore(dir).get("docs", "a")).rejects.toThrow(/bad line 2/);
  });
  it("closes the store when an append fails", async () => {
    const dir = fresh();
    const store = createFileStore(dir);
    await store.put("docs", "a", { v: 1 });
    writeFileSync(join(dir, "store.jsonl"), "");
    // A folder in the place of the file makes the next append fail.
    mkdirSync(join(dir, "other"));
    const broken = createFileStore(join(dir, "other"));
    mkdirSync(join(dir, "other", "store.jsonl"));
    await expect(broken.put("docs", "x", { v: 1 })).rejects.toThrow();
    await expect(broken.get("docs", "x")).rejects.toThrow(/closed/);
  });
  it("starts a new line after a last line that lost only its newline", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "store.jsonl"), '[["docs","a",{"v":1}]]');
    const one = createFileStore(dir);
    await one.put("docs", "b", { v: 2 });
    const two = createFileStore(dir);
    expect(await two.get("docs", "a")).toEqual({ v: 1 });
    expect(await two.get("docs", "b")).toEqual({ v: 2 });
  });
  it("refuses to open a journal whose whole last line cannot apply", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "store.jsonl"), '[["docs","a",{"v":1}],["Bad Name","b",{"v":2}]]');
    await expect(createFileStore(dir).get("docs", "a")).rejects.toThrow(/bad last line/);
  });
});

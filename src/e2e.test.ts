// End to end: the real CLI and the real MCP server, started as child processes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { readZip } from "./zip.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
beforeAll(() => {
  if (!existsSync(cli)) execFileSync("npx", ["tsup"], { cwd: root, stdio: "ignore" });
}, 120_000);

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "drive-e2e-"));
  const data = join(work, "data");
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync("node", [cli, "--dir", data, ...args], { cwd: work, encoding: "utf8", env: { ...process.env, ...extraEnv } });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) as never as any };
  };
  return { work, data, run };
}

describe("CLI", () => {
  it("runs the whole life of a file", () => {
    const { work, run } = fixture();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(join(work, "pic.txt"), png);
    expect(run(["mkdir", "-p", "/a/b"]).code).toBe(0);
    const up = run(["upload", "pic.txt", "/a/b/", "--mime", "text/plain"]);
    expect(up.json()).toMatchObject({ name: "pic.txt", mime: "image/png", size: 11, hash: createHash("sha256").update(png).digest("hex") });
    expect(run(["ls", "/a/b"]).json().map((n: { name: string }) => n.name)).toEqual(["pic.txt"]);
    expect(run(["mv", "/a/b/pic.txt", "/a", "--name", "cat.png"]).json().name).toBe("cat.png");
    expect(run(["search", "--name", "CAT"]).json()[0]).toMatchObject({ path: "/a/cat.png" });
    expect(run(["download", "/a/cat.png", "out.png"]).code).toBe(0);
    expect(readFileSync(join(work, "out.png"))).toEqual(png);
    const gone = run(["rm", "/a/cat.png"]).json();
    expect(run(["ls", "/a"]).json().map((n: { name: string }) => n.name)).toEqual(["b"]);
    expect(run(["trash"]).json()[0].id).toBe(gone.id);
    expect(run(["restore", gone.id]).json().name).toBe("cat.png");
    expect(run(["search", "--mime", "image/*"]).json()).toHaveLength(1);
  });
  it("exports everything to a valid zip, then deletes everything", () => {
    const { work, run } = fixture();
    writeFileSync(join(work, "n.txt"), "hello");
    run(["upload", "n.txt", "/n.txt"]);
    const exported = run(["export", "all.zip"]);
    expect(exported.code).toBe(0);
    const zip = readZip(new Uint8Array(readFileSync(join(work, "all.zip"))));
    const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!));
    expect(manifest.items).toHaveLength(1);
    expect(new TextDecoder().decode(zip.get(manifest.items[0].file)!)).toBe("hello");
    const py = spawnSync("python3", ["-m", "zipfile", "-t", join(work, "all.zip")], { encoding: "utf8" });
    if (py.error === undefined) expect(py.status).toBe(0);
    const refused = run(["delete-all"]);
    expect(refused.code).toBe(2);
    expect(run(["ls"]).json()).toHaveLength(1);
    expect(run(["delete-all", "--yes"]).json()).toEqual({ removed: 1 });
    expect(run(["ls"]).json()).toEqual([]);
  });
  it("fails with a code and a nonzero exit", () => {
    const { work, run } = fixture();
    const missing = run(["ls", "/nope"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err)).toMatchObject({ error: { code: "NOT_FOUND" } });
    writeFileSync(join(work, "big.bin"), Buffer.alloc(100, 7));
    const big = run(["upload", "big.bin", "/big.bin", "--max-bytes", "50"]);
    expect(big.code).toBe(1);
    expect(JSON.parse(big.err).error.code).toBe("TOO_LARGE");
    expect(run(["ls"]).json()).toEqual([]);
    expect(run(["upload", "missing.bin", "/x"]).code).toBe(1);
    expect(run(["frobnicate"]).code).toBe(2);
    expect(run(["mkdir"]).code).toBe(2);
    expect(run(["ls", "--bogus"]).code).toBe(2);
    expect(run(["purge", "x"], {}).code).toBe(1);
  });
  it("keeps owners apart and labels agent work", () => {
    const { run } = fixture();
    run(["mkdir", "/mine"], { AGENTIC_DRIVE_OWNER: "u1" });
    const bot = run(["mkdir", "/by-bot"], { AGENTIC_DRIVE_OWNER: "u1", AGENTIC_DRIVE_ACTOR: "bot", AGENTIC_DRIVE_KIND: "agent_of_human" });
    expect(bot.json().createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
    expect(run(["ls"], { AGENTIC_DRIVE_OWNER: "u2" }).json()).toEqual([]);
    expect(run(["ls"], { AGENTIC_DRIVE_OWNER: "u1" }).json()).toHaveLength(2);
    expect(run(["delete-all", "--yes"], { AGENTIC_DRIVE_OWNER: "u1", AGENTIC_DRIVE_ACTOR: "bot" }).code).toBe(1);
  });
});

describe("MCP over stdio", () => {
  async function connect(env: Record<string, string> = {}) {
    const { work, data } = fixture();
    mkdirSync(data, { recursive: true });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "--dir", data, "mcp"], cwd: work, env: { ...(process.env as Record<string, string>), ...env } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as any };
    };
    return { client, call, work };
  }

  it("lists the tools and runs the life of a file", async () => {
    const { client, call, work } = await connect({ AGENTIC_DRIVE_ACTOR: "bot", AGENTIC_DRIVE_KIND: "agent_of_human", AGENTIC_DRIVE_OWNER: "u1" });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["drive_ls", "drive_mkdir", "drive_upload", "drive_download", "drive_mv", "drive_rm", "drive_restore", "drive_search", "drive_export"]));
      await call("drive_mkdir", { path: "/notes", parents: true });
      const up = await call("drive_upload", { path: "/notes/a.txt", text: "héllo" });
      expect(up.body).toMatchObject({ mime: "text/plain", createdBy: { id: "bot", kind: "agent_of_human" } });
      expect((await call("drive_download", { path: "/notes/a.txt" })).body.text).toBe("héllo");
      const bin = await call("drive_upload", { path: "/notes/b.bin", contentBase64: Buffer.from([0, 255, 1]).toString("base64") });
      expect((await call("drive_download", { path: bin.body.id })).body.contentBase64).toBe("AP8B");
      expect((await call("drive_mv", { src: "/notes/a.txt", folder: "/", name: "z.txt" })).body.name).toBe("z.txt");
      expect((await call("drive_search", { createdByKind: "agent_of_human", kind: "file", name: "z" })).body[0].path).toBe("/z.txt");
      const rm = await call("drive_rm", { path: "/z.txt" });
      expect((await call("drive_ls")).body.map((n: { name: string }) => n.name)).toEqual(["notes"]);
      expect((await call("drive_restore", { id: rm.body.id })).body.name).toBe("z.txt");
      const out = join(work, "x.zip");
      await call("drive_export", { outPath: out });
      expect(readZip(new Uint8Array(readFileSync(out))).has("manifest.json")).toBe(true);
    } finally {
      await client.close();
    }
  });
  it("returns tool errors with a code, and rejects bad input", async () => {
    const { client, call } = await connect();
    try {
      expect(await call("drive_ls", { path: "/nope" })).toMatchObject({ isError: true, body: { error: { code: "NOT_FOUND" } } });
      expect((await call("drive_upload", { path: "/x" })).isError).toBe(true);
      expect((await call("drive_purge", { id: "nope" })).body.error.code).toBe("NOT_FOUND");
      const bad = (await client.callTool({ name: "drive_search", arguments: { limit: 0 } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

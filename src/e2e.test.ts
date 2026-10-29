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
  // No AGENTIC_DRIVE_TOKEN is inherited: a test must pass its own key.
  const { AGENTIC_DRIVE_TOKEN: _drop, ...base } = process.env;
  const raw = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync("node", [cli, "--dir", data, ...args], { cwd: work, encoding: "utf8", env: { ...base, ...extraEnv } });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) as never as any };
  };
  // Make a person (or an agent of a person) and a key for it, through the CLI.
  const principal = (id: string, of?: string, scopes: string[] = []) => {
    raw(["principal", "add", id, ...(of ? ["--of", of] : []), ...scopes.flatMap((s) => ["--scope", s])]);
    return raw(["key", "issue", id]).json().token as string;
  };
  const me = principal("u1");
  const run = (args: string[], extraEnv: Record<string, string> = {}) => raw(args, { AGENTIC_DRIVE_TOKEN: me, ...extraEnv });
  return { work, data, run, raw, principal, me };
}

describe("CLI", () => {
  it("registers app documents, lists them in the home view, and forgets one", () => {
    const { run } = fixture();
    expect(run(["register", "docs:d1", "Plan"]).json()).toMatchObject({ kind: "ref", ref: "docs:d1", name: "Plan" });
    expect(run(["register", "sheets:s1", "Budget", "--parent", "/Finance"]).json()).toMatchObject({ ref: "sheets:s1", name: "Budget" });
    expect(run(["register", "docs:d1", "Other"]).json().name).toBe("Plan");
    const home = run(["home"]).json();
    expect(home.apps).toEqual({ docs: 1, sheets: 1 });
    expect(home.items.map((i: { app: string }) => i.app).sort()).toEqual(["docs", "sheets"]);
    expect(run(["home", "--app", "sheets"]).json().items.map((i: { name: string }) => i.name)).toEqual(["Budget"]);
    expect(run(["forget", "docs:d1"]).json()).toEqual({ trashed: 1 });
    expect(run(["home"]).json().apps).toEqual({ sheets: 1 });
    expect(run(["register", "not-a-ref", "x"]).code).toBe(1);
  });

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
    expect(run(["delete-all", "--yes"]).json()).toEqual({ removed: 1, grants: 0, invites: 0, anonymized: 0 });
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
    const { run, principal } = fixture();
    const bot = principal("bot", "u1");
    const u2 = principal("u2");
    run(["mkdir", "/mine"]);
    const made = run(["mkdir", "/by-bot"], { AGENTIC_DRIVE_TOKEN: bot });
    expect(made.json().createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
    expect(run(["ls"], { AGENTIC_DRIVE_TOKEN: u2 }).json()).toEqual([]);
    expect(run(["ls"]).json()).toHaveLength(2);
    expect(run(["ls"], { AGENTIC_DRIVE_TOKEN: bot }).json()).toHaveLength(2);
    expect(run(["delete-all", "--yes"], { AGENTIC_DRIVE_TOKEN: bot }).code).toBe(1);
  });
  it("takes the token from the flag too", () => {
    const { raw, me } = fixture();
    expect(raw(["--token", me, "mkdir", "/f"]).json()).toMatchObject({ name: "f", createdBy: { id: "u1", kind: "human" } });
  });
  it("refuses to run with no principal", () => {
    const { raw } = fixture();
    for (const args of [["ls"], ["mkdir", "/x"], ["export", "x.zip"], ["delete-all", "--yes"]]) {
      const r = raw(args);
      expect(r.code, args[0]).toBe(3);
      expect(JSON.parse(r.err)).toMatchObject({ error: { code: "UNAUTHENTICATED", message: expect.stringContaining("AGENTIC_DRIVE_TOKEN") } });
      expect(r.out).toBe("");
    }
    expect(raw(["ls"], { AGENTIC_DRIVE_TOKEN: "" }).code).toBe(3);
    expect(raw(["--help"]).code).toBe(0);
  });
  it("accepts a valid agent key and records the agent", () => {
    const { raw, principal } = fixture();
    const bot = principal("bot", "u1", ["drive:write"]);
    const r = raw(["mkdir", "/by-agent"], { AGENTIC_DRIVE_TOKEN: bot });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ owner: "u1", createdBy: { id: "bot", kind: "agent_of_human" } });
  });
  it("refuses a revoked key, an unknown key, and a key of a revoked chain", () => {
    const { raw, principal } = fixture();
    const bot = principal("bot", "u1");
    expect(raw(["ls"], { AGENTIC_DRIVE_TOKEN: bot }).code).toBe(0);
    expect(raw(["key", "revoke", bot]).json()).toEqual({ revoked: true });
    const revoked = raw(["ls"], { AGENTIC_DRIVE_TOKEN: bot });
    expect(revoked.code).toBe(3);
    expect(JSON.parse(revoked.err).error).toMatchObject({ code: "UNAUTHENTICATED", message: expect.stringContaining("revoked") });
    expect(raw(["ls"], { AGENTIC_DRIVE_TOKEN: "not-a-key" }).code).toBe(3);
    expect(raw(["ls", "--token", "bad key"]).code).toBe(3);
  });
  it("documents the token in --help", () => {
    const { raw } = fixture();
    const help = raw(["--help"]).out;
    expect(help).toContain("--token");
    expect(help).toContain("AGENTIC_DRIVE_TOKEN");
    expect(help).toContain("exits with 3");
  });
  it("rejects bad principal and key commands", () => {
    const { raw, principal } = fixture();
    expect(raw(["principal", "add"]).code).toBe(2);
    expect(raw(["principal", "add", "u1"]).code).toBe(1);
    expect(raw(["principal", "add", "x", "--of", "ghost"]).code).toBe(1);
    expect(raw(["principal", "add", "y", "--scope", "nope"]).code).toBe(1);
    expect(raw(["key", "issue", "ghost"]).code).toBe(1);
    principal("ok");
  });
});

describe("MCP over stdio", () => {
  async function connect(agent = false) {
    const { work, data, principal, me } = fixture();
    mkdirSync(data, { recursive: true });
    const env = { AGENTIC_DRIVE_TOKEN: agent ? principal("bot", "u1") : me };
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "--dir", data, "mcp"], cwd: work, env: { ...(process.env as Record<string, string>), ...env } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as any };
    };
    return { client, call, work, data };
  }

  it("lists the tools and runs the life of a file", async () => {
    const { client, call, work, data } = await connect(true);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["drive_ls", "drive_mkdir", "drive_upload", "drive_download", "drive_mv", "drive_rm", "drive_restore", "drive_search", "drive_export", "drive_home", "drive_register_document", "drive_forget_document"]));
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
      const reg = await call("drive_register_document", { ref: "docs:d9", name: "Notes doc", folder: "/notes" });
      expect(reg.body).toMatchObject({ kind: "ref", ref: "docs:d9", createdBy: { id: "bot", kind: "agent_of_human" } });
      expect((await call("drive_home", { app: "docs" })).body).toMatchObject({ apps: { docs: 1 }, files: 2, items: [{ name: "Notes doc", app: "docs", path: "/notes/Notes doc" }] });
      expect((await call("drive_forget_document", { ref: "docs:d9" })).body).toEqual({ trashed: 1 });
      expect((await call("drive_register_document", { ref: "bad", name: "x" })).isError).toBe(true);
      const made = await call("drive_export", { name: "x.zip" });
      expect(readZip(new Uint8Array(readFileSync(join(data, "exports", "x.zip")))).has("manifest.json")).toBe(true);
      expect(made.body.saved).toBe(join(data, "exports", "x.zip"));
      for (const bad of ["../x.zip", "/tmp/x.zip", "a/b.zip", ".zshrc", "x.txt", "x\\y.zip"]) {
        expect((await call("drive_export", { name: bad })).isError, bad).toBe(true);
      }
      expect((await call("drive_export", { name: "x.zip" })).isError).toBe(true);
      expect(existsSync(join(work, "x.zip"))).toBe(false);
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

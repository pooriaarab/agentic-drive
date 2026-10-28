#!/usr/bin/env node
import { createReadStream, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DriveError, type ActorKind, type OnConflict } from "./drive.js";
import { buildExport } from "./export.js";
import { openLocal, publicNode } from "./local.js";
import { upload } from "./upload.js";
import { VERSION } from "./version.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
}

const HELP = `agentic-drive ${VERSION}
Store, sort, and share files and folders.

Usage: agentic-drive <command> [flags]

Commands:
  ls [path]                    List a folder.
  stat <path|id>               Show one item.
  mkdir <path> [-p]            Make a folder.
  upload <local> <remote>      Upload a file. End remote with "/" to keep the name.
  download <remote> [out]      Save a file. Use "-" for stdout.
  mv <src> <folder>            Move an item. Use --name to rename it.
  rm <path|id>                 Move an item to the trash.
  trash                        List the trash.
  restore <id>                 Put a trashed item back.
  purge <id>                   Delete a trashed item for good.
  search                       Find items. Flags: --name --mime --kind --min-size --max-size --created-by-kind --limit
  export <out.zip>             Write everything you own to a zip with a JSON manifest.
  delete-all --yes             Delete everything you own for good.
  mcp                          Start the MCP server on stdio.

Flags:
  --dir <path>        Data folder. Env AGENTIC_DRIVE_DIR. Default ./.agentic-drive
  --owner <id>        Drive owner. Env AGENTIC_DRIVE_OWNER. Default "me"
  --actor <id>        Who acts. Env AGENTIC_DRIVE_ACTOR. Default the owner
  --actor-kind <k>    Actor kind. Env AGENTIC_DRIVE_KIND. Default human
  --on-conflict <m>   fail, rename, or replace
  -p, --parents       Create missing parent folders
`;

export class UsageError extends Error {}

const options = {
  dir: { type: "string" }, owner: { type: "string" }, actor: { type: "string" }, "actor-kind": { type: "string" },
  "on-conflict": { type: "string" }, parents: { type: "boolean", short: "p" }, mime: { type: "string" },
  "max-bytes": { type: "string" }, kind: { type: "string" }, name: { type: "string" }, parent: { type: "string" },
  "min-size": { type: "string" }, "max-size": { type: "string" }, "created-by-kind": { type: "string" },
  limit: { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "V" },
} as const;

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} needs a number of 0 or more`);
  return n;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    const [command, ...args] = positionals;
    if (values.version) return io.out(VERSION), 0;
    if (!command || values.help || command === "help") return io.out(HELP), 0;
    const need = (n: number, usage: string) => {
      if (args.length < n) throw new UsageError(`usage: agentic-drive ${usage}`);
    };
    const env = io.env;
    const { drive, ctx } = openLocal({
      dir: resolve(values.dir ?? env.AGENTIC_DRIVE_DIR ?? ".agentic-drive"),
      owner: values.owner ?? env.AGENTIC_DRIVE_OWNER ?? "me",
      actor: values.actor ?? env.AGENTIC_DRIVE_ACTOR,
      kind: (values["actor-kind"] ?? env.AGENTIC_DRIVE_KIND) as ActorKind | undefined,
    });
    const onConflict = values["on-conflict"] as OnConflict | undefined;
    if (onConflict && !["fail", "rename", "replace"].includes(onConflict)) throw new UsageError("--on-conflict needs fail, rename, or replace");
    const print = (value: unknown) => io.out(JSON.stringify(value));
    switch (command) {
      case "ls":
        print((await drive.list(ctx, args[0] ?? "/")).map((n) => publicNode(n)));
        break;
      case "stat":
        need(1, "stat <path|id>");
        print(publicNode(await drive.stat(ctx, args[0]!)));
        break;
      case "mkdir":
        need(1, "mkdir <path> [-p]");
        print(publicNode(await drive.mkdir(ctx, args[0]!, { parents: values.parents })));
        break;
      case "upload": {
        need(2, "upload <local> <remote>");
        const remote = args[1]!.endsWith("/") ? `${args[1]}${basename(args[0]!)}` : args[1]!;
        const node = await upload(drive, ctx, remote, createReadStream(resolve(args[0]!)), {
          mime: values.mime, maxBytes: num(values["max-bytes"], "max-bytes"), parents: values.parents, onConflict,
        });
        print(publicNode(node));
        break;
      }
      case "download": {
        need(1, "download <remote> [out]");
        const { node, data } = await drive.read(ctx, args[0]!);
        const out = args[1] ?? node.name;
        if (out === "-") process.stdout.write(data);
        else {
          writeFileSync(resolve(out), data);
          print({ saved: resolve(out), size: data.byteLength, hash: node.hash });
        }
        break;
      }
      case "mv":
        need(2, "mv <src> <folder>");
        print(publicNode(await drive.move(ctx, args[0]!, args[1]!, { name: values.name, onConflict })));
        break;
      case "rm":
        need(1, "rm <path|id>");
        print(publicNode(await drive.trash(ctx, args[0]!)));
        break;
      case "trash":
        print((await drive.listTrash(ctx)).map((n) => publicNode(n)));
        break;
      case "restore":
        need(1, "restore <id>");
        print(publicNode(await drive.restore(ctx, args[0]!, { parentId: values.parent, onConflict })));
        break;
      case "purge":
        need(1, "purge <id>");
        print(await drive.purge(ctx, args[0]!));
        break;
      case "search":
        print((await drive.search(ctx, {
          name: values.name, mime: values.mime, kind: values.kind as never, minSize: num(values["min-size"], "min-size"),
          maxSize: num(values["max-size"], "max-size"), createdByKind: values["created-by-kind"] as ActorKind | undefined,
          limit: num(values.limit, "limit"),
        })).map((r) => publicNode(r.node, r.path)));
        break;
      case "export": {
        need(1, "export <out.zip>");
        const zip = await buildExport(drive, ctx);
        writeFileSync(resolve(args[0]!), zip);
        print({ saved: resolve(args[0]!), size: zip.byteLength });
        break;
      }
      case "delete-all":
        if (!values.yes) throw new UsageError("delete-all removes everything you own for good. Add --yes to confirm.");
        print(await drive.deleteAll(ctx));
        break;
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp({ drive, ctx });
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(JSON.stringify({ error: { code: "USAGE", message: (error as Error).message } }));
      return 2;
    }
    if (error instanceof DriveError) {
      io.err(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return 1;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.err(JSON.stringify({ error: { code: "LOCAL_FILE_NOT_FOUND", message: error.message } }));
      return 1;
    }
    io.err(JSON.stringify({ error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } }));
    return 1;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2), {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    env: process.env,
  }).then((code) => {
    // Exit nonzero at once. On zero, fall off the end so `mcp` keeps its stdio open.
    if (code !== 0) process.exit(code);
  });
}

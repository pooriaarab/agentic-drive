#!/usr/bin/env node
import { createReadStream, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROLES, SUBJECT_KINDS, type Role } from "agentic-identity";
import { inviteIdentity } from "./auth.js";
import { DriveError, type ActorKind, type OnConflict } from "./drive.js";
import { buildExport } from "./export.js";
import { importLegacyLocal } from "./legacy.js";
import { AuthError, NO_TOKEN, addPrincipal, ensureSharing, issueKey, openLocal, publicNode, resolveToken, revokeKey, revokePrincipal } from "./local.js";
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
  activity <path|id> [--limit] List the changes to an item: who (person or AI agent), what, when.
  mkdir <path> [-p]            Make a folder.
  upload <local> <remote>      Upload a file. End remote with "/" to keep the name.
  download <remote> [out]      Save a file. Use "-" for stdout.
  mv <src> <folder>            Move an item. Use --name to rename it.
  rm <path|id>                 Move an item to the trash.
  trash [--paths]              List the trash. With --paths, each item shows the path it had.
  restore <id>                 Put a trashed item back.
  purge <id>                   Delete a trashed item for good.
  search                       Find items. Flags: --name --mime --kind --min-size --max-size --created-by-kind --limit
  export <out.zip>             Write everything you own to a zip with a JSON manifest.
  home [--app <name>]          List files and app documents, newest change first.
  register <ref> <name>        Put an app document in the drive. Flag: --parent <folder>
  find-ref <ref>               List the live items that point at an app document, with paths.
  claim-ref <ref> <path> <subject>  Put a reference and give a role on it, or do neither. Flags: --role <r> --subject-kind <human|agent>
  forget <ref>                 Move the references to an app document to the trash.
  shares <path|id>             Show who can reach an item, and by which links and invites. Owner only.
  share <path|id> <subject>    Give a role to a person or agent. Flags: --role <r> --subject-kind <human|agent>
  unshare <path|id> <subject>  Take a role away. Flag: --subject-kind <human|agent>
  invite <path|id>             Invite by --email (a person) or --handle (an agent). Flags: --role <r> --expires-in-ms <n>. Sends no message.
  accept-invite <id>           Accept an invite that names your verified email or agent handle.
  link-create <path|id>        Make a share link. The token shows once. Flags: --role <r> --expires-in-ms <n> --signed-in-only
  link-revoke <id>             Stop a share link.
  delete-all --yes             Erase you for good: your drive, and what you shared or held.
  principal add <id>           Make a person, or an agent with --of <person>. Flag: --scope <s> (repeat). No key needed.
  principal revoke <id>        Stop a principal, and every agent below it. No key needed.
  key issue <principal>        Print a new API key for a principal. It shows once. Flag: --label. No key needed.
  key revoke <key>             Stop a key from working. No key needed.
  mcp                          Start the MCP server on stdio.

Flags:
  --dir <path>        Data folder. Env AGENTIC_DRIVE_DIR. Default ./.agentic-drive
  --token <key>       Who you are: an API key. Env AGENTIC_DRIVE_TOKEN. Needed by every command
                      except help, version, principal, and key. Prefer the env var: a flag shows in ps.
                      The key names a principal, found through agentic-identity. The drive belongs to
                      the person at the top of that principal's chain. An agent key marks items as
                      made by a machine. If the key is missing or not valid, the command exits with 3.
  --role <r>          share: owner, editor, commenter, or viewer. invite and link-create: editor, commenter, or viewer.
  --on-conflict <m>   fail, rename, or replace
  -p, --parents       Create missing parent folders

Exit codes: 0 done, 1 error, 2 bad usage, 3 no principal or an invalid key.
`;

const COMMANDS = ["ls", "stat", "activity", "mkdir", "upload", "download", "mv", "rm", "trash", "restore", "purge", "search", "export", "home", "register", "find-ref", "claim-ref", "forget", "shares", "share", "unshare", "invite", "accept-invite", "link-create", "link-revoke", "delete-all", "mcp", "principal", "key"];

export class UsageError extends Error {}

const options = {
  dir: { type: "string" }, token: { type: "string" }, of: { type: "string" }, scope: { type: "string", multiple: true }, label: { type: "string" },
  "on-conflict": { type: "string" }, paths: { type: "boolean" }, parents: { type: "boolean", short: "p" }, mime: { type: "string" },
  "max-bytes": { type: "string" }, kind: { type: "string" }, name: { type: "string" }, parent: { type: "string" },
  "min-size": { type: "string" }, "max-size": { type: "string" }, "created-by-kind": { type: "string" },
  role: { type: "string" }, "subject-kind": { type: "string" }, email: { type: "string" }, handle: { type: "string" }, "expires-in-ms": { type: "string" }, "signed-in-only": { type: "boolean" },
  limit: { type: "string" }, app: { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "V" },
} as const;

/** A lifetime in milliseconds: a whole number above 0. */
function lifetime(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(n) || n <= 0) throw new UsageError(`--${flag} needs a whole number above 0`);
  return n;
}

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} needs a number of 0 or more`);
  return n;
}

/** An invite or a link cannot make an owner. Only a grant can. */
const LINK_ROLES = ROLES.filter((r) => r !== "owner");

function pick(value: string | undefined, allowed: readonly string[], flag: string): string {
  if (value === undefined || !allowed.includes(value)) throw new UsageError(`--${flag} needs ${allowed.join(", ")}`);
  return value;
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
    const dir = resolve(values.dir ?? env.AGENTIC_DRIVE_DIR ?? ".agentic-drive");
    if (!COMMANDS.includes(command)) throw new UsageError(`unknown command "${command}"`);
    const admin = command === "principal" || command === "key";
    const token = values.token ?? env.AGENTIC_DRIVE_TOKEN;
    if (!admin && !token) throw new AuthError(NO_TOKEN);
    const { drive, store, blobs } = openLocal(dir, { beforeImport: true });
    await importLegacyLocal(dir, store, blobs);
    if (admin || command === "key") {
      const [sub, target] = args;
      const out = (value: unknown) => io.out(JSON.stringify(value));
      if (command === "principal" && sub === "add" && target) return out(await addPrincipal(store, target, { parent: values.of, scopes: values.scope })), 0;
      if (command === "principal" && sub === "revoke" && target) return await revokePrincipal(store, target), out({ id: target, revoked: true }), 0;
      if (command === "key" && sub === "issue" && target) return out({ principal: target, token: await issueKey(store, target, values.label) }), 0;
      if (command === "key" && sub === "revoke" && target) return await revokeKey(store, target), out({ revoked: true }), 0;
      throw new UsageError("usage: agentic-drive principal add <id> [--of <person>] [--scope <s>] | principal revoke <id> | key issue <principal> | key revoke <key>");
    }
    const ctx = await resolveToken(store, token);
    await ensureSharing(store);
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
      case "activity":
        need(1, "activity <path|id> [--limit n]");
        {
          const limit = num(values.limit, "limit");
          if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new UsageError("--limit needs a whole number of 1 or more");
          print(await drive.listActivity(ctx, args[0]!, { limit }));
        }
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
        print(values.paths ? (await drive.listTrashWithPaths(ctx)).map((r) => publicNode(r.node, r.path)) : (await drive.listTrash(ctx)).map((n) => publicNode(n)));
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
      case "home": {
        const home = await drive.home(ctx, { app: values.app, limit: num(values.limit, "limit") });
        print({ apps: home.apps, files: home.files, items: home.items.map((i) => ({ ...publicNode(i.node, i.path), app: i.app })) });
        break;
      }
      case "register":
        need(2, "register <ref> <name>");
        print(publicNode(await drive.registerDocument(ctx, { ref: args[0]!, name: args[1]!, folder: values.parent })));
        break;
      case "find-ref":
        need(1, "find-ref <ref>");
        print((await drive.findByRef(ctx, args[0]!)).map((r) => publicNode(r.node, r.path)));
        break;
      case "claim-ref":
        need(3, "claim-ref <ref> <path> <subject> --role <r> --subject-kind <human|agent>");
        print(publicNode(await drive.claimRef(ctx, args[1]!, args[0]!, {
          subject: { kind: pick(values["subject-kind"], SUBJECT_KINDS, "subject-kind") as "human" | "agent", id: args[2]! }, role: pick(values.role, ROLES, "role") as Role,
        }, { parents: values.parents, onConflict })));
        break;
      case "forget":
        need(1, "forget <ref>");
        print(await drive.forgetDocument(ctx, args[0]!));
        break;
      case "shares":
        need(1, "shares <path|id>");
        print(await drive.shares(ctx, args[0]!));
        break;
      case "share":
        need(2, "share <path|id> <subject> --role <r> --subject-kind <human|agent>");
        await drive.shareWith(ctx, args[0]!, { kind: pick(values["subject-kind"], SUBJECT_KINDS, "subject-kind") as "human" | "agent", id: args[1]! }, pick(values.role, ROLES, "role") as Role);
        print({ ok: true });
        break;
      case "unshare":
        need(2, "unshare <path|id> <subject> --subject-kind <human|agent>");
        await drive.unshare(ctx, args[0]!, { kind: pick(values["subject-kind"], SUBJECT_KINDS, "subject-kind") as "human" | "agent", id: args[1]! });
        print({ ok: true });
        break;
      case "invite": {
        need(1, "invite <path|id> --role <r> (--email <e> | --handle <h>)");
        const expiresInMs = lifetime(values["expires-in-ms"], "expires-in-ms");
        print(await drive.invite(ctx, args[0]!, {
          role: pick(values.role, LINK_ROLES, "role") as Role, ...(values.email === undefined ? {} : { email: values.email }),
          ...(values.handle === undefined ? {} : { handle: values.handle }), ...(expiresInMs === undefined ? {} : { expiresInMs }),
        }));
        break;
      }
      case "accept-invite":
        need(1, "accept-invite <id>");
        await drive.acceptInvite(ctx, args[0]!, await inviteIdentity(store, ctx.actor.id));
        print({ ok: true });
        break;
      case "link-create": {
        need(1, "link-create <path|id> --role <r>");
        const expiresInMs = lifetime(values["expires-in-ms"], "expires-in-ms");
        print(await drive.createLink(ctx, args[0]!, {
          role: pick(values.role, LINK_ROLES, "role") as Role, signedInOnly: values["signed-in-only"] === true,
          ...(expiresInMs === undefined ? {} : { expiresAt: Date.now() + expiresInMs }),
        }));
        break;
      }
      case "link-revoke":
        need(1, "link-revoke <id>");
        await drive.revokeLink(ctx, args[0]!);
        print({ ok: true });
        break;
      case "delete-all":
        if (!values.yes) throw new UsageError("delete-all erases you for good. Add --yes to confirm.");
        print(await drive.erasePerson(ctx));
        break;
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp({ drive, ctx, exportDir: join(dir, "exports"), store });
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
    if (error instanceof AuthError) {
      io.err(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return 3;
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

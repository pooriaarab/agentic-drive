import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DriveError, type Ctx, type Drive } from "./drive.js";
import { buildExport } from "./export.js";
import { ACTOR_KINDS, publicNode } from "./local.js";
import { upload } from "./upload.js";
import { VERSION } from "./version.js";

const conflict = z.enum(["fail", "rename", "replace"]).optional();
const loc = z.string().describe('A path that starts with "/", or an item id.');

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
function failure(error: unknown) {
  if (!(error instanceof DriveError)) throw error;
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: error.code, message: error.message } }) }] };
}

export function createMcpServer(drive: Drive, ctx: Ctx): McpServer {
  const server = new McpServer({ name: "agentic-drive", version: VERSION });
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) =>
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        return ok(await run(args));
      } catch (error) {
        return failure(error);
      }
    }) as never);

  tool("drive_ls", "List a folder.", { path: loc.optional() }, async ({ path }) => (await drive.list(ctx, path ?? "/")).map((n) => publicNode(n)), { readOnlyHint: true });
  tool("drive_stat", "Show one item with its metadata and who made it.", { path: loc }, async ({ path }) => publicNode(await drive.stat(ctx, path)), { readOnlyHint: true });
  tool("drive_mkdir", "Make a folder.", { path: z.string(), parents: z.boolean().optional() }, async ({ path, parents }) => publicNode(await drive.mkdir(ctx, path, { parents })));
  tool(
    "drive_upload",
    "Store a file. Give `text` or `contentBase64`.",
    { path: z.string(), text: z.string().optional(), contentBase64: z.string().optional(), mime: z.string().optional(), parents: z.boolean().optional(), onConflict: conflict },
    async ({ path, text, contentBase64, mime, parents, onConflict }) => {
      if ((text === undefined) === (contentBase64 === undefined)) throw new DriveError("INVALID_PATH", "give exactly one of text or contentBase64");
      const bytes = text !== undefined ? new TextEncoder().encode(text) : new Uint8Array(Buffer.from(contentBase64!, "base64"));
      return publicNode(await upload(drive, ctx, path, (async function* () { yield bytes; })(), { mime, parents, onConflict }));
    },
  );
  tool("drive_download", "Read a file. Text comes back as `text`, other bytes as `contentBase64`.", { path: loc }, async ({ path }) => {
    const { node, data } = await drive.read(ctx, path);
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      text = null;
    }
    return { node: publicNode(node), ...(text !== null ? { text } : { contentBase64: Buffer.from(data).toString("base64") }) };
  }, { readOnlyHint: true });
  tool("drive_mv", "Move an item into a folder. Pass `name` to rename it.", { src: loc, folder: loc, name: z.string().optional(), onConflict: conflict }, async ({ src, folder, name, onConflict }) =>
    publicNode(await drive.move(ctx, src, folder, { name, onConflict })));
  tool("drive_rm", "Move an item to the trash. It stays restorable.", { path: loc }, async ({ path }) => publicNode(await drive.trash(ctx, path)));
  tool("drive_trash", "List items in the trash.", {}, async () => (await drive.listTrash(ctx)).map((n) => publicNode(n)), { readOnlyHint: true });
  tool("drive_restore", "Put a trashed item back.", { id: z.string(), parentId: z.string().optional(), onConflict: conflict }, async ({ id, parentId, onConflict }) =>
    publicNode(await drive.restore(ctx, id, { parentId, onConflict })));
  tool("drive_purge", "Delete a trashed item for good.", { id: z.string() }, async ({ id }) => drive.purge(ctx, id), { destructiveHint: true });
  tool(
    "drive_search",
    "Find items by name and metadata.",
    { name: z.string().optional(), mime: z.string().optional(), kind: z.enum(["folder", "file", "ref"]).optional(), minSize: z.number().optional(), maxSize: z.number().optional(), createdByKind: z.enum(ACTOR_KINDS as [string, ...string[]]).optional(), limit: z.number().int().min(1).optional() },
    async (q) => (await drive.search(ctx, q as never)).map((r) => publicNode(r.node, r.path)),
    { readOnlyHint: true },
  );
  tool("drive_export", "Write everything the owner has to a zip file with a JSON manifest.", { outPath: z.string() }, async ({ outPath }) => {
    const zip = await buildExport(drive, ctx);
    writeFileSync(resolve(outPath), zip);
    return { saved: resolve(outPath), size: zip.byteLength };
  });
  return server;
}

export async function startMcp(deps: { drive: Drive; ctx: Ctx }): Promise<void> {
  await createMcpServer(deps.drive, deps.ctx).connect(new StdioServerTransport());
}

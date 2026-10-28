import { join } from "node:path";
import { createFileBlobs, createFileStore } from "./adapters/fs.js";
import { createDrive, type ActorKind, type Ctx, type Drive, type Node } from "./drive.js";

export interface LocalOptions {
  /** Where the drive keeps its data. */
  dir: string;
  /** Whose drive this is. */
  owner: string;
  /** Who acts. Defaults to the owner. */
  actor?: string;
  /** What kind of actor. Defaults to `human`. Set an agent kind when an agent runs the command. */
  kind?: ActorKind;
}

export const ACTOR_KINDS: ActorKind[] = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"];

export function openLocal(options: LocalOptions): { drive: Drive; ctx: Ctx } {
  const kind = options.kind ?? "human";
  if (!ACTOR_KINDS.includes(kind)) throw new Error(`unknown actor kind "${kind}"`);
  return {
    drive: createDrive({ store: createFileStore(join(options.dir, "db")), blobs: createFileBlobs(join(options.dir, "blobs")) }),
    ctx: { owner: options.owner, actor: { id: options.actor ?? options.owner, kind } },
  };
}

/** A node as the CLI and MCP print it: no storage keys. */
export function publicNode(node: Node, path?: string) {
  const { nameKey: _nameKey, blobKey: _blobKey, ...rest } = node;
  return path === undefined ? rest : { path, ...rest };
}

import type { Blobs, Store, StoreOps } from "./ports.js";

export const ROOT_ID = "root";
const NODES = "drive_nodes";

export type ActorKind = "human" | "agent_of_human" | "agent_of_agent" | "agent" | "user_token";
export type Actor = { id: string; kind: ActorKind };
/** `owner` is the drive's owner. `actor` is who acts for them. */
export type Ctx = { owner: string; actor: Actor };
export type Action = "read" | "write" | "delete";
/** The seam for sharing. A later release swaps this for a role check. */
export type Can = (ctx: Ctx, action: Action, node: Node) => boolean | Promise<boolean>;

export type Node = {
  id: string;
  owner: string;
  parentId: string;
  kind: "folder" | "file" | "ref";
  name: string;
  nameKey: string;
  size: number;
  mime: string | null;
  hash: string | null;
  /** A typed reference such as `docs:<id>`. Set when kind is "ref". */
  ref: string | null;
  blobKey: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: Actor;
  updatedBy: Actor;
  trashed: boolean;
  trashedAt: number | null;
};

export type ErrorCode =
  | "NOT_FOUND" | "NAME_TAKEN" | "INVALID_NAME" | "INVALID_PATH" | "INVALID_REF" | "NOT_A_FOLDER" | "NOT_A_FILE"
  | "MOVE_INTO_SELF" | "PARENT_GONE" | "TRASHED" | "NOT_TRASHED" | "IS_ROOT" | "FORBIDDEN" | "BLOB_MISSING";

export class DriveError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DriveError";
  }
}

export type OnConflict = "fail" | "rename" | "replace";
export interface DriveDeps {
  store: Store;
  blobs: Blobs;
  now?: () => number;
  newId?: () => string;
  can?: Can;
}

export type Drive = ReturnType<typeof createDrive>;

const REF = /^[a-z][a-z0-9_-]*:[^\s/]+$/;

/** Validates a name. Names are NFC-normalized. Two names clash when their keys match. */
export function parseName(raw: string): { name: string; key: string } {
  const name = raw.normalize("NFC");
  if (name.trim() === "" || name === "." || name === ".." || /[/\u0000-\u001f\u007f]/.test(name) || new TextEncoder().encode(name).length > 255) {
    throw new DriveError("INVALID_NAME", `invalid name ${JSON.stringify(raw)}`);
  }
  return { name, key: name.toLowerCase() };
}

function splitPath(path: string) {
  if (!path.startsWith("/")) throw new DriveError("INVALID_PATH", `path must start with "/": ${path}`);
  const rest = path.replace(/\/$/, "").slice(1);
  if (rest === "") return [];
  const parts = rest.split("/");
  if (parts.includes("")) throw new DriveError("INVALID_PATH", `empty segment in path: ${path}`);
  return parts.map(parseName);
}

export function createDrive(deps: DriveDeps) {
  const { store, blobs } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const can: Can = deps.can ?? ((ctx, _action, node) => node.owner === ctx.owner);

  const rootNode = (ctx: Ctx): Node => ({
    id: ROOT_ID, owner: ctx.owner, parentId: "", kind: "folder", name: "", nameKey: "", size: 0, mime: null, hash: null,
    ref: null, blobKey: null, createdAt: 0, updatedAt: 0, createdBy: ctx.actor, updatedBy: ctx.actor, trashed: false, trashedAt: null,
  });
  const who = (ctx: Ctx): Actor => ({ id: ctx.actor.id, kind: ctx.actor.kind });

  async function fetch(ops: StoreOps, ctx: Ctx, id: string): Promise<Node | null> {
    const node = id === ROOT_ID ? rootNode(ctx) : await ops.get<Node>(NODES, id);
    return node && (await can(ctx, "read", node)) ? node : null;
  }
  async function need(ctx: Ctx, action: Action, node: Node) {
    if (!(await can(ctx, action, node))) throw new DriveError("FORBIDDEN", `not allowed to ${action} ${node.id}`);
  }
  async function children(ops: StoreOps, owner: string, parentId: string, extra: Record<string, string> = {}) {
    const out: Node[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await ops.query<Node>(NODES, { where: { owner, parentId, ...extra }, limit: 100, cursor });
      out.push(...page.items.map((item) => item.data));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }
  const liveChild = async (ops: StoreOps, ctx: Ctx, parentId: string, key: string) =>
    (await children(ops, ctx.owner, parentId, { nameKey: key })).find((n) => !n.trashed) ?? null;

  /** True when the node and each ancestor are out of the trash. */
  async function isLive(ops: StoreOps, ctx: Ctx, node: Node) {
    for (let n: Node | null = node, depth = 0; n && depth < 1000; depth++) {
      if (n.trashed) return false;
      if (n.id === ROOT_ID) return true;
      n = await fetch(ops, ctx, n.parentId);
    }
    return false;
  }

  /** A locator is a path when it starts with "/". Otherwise it is an id. */
  async function resolve(ops: StoreOps, ctx: Ctx, loc: string): Promise<Node> {
    if (!loc.startsWith("/")) {
      const node = await fetch(ops, ctx, loc);
      if (!node) throw new DriveError("NOT_FOUND", `no item ${loc}`);
      if (!(await isLive(ops, ctx, node))) throw new DriveError("TRASHED", `${loc} is in the trash`);
      return node;
    }
    let node = rootNode(ctx);
    for (const seg of splitPath(loc)) {
      if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
      const next = await liveChild(ops, ctx, node.id, seg.key);
      if (!next) throw new DriveError("NOT_FOUND", `no item ${loc}`);
      node = next;
    }
    if (!(await can(ctx, "read", node))) throw new DriveError("NOT_FOUND", `no item ${loc}`);
    return node;
  }

  /** "a.txt" taken: try "a (2).txt", "a (3).txt", and so on. */
  async function freeName(ops: StoreOps, ctx: Ctx, parentId: string, name: string) {
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})${ext}`;
      if (!(await liveChild(ops, ctx, parentId, parseName(candidate).key))) return candidate;
    }
  }

  /** Walks the parents of a path. With `create`, missing folders appear. */
  async function folderAt(ops: StoreOps, ctx: Ctx, segs: ReturnType<typeof splitPath>, create: boolean) {
    let node = rootNode(ctx);
    for (const seg of segs) {
      if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
      let next = await liveChild(ops, ctx, node.id, seg.key);
      if (!next) {
        if (!create) throw new DriveError("NOT_FOUND", `no folder ${seg.name}`);
        next = (await insert(ops, ctx, node, seg.name, { kind: "folder" }, "fail")).node;
      }
      node = next;
    }
    if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
    return node;
  }

  type NewFields = Partial<Pick<Node, "kind" | "size" | "mime" | "hash" | "ref" | "blobKey">>;
  async function insert(ops: StoreOps, ctx: Ctx, parent: Node, rawName: string, fields: NewFields, onConflict: OnConflict) {
    let { name, key } = parseName(rawName);
    await need(ctx, "write", parent);
    const clash = await liveChild(ops, ctx, parent.id, key);
    if (clash) {
      if (onConflict === "replace" && clash.kind === "file" && fields.kind === "file") {
        const node: Node = { ...clash, ...fields, updatedAt: now(), updatedBy: who(ctx) } as Node;
        await ops.put(NODES, node.id, node);
        return { node, replacedBlob: clash.blobKey };
      }
      if (onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
      name = await freeName(ops, ctx, parent.id, name);
      key = parseName(name).key;
    }
    const t = now();
    const node: Node = {
      id: newId(), owner: ctx.owner, parentId: parent.id, kind: "file", name, nameKey: key, size: 0, mime: null, hash: null,
      ref: null, blobKey: null, createdAt: t, updatedAt: t, createdBy: who(ctx), updatedBy: who(ctx), trashed: false, trashedAt: null,
      ...fields,
    };
    await ops.put(NODES, node.id, node);
    return { node, replacedBlob: null as string | null };
  }

  /** Splits a path into its parent folder and the new item's name. */
  async function parentAndName(ops: StoreOps, ctx: Ctx, path: string, parents: boolean) {
    const segs = splitPath(path);
    const last = segs.pop();
    if (!last) throw new DriveError("IS_ROOT", "the root already exists");
    return { parent: await folderAt(ops, ctx, segs, parents), name: last.name };
  }

  async function relocate(ops: StoreOps, ctx: Ctx, node: Node, destLoc: string, opts: { name?: string; onConflict?: OnConflict }) {
    if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot change the root");
    const dest = await resolve(ops, ctx, destLoc);
    if (dest.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${dest.name} is not a folder`);
    for (let n: Node | null = dest, depth = 0; n && n.id !== ROOT_ID && depth < 1000; depth++) {
      if (n.id === node.id) throw new DriveError("MOVE_INTO_SELF", `cannot move ${node.name} into itself`);
      n = await fetch(ops, ctx, n.parentId);
    }
    await need(ctx, "write", node);
    await need(ctx, "write", dest);
    let { name, key } = parseName(opts.name ?? node.name);
    const clash = await liveChild(ops, ctx, dest.id, key);
    if (clash && clash.id !== node.id) {
      if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
      name = await freeName(ops, ctx, dest.id, name);
      key = parseName(name).key;
    }
    const moved: Node = { ...node, parentId: dest.id, name, nameKey: key, updatedAt: now(), updatedBy: who(ctx) };
    await ops.put(NODES, moved.id, moved);
    return moved;
  }

  const api = {
    async stat(ctx: Ctx, loc: string): Promise<Node> {
      return resolve(store, ctx, loc);
    },

    /** Live children, sorted by name. */
    async list(ctx: Ctx, loc = "/"): Promise<Node[]> {
      const folder = await resolve(store, ctx, loc);
      if (folder.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${folder.name} is not a folder`);
      return (await children(store, folder.owner, folder.id))
        .filter((n) => !n.trashed)
        .sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : a.name < b.name ? -1 : 1));
    },

    async mkdir(ctx: Ctx, path: string, opts: { parents?: boolean } = {}): Promise<Node> {
      return store.transaction(async (tx) => {
        const { parent, name } = await parentAndName(tx, ctx, path, opts.parents ?? false);
        const existing = await liveChild(tx, ctx, parent.id, parseName(name).key);
        if (opts.parents && existing?.kind === "folder") return existing;
        return (await insert(tx, ctx, parent, name, { kind: "folder" }, "fail")).node;
      });
    },

    /** Stores one blob and one node. The blob is written first and removed if the node fails. */
    async putFile(ctx: Ctx, path: string, data: Uint8Array, opts: { mime?: string; hash?: string; parents?: boolean; onConflict?: OnConflict } = {}): Promise<Node> {
      const blobKey = `${ctx.owner}/${newId()}`;
      await blobs.put(blobKey, data, opts.mime ? { contentType: opts.mime } : undefined);
      try {
        const { node, replacedBlob } = await store.transaction(async (tx) => {
          const { parent, name } = await parentAndName(tx, ctx, path, opts.parents ?? false);
          return insert(tx, ctx, parent, name, { kind: "file", size: data.byteLength, mime: opts.mime ?? null, hash: opts.hash ?? null, blobKey }, opts.onConflict ?? "fail");
        });
        if (replacedBlob) await blobs.delete(replacedBlob);
        return node;
      } catch (error) {
        await blobs.delete(blobKey);
        throw error;
      }
    },

    /** A reference points at a document in another app, such as `docs:<id>`. */
    async putRef(ctx: Ctx, path: string, ref: string, opts: { parents?: boolean; onConflict?: OnConflict } = {}): Promise<Node> {
      if (!REF.test(ref)) throw new DriveError("INVALID_REF", `a reference looks like "docs:<id>", got ${JSON.stringify(ref)}`);
      return store.transaction(async (tx) => {
        const { parent, name } = await parentAndName(tx, ctx, path, opts.parents ?? false);
        return (await insert(tx, ctx, parent, name, { kind: "ref", ref }, opts.onConflict === "replace" ? "fail" : opts.onConflict ?? "fail")).node;
      });
    },

    async read(ctx: Ctx, loc: string): Promise<{ node: Node; data: Uint8Array; contentType?: string }> {
      const node = await resolve(store, ctx, loc);
      if (node.kind !== "file" || !node.blobKey) throw new DriveError("NOT_A_FILE", `${node.name} is not a file`);
      const blob = await blobs.get(node.blobKey);
      if (!blob) throw new DriveError("BLOB_MISSING", `the bytes of ${node.name} are missing`);
      return { node, ...blob };
    },

    async move(ctx: Ctx, src: string, destLoc: string, opts: { name?: string; onConflict?: OnConflict } = {}): Promise<Node> {
      return store.transaction(async (tx) => relocate(tx, ctx, await resolve(tx, ctx, src), destLoc, opts));
    },

    async rename(ctx: Ctx, loc: string, name: string): Promise<Node> {
      return store.transaction(async (tx) => {
        const node = await resolve(tx, ctx, loc);
        return relocate(tx, ctx, node, node.parentId, { name });
      });
    },

    /** Hides an item and, for a folder, everything under it. Nothing else changes. */
    async trash(ctx: Ctx, loc: string): Promise<Node> {
      return store.transaction(async (tx) => {
        const node = await resolve(tx, ctx, loc);
        if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot trash the root");
        await need(ctx, "delete", node);
        const t = now();
        const trashed: Node = { ...node, trashed: true, trashedAt: t, updatedAt: t, updatedBy: who(ctx) };
        await tx.put(NODES, node.id, trashed);
        return trashed;
      });
    },

    /** Items trashed on their own, newest first. */
    async listTrash(ctx: Ctx): Promise<Node[]> {
      const page = await store.query<Node>(NODES, { where: { owner: ctx.owner, trashed: true }, limit: 1000 });
      const out: Node[] = [];
      for (const { data } of page.items) if (await can(ctx, "read", data)) out.push(data);
      return out.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
    },

    /** Puts a trashed item back. It needs a live parent folder. */
    async restore(ctx: Ctx, id: string, opts: { parentId?: string; onConflict?: OnConflict } = {}): Promise<Node> {
      return store.transaction(async (tx) => {
        const node = await fetch(tx, ctx, id);
        if (!node || node.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
        if (!node.trashed) throw new DriveError("NOT_TRASHED", `${node.name} is not in the trash`);
        await need(ctx, "write", node);
        const parent = await fetch(tx, ctx, opts.parentId ?? node.parentId);
        if (!parent || parent.kind !== "folder" || !(await isLive(tx, ctx, parent))) {
          throw new DriveError("PARENT_GONE", `the folder of ${node.name} is gone or in the trash`);
        }
        let { name, key } = parseName(node.name);
        if (await liveChild(tx, ctx, parent.id, key)) {
          if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
          name = await freeName(tx, ctx, parent.id, name);
          key = parseName(name).key;
        }
        const restored: Node = { ...node, parentId: parent.id, name, nameKey: key, trashed: false, trashedAt: null, updatedAt: now(), updatedBy: who(ctx) };
        await tx.put(NODES, restored.id, restored);
        return restored;
      });
    },

    /** Deletes a trashed item for good, with everything under it and all their bytes. */
    async purge(ctx: Ctx, id: string): Promise<{ removed: number }> {
      const keys: string[] = [];
      const removed = await store.transaction(async (tx) => {
        keys.length = 0;
        const top = await fetch(tx, ctx, id);
        if (!top || top.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
        if (!top.trashed) throw new DriveError("NOT_TRASHED", `${top.name} is not in the trash`);
        await need(ctx, "delete", top);
        let count = 0;
        for (const queue = [top]; queue.length; ) {
          const node = queue.pop() as Node;
          if (node.kind === "folder") queue.push(...(await children(tx, node.owner, node.id)));
          if (node.blobKey) keys.push(node.blobKey);
          await tx.delete(NODES, node.id);
          count++;
        }
        return count;
      });
      for (const key of keys) await blobs.delete(key);
      return { removed };
    },
  };
  return api;
}

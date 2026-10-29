import { MAX_FOLDER_DEPTH, type Blobs, type createSharing, type Doc, type PrincipalContext, type Resource, type Role, type Store, type StoreOps } from "agentic-identity";

export const ROOT_ID = "root";
const NODES = "drive_nodes";
/** One claim doc per live name. Its id is a hash of the owner, the folder, and the name. */
const NAMES = "drive_names";

export const ACTOR_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type Actor = { id: string; kind: ActorKind };
/**
 * `owner` is the drive's owner, and the root of the caller's chain. `actor` is who acts for them.
 * `principal` is the resolved caller. Drive needs it to check roles when `sharing` is set.
 */
export type Ctx = { owner: string; actor: Actor; principal?: PrincipalContext };
/** `delete` is for the owner only: purge and erase. Trash needs `write`. */
export type Action = "read" | "write" | "delete";
export type Sharing = ReturnType<typeof createSharing>;
/** The seam for access. With `sharing`, the default is a role check through agentic-identity. */
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
  /** The ids of `createdBy` and `updatedBy`, at the top level so a store can find what a person made. */
  createdById: string;
  updatedById: string;
  trashed: boolean;
  trashedAt: number | null;
  /** Set while a purge deletes the item. Nothing can see or change it then. */
  purging: boolean;
};

export type ErrorCode =
  | "NOT_FOUND" | "NAME_TAKEN" | "BLOB_EXISTS" | "INVALID_NAME" | "INVALID_PATH" | "INVALID_REF" | "NOT_A_FOLDER" | "NOT_A_FILE"
  | "MOVE_INTO_SELF" | "TOO_DEEP" | "PARENT_GONE" | "TRASHED" | "NOT_TRASHED" | "IS_ROOT" | "FORBIDDEN" | "BLOB_MISSING" | "TOO_LARGE" | "INVALID_EXPIRY" | "BUSY" | "CROSS_DRIVE" | "INVALID_SHARE" | "TOO_MANY_ITEMS";

export class DriveError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DriveError";
  }
}

export interface SearchQuery {
  /** Part of the name. Case and Unicode form do not matter. */
  name?: string;
  /** An exact type, or a family such as `image/*`. */
  mime?: string;
  kind?: Node["kind"];
  minSize?: number;
  maxSize?: number;
  /** Items first made by this kind of actor, such as `agent_of_human`. */
  createdByKind?: ActorKind;
  /** Only references to documents of this app, such as `docs`. */
  app?: string;
  /** At most this many results. Defaults to 100. */
  limit?: number;
}

export type OnConflict = "fail" | "rename" | "replace";
export interface DriveDeps {
  store: Store;
  blobs: Blobs;
  now?: () => number;
  newId?: () => string;
  can?: Can;
  /** Turns on roles. Folders and files register as resources, and `can()` decides every request. Make it on the same `store`. */
  sharing?: Sharing;
  /** Most parent steps any ancestor walk takes. A walk that hits it fails closed. */
  maxDepth?: number;
  /** Called with a blob key that no node points at and that could not be deleted. */
  onOrphan?: (key: string, error: unknown) => void;
}

export type Drive = ReturnType<typeof createDrive>;

const MAX_PATH_SEGMENTS = 64;
const DEFAULT_MAX_DEPTH = 256;
/** Nodes a purge marks or deletes in one transaction. A Worker call has a cap on database queries. */
const CHUNK = 25;
/** With sharing, each node costs about three more queries, so a chunk is smaller. */
const SHARED_CHUNK = 10;
/** The most queries a move or a restore spends to count the height of a subtree. */
const HEIGHT_BUDGET = 200;
export const DEFAULT_URL_SECONDS = 900;
export const MAX_URL_SECONDS = 3600;
const OPAQUE = "application/octet-stream";
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
/** Types a browser runs as a page or a script. They are stored as opaque bytes. */
const ACTIVE_TYPES = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "text/javascript",
  "application/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript", "text/css",
]);

/** The type to store for a claimed one. Malformed and active types become opaque bytes. */
export function safeMime(claimed: string | null | undefined): string {
  const type = (claimed ?? "").trim().toLowerCase();
  return MIME_SHAPE.test(type) && !ACTIVE_TYPES.has(type) ? type : OPAQUE;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REF = /^[a-z][a-z0-9_-]*:[^\s/]+$/;

/** Validates a name. Names are NFC-normalized. Two names clash when their keys match. */
export function parseName(raw: string): { name: string; key: string } {
  const name = raw.normalize("NFC");
  if (name.trim() === "" || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name) || name === "." || name === ".." || /[/\u0000-\u001f\u007f]/.test(name) || new TextEncoder().encode(name).length > 255) {
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
  if (parts.length > MAX_PATH_SEGMENTS) throw new DriveError("TOO_DEEP", `a path has at most ${MAX_PATH_SEGMENTS} segments`);
  return parts.map(parseName);
}

type Claim = { nodeId: string; owner: string; parentId: string };
type Write = { collection: string; id: string; doc: Doc | null };

/** The writes of one transaction. Every read comes first, then `apply` writes them all. */
function batch() {
  const writes: Write[] = [];
  /** Folders made in this batch. They have no children yet, so nobody needs to read them. */
  const fresh = new Set<string>();
  /** How deep the items made in this batch sit. The drive root is 0. */
  const depths = new Map<string, number>();
  return {
    fresh,
    depths,
    put: (collection: string, id: string, doc: Doc) => void writes.push({ collection, id, doc }),
    remove: (collection: string, id: string) => void writes.push({ collection, id, doc: null }),
    async apply(ops: StoreOps) {
      for (const w of writes) await (w.doc ? ops.put(w.collection, w.id, w.doc) : ops.delete(w.collection, w.id));
    },
  };
}

const claimId = (owner: string, parentId: string, key: string) => sha256Hex(new TextEncoder().encode(`${owner}\0${parentId}\0${key}`));

/** The sharing resource of a drive's root folder. One per owner. */
export const rootResource = async (owner: string) => `drive-root-${(await sha256Hex(new TextEncoder().encode(owner))).slice(0, 32)}`;
const ACTION_TO_IDENTITY = { read: "read", write: "write", delete: "admin" } as const;
/** Sharing follows a path of at most MAX_FOLDER_DEPTH resources, the drive root included. Deeper items could not be reached. */
const MAX_ITEM_DEPTH = MAX_FOLDER_DEPTH - 1;
/** Stands for a link visitor. A visitor never reads a drive root, so no caller sees it. */
const VISITOR: Actor = { id: "", kind: "human" };
/** The app that owns the document a reference points at: `docs` for `docs:abc`. Files have none. */
const appOf = (node: Node): string | null => (node.kind === "ref" && node.ref ? (node.ref.split(":")[0] as string) : null);
/** Stands in for the id of an erased person on items that other people own. */
const ERASED = "erased";
const SHARE_ERROR = /^(invalid|give an|expiresAt|expiresInMs|resource exists|the last owner)/;

export function createDrive(deps: DriveDeps) {
  const { store, blobs } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const onOrphan = deps.onOrphan ?? ((key: string, error: unknown) =>
    console.error(`orphan blob ${key}: ${error instanceof Error ? error.name : "delete failed"}`));
  const sharing = deps.sharing;
  const resourceOf = async (node: Node) => (node.id === ROOT_ID ? rootResource(node.owner) : node.id);
  const can: Can =
    deps.can ??
    (sharing
      ? async (ctx, action, node) => ctx.principal !== undefined && (await sharing.can(ctx.principal, ACTION_TO_IDENTITY[action], await resourceOf(node))).allowed
      : (ctx, _action, node) => node.owner === ctx.owner);

  const rootNode = (owner: string, by: Actor): Node => ({
    id: ROOT_ID, owner, parentId: "", kind: "folder", name: "", nameKey: "", size: 0, mime: null, hash: null,
    ref: null, blobKey: null, createdAt: 0, updatedAt: 0, createdBy: by, updatedBy: by, createdById: by.id, updatedById: by.id, trashed: false, trashedAt: null, purging: false,
  });
  const who = (ctx: Ctx): Actor => ({ id: ctx.actor.id, kind: ctx.actor.kind });
  /** The author fields of a node that `ctx` changes. A node from before the id fields gets its `createdById` here. */
  const stamp = (ctx: Ctx, node: Node) => ({ createdById: node.createdById ?? node.createdBy.id, updatedBy: who(ctx), updatedById: ctx.actor.id });
  /** What a node is, to sharing: the item itself, and its folder (or the drive root) above it. */
  const resourceDoc = async (node: Node, parent: Node): Promise<Resource> => ({ id: node.id, type: "drive", parentId: await resourceOf(parent) });

  /** A node with no permission check. Use it to walk ancestors, which a person with a shared folder may not read. */
  async function rawNode(ops: StoreOps, id: string, owner: string, by: Actor, withMarked = false): Promise<Node | null> {
    const node = id === ROOT_ID ? rootNode(owner, by) : await ops.get<Node>(NODES, id);
    return node && (withMarked || node.purging !== true) ? node : null;
  }
  /** A node the caller may read, or null. A node the caller may not read looks like a node that is not there. */
  async function fetch(ops: StoreOps, ctx: Ctx, id: string, purgeAgain = false): Promise<Node | null> {
    const node = await rawNode(ops, id, ctx.owner, ctx.actor, purgeAgain);
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
  /**
   * Who holds a name in a folder. `taken` is true for any claim doc, even one that names no live item:
   * a claim that cannot be explained still blocks the name. `node` is set only for a live item.
   */
  async function claimed(ops: StoreOps, owner: string, parentId: string, key: string) {
    const claim = await ops.get<Claim>(NAMES, await claimId(owner, parentId, key));
    const found = claim ? await ops.get<Node>(NODES, claim.nodeId) : null;
    const node = found && !found.trashed && found.purging !== true && found.parentId === parentId && found.nameKey === key ? found : null;
    return { taken: claim !== null, node };
  }
  const liveChild = async (ops: StoreOps, folder: Node, key: string) => (await claimed(ops, folder.owner, folder.id, key)).node;

  /** True when the node and each ancestor are out of the trash. */
  async function isLive(ops: StoreOps, ctx: Ctx, node: Node) {
    for (let n: Node | null = node, depth = 0; n && depth < maxDepth; depth++) {
      if (n.trashed) return false;
      if (n.id === ROOT_ID) return true;
      n = await rawNode(ops, n.parentId, n.owner, ctx.actor);
    }
    return false;
  }

  /** How many folders sit between a node and the drive root, the node included. */
  async function depthOf(ops: StoreOps, w: ReturnType<typeof batch>, node: Node): Promise<number> {
    let depth = 0;
    for (let n: Node | null = node; n && n.id !== ROOT_ID; ) {
      const known = w.depths.get(n.id);
      if (known !== undefined) return depth + known;
      if (++depth > MAX_ITEM_DEPTH) return depth;
      n = await rawNode(ops, n.parentId, n.owner, node.createdBy);
      // A missing ancestor is a broken tree. Count it as too deep, so nothing new goes under it.
      if (n === null) return MAX_ITEM_DEPTH + 1;
    }
    return depth;
  }
  /**
   * How many levels of items sit below a folder, counted from its subfolders only: 1 for a folder with no
   * subfolders (items may sit in it), and one more for each level of subfolders. File pages are never read.
   * It spends at most HEIGHT_BUDGET queries, and refuses a bigger tree, so a call never runs past a query cap.
   */
  async function heightOf(ops: StoreOps, folder: Node): Promise<number> {
    let level = [folder];
    let queries = 0;
    for (let height = 1; height <= MAX_ITEM_DEPTH; height++) {
      const next: Node[] = [];
      for (const f of level) {
        for (let cursor: string | undefined; ; ) {
          if (++queries > HEIGHT_BUDGET) throw new DriveError("TOO_MANY_ITEMS", `${folder.name} has too many folders to count. Move its parts one by one.`);
          const page = await ops.query<Node>(NODES, { where: { owner: f.owner, parentId: f.id, kind: "folder" }, limit: 100, cursor });
          next.push(...page.items.map((item) => item.data));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
      }
      if (next.length === 0) return height;
      level = next;
    }
    return MAX_ITEM_DEPTH + 1;
  }
  /**
   * The height to check for a folder that moves under `dest`. It is 0 when the folder cannot get deeper:
   * a file, a rename in place, or a move up or sideways. Then nothing is counted.
   */
  async function heightFor(ctx: Ctx, node: Node, dest: Node | string): Promise<number> {
    if (!sharing || node.kind !== "folder") return 0;
    const target = typeof dest === "string" ? await resolve(store, ctx, dest) : dest;
    if (target.id === node.parentId) return 0;
    const w = batch();
    if ((await depthOf(store, w, target)) + 1 <= (await depthOf(store, w, node))) return 0;
    return heightOf(store, node);
  }
  /** An item takes the roles of its new folder. A caller may not climb to owner by moving an item they only edit. */
  async function noClimb(ctx: Ctx, node: Node, dest: Node) {
    // Compare the roles of the person at the root of the chain. An agent's scopes would hide a role, so lift them here.
    const person: Ctx = ctx.principal ? { ...ctx, principal: { ...ctx.principal, scopes: ["drive:admin"] } } : ctx;
    if ((await can(person, "delete", dest)) && !(await can(person, "delete", node))) {
      throw new DriveError("FORBIDDEN", "moving into a folder you own needs owner on the item");
    }
  }
  /** Fails when a node, with `height` levels of items below it, would sit deeper than sharing can follow under `dest`. */
  async function fitsUnder(ops: StoreOps, w: ReturnType<typeof batch>, dest: Node, height: number) {
    if (sharing && (await depthOf(ops, w, dest)) + 1 + height > MAX_ITEM_DEPTH) {
      throw new DriveError("TOO_DEEP", `an item can sit at most ${MAX_ITEM_DEPTH} folders deep`);
    }
  }

  /**
   * The folder a path starts from, and its segments. A path that starts with "/" begins at the caller's
   * own root. A path such as `<folder id>/a/b` begins at that folder, which the caller reads by a share.
   */
  async function startOf(ops: StoreOps, ctx: Ctx, loc: string) {
    if (loc.startsWith("/")) {
      // Walking a path shows what exists. A caller with no read on the drive learns nothing.
      const start = rootNode(ctx.owner, ctx.actor);
      if (!(await can(ctx, "read", start))) throw new DriveError("NOT_FOUND", `no item ${loc}`);
      return { start, segs: splitPath(loc) };
    }
    const slash = loc.indexOf("/");
    const base = await resolve(ops, ctx, loc.slice(0, slash));
    if (base.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${base.name} is not a folder`);
    return { start: base, segs: splitPath(`/${loc.slice(slash + 1)}`) };
  }

  /** A locator with no "/" is an id. Any other is a path, from the root or from a folder id. */
  async function resolve(ops: StoreOps, ctx: Ctx, loc: string): Promise<Node> {
    if (!loc.includes("/")) {
      const node = await fetch(ops, ctx, loc);
      if (!node) throw new DriveError("NOT_FOUND", `no item ${loc}`);
      if (!(await isLive(ops, ctx, node))) throw new DriveError("TRASHED", `${loc} is in the trash`);
      return node;
    }
    const { start, segs } = await startOf(ops, ctx, loc);
    let node = start;
    for (const seg of segs) {
      if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
      const next = await liveChild(ops, node, seg.key);
      if (!next) throw new DriveError("NOT_FOUND", `no item ${loc}`);
      node = next;
    }
    // Read on the start does not prove read on the item: its sharing record may be missing or too deep.
    if (!(await can(ctx, "read", node))) throw new DriveError("NOT_FOUND", `no item ${loc}`);
    return node;
  }

  /** "a.txt" taken: try "a (2).txt", "a (3).txt", and so on. */
  async function freeName(ops: StoreOps, owner: string, parentId: string, name: string) {
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})${ext}`;
      if (!(await claimed(ops, owner, parentId, parseName(candidate).key)).taken) return candidate;
    }
  }

  /** Walks the parents of a path. With `create`, missing folders are added to the batch. */
  async function folderAt(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, start: Node, segs: ReturnType<typeof splitPath>, create: boolean) {
    let node = start;
    for (const seg of segs) {
      if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
      let next = w.fresh.has(node.id) ? null : await liveChild(ops, node, seg.key);
      if (!next) {
        if (!create) throw new DriveError("NOT_FOUND", `no folder ${seg.name}`);
        next = (await insert(ops, w, ctx, node, seg.name, { kind: "folder" }, "fail")).node;
        w.fresh.add(next.id);
      }
      node = next;
    }
    if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
    return node;
  }

  type NewFields = Partial<Pick<Node, "kind" | "size" | "mime" | "hash" | "ref" | "blobKey">>;
  /** A new item belongs to the drive of its folder's owner, whoever adds it. */
  async function insert(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, parent: Node, rawName: string, fields: NewFields, onConflict: OnConflict) {
    let { name, key } = parseName(rawName);
    const empty = w.fresh.has(parent.id);
    if (!empty) await need(ctx, "write", parent);
    const slot = empty ? null : await claimed(ops, parent.owner, parent.id, key);
    if (slot?.taken) {
      if (onConflict === "replace" && slot.node?.kind === "file" && fields.kind === "file") {
        const node: Node = { ...slot.node, ...fields, updatedAt: now(), ...stamp(ctx, slot.node) } as Node;
        w.put(NODES, node.id, node);
        return { node, replacedBlob: slot.node.blobKey };
      }
      if (onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
      name = await freeName(ops, parent.owner, parent.id, name);
      key = parseName(name).key;
    }
    const id = newId();
    if (sharing) {
      const depth = (await depthOf(ops, w, parent)) + 1;
      if (depth > MAX_ITEM_DEPTH) throw new DriveError("TOO_DEEP", `an item can sit at most ${MAX_ITEM_DEPTH} folders deep`);
      w.depths.set(id, depth);
    }
    const t = now();
    const node: Node = {
      id, owner: parent.owner, parentId: parent.id, kind: "file", name, nameKey: key, size: 0, mime: null, hash: null,
      ref: null, blobKey: null, createdAt: t, updatedAt: t, createdBy: who(ctx), updatedBy: who(ctx), createdById: ctx.actor.id, updatedById: ctx.actor.id, trashed: false, trashedAt: null, purging: false,
      ...fields,
    };
    w.put(NODES, node.id, node);
    w.put(NAMES, await claimId(parent.owner, parent.id, key), { nodeId: node.id, owner: parent.owner, parentId: parent.id });
    if (sharing) w.put("resources", node.id, await resourceDoc(node, parent));
    return { node, replacedBlob: null as string | null };
  }

  /** Splits a path into its parent folder and the new item's name. */
  async function parentAndName(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, path: string, parents: boolean) {
    const { start, segs } = await startOf(ops, ctx, path);
    const last = segs.pop();
    if (!last) throw start.id === ROOT_ID ? new DriveError("IS_ROOT", "the root already exists") : new DriveError("INVALID_PATH", "name an item inside the folder");
    return { parent: await folderAt(ops, w, ctx, start, segs, parents), name: last.name };
  }

  async function relocate(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, node: Node, destLoc: string | Node, opts: { name?: string; onConflict?: OnConflict; height?: number }) {
    if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot change the root");
    const dest = typeof destLoc === "string" ? await resolve(ops, ctx, destLoc) : destLoc;
    if (dest.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${dest.name} is not a folder`);
    if (dest.owner !== node.owner) throw new DriveError("CROSS_DRIVE", "an item cannot move into another person's drive");
    // Walk from the destination up to the root. Any gap or overrun refuses the move.
    for (let n = dest, depth = 0; n.id !== ROOT_ID; depth++) {
      if (n.id === node.id) throw new DriveError("MOVE_INTO_SELF", `cannot move ${node.name} into itself`);
      if (depth >= maxDepth) throw new DriveError("TOO_DEEP", `the destination is deeper than ${maxDepth} folders`);
      const parent = await rawNode(ops, n.parentId, n.owner, ctx.actor);
      if (!parent) throw new DriveError("NOT_FOUND", `a parent folder of ${dest.name} is missing`);
      n = parent;
    }
    await need(ctx, "write", node);
    // A change inside the same folder is a rename. It needs no right on the folder.
    if (dest.id !== node.parentId) {
      await need(ctx, "write", dest);
      await noClimb(ctx, node, dest);
      await fitsUnder(ops, w, dest, opts.height ?? 0);
    }
    let { name, key } = parseName(opts.name ?? node.name);
    const slot = await claimed(ops, dest.owner, dest.id, key);
    if (slot.taken && slot.node?.id !== node.id) {
      if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
      name = await freeName(ops, dest.owner, dest.id, name);
      key = parseName(name).key;
    }
    const moved: Node = { ...node, parentId: dest.id, name, nameKey: key, updatedAt: now(), ...stamp(ctx, node) };
    w.put(NODES, moved.id, moved);
    const [from, to] = [await claimId(node.owner, node.parentId, node.nameKey), await claimId(dest.owner, dest.id, key)];
    if (from !== to) {
      // Release only a claim that this item holds.
      if ((await ops.get<Claim>(NAMES, from))?.nodeId === node.id) w.remove(NAMES, from);
      w.put(NAMES, to, { nodeId: moved.id, owner: dest.owner, parentId: dest.id });
    }
    // The role an item inherits follows its folder.
    if (sharing && dest.id !== node.parentId) w.put("resources", moved.id, await resourceDoc(moved, dest));
    return moved;
  }

  /** True only when a query proves no node holds the key. An unreadable store keeps the blob. */
  async function isUnreferenced(blobKey: string) {
    try {
      return (await store.query<Node>(NODES, { where: { blobKey }, limit: 1 })).items.length === 0;
    } catch (error) {
      onOrphan(blobKey, error);
      return false;
    }
  }
  async function dropBlob(key: string) {
    try {
      await blobs.delete(key);
    } catch (error) {
      onOrphan(key, error);
    }
  }
  /** Every item of one owner, with no permission check. Marked items only on request. */
  async function rawOwnerNodes(owner: string, withMarked: boolean): Promise<Node[]> {
    const out: Node[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await store.query<Node>(NODES, { where: { owner }, limit: 100, cursor });
      out.push(...page.items.map((item) => item.data).filter((node) => withMarked || node.purging !== true));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }
  async function ownerNodes(ctx: Ctx, withMarked = false): Promise<Node[]> {
    if (!(await can(ctx, "read", rootNode(ctx.owner, ctx.actor)))) throw new DriveError("FORBIDDEN", "not allowed to read this drive");
    return rawOwnerNodes(ctx.owner, withMarked);
  }
  /** The path of a node, built from a map of all the owner's nodes. Null when the node or an ancestor is trashed. */
  function pathIn(byId: Map<string, Node>, node: Node, liveOnly: boolean): string | null {
    const names: string[] = [];
    for (let n: Node | undefined = node, depth = 0; depth < 1000; depth++) {
      if (!n) return liveOnly ? null : `/(orphan)/${names.reverse().join("/")}`;
      if (liveOnly && n.trashed) return null;
      names.push(n.name);
      if (n.parentId === ROOT_ID) return `/${names.reverse().join("/")}`;
      n = byId.get(n.parentId);
    }
    return null;
  }

  /**
   * A transaction that loses a name race runs again, finds the claim, and fails with NAME_TAKEN.
   * One that keeps losing for another reason gives up, and the store says so in its message.
   */
  async function transact<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R> {
    try {
      return await store.transaction(fn);
    } catch (error) {
      if (error instanceof Error && /transaction kept conflicting/.test(error.message)) throw new DriveError("BUSY", "the drive changed at the same time. Try again.");
      throw error;
    }
  }

  /** Only the owner in person, never an agent for them, may do what cannot be undone. */
  function assertInPerson(ctx: Ctx, what: string) {
    if (!isInPerson(ctx) || ctx.actor.kind !== "human") throw new DriveError("FORBIDDEN", `only the owner in person can ${what}`);
  }
  /** The person behind a call: the root of the chain. The kind is null unless the chain or the person in person says it. */
  const subjectOf = (ctx: Ctx) => ({ id: ctx.owner, kind: ctx.principal?.chain[0]?.kind ?? (isInPerson(ctx) ? ctx.actor.kind : null) });
  /** Every doc of a collection that matches every field, page by page. */
  async function allWhere(ops: StoreOps, collection: string, where: Record<string, string>, orderBy?: { field: string }) {
    const out: { id: string; data: Doc }[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await ops.query(collection, { where, ...(orderBy ? { orderBy } : {}), limit: 100, cursor });
      out.push(...page.items);
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }
  /** True when the caller is the person in person, not an agent for them. */
  const isInPerson = (ctx: Ctx) => ctx.principal === undefined ? ctx.actor.kind === "human" && ctx.actor.id === ctx.owner : ctx.principal.kind === "human" && ctx.principal.chain.length === 1 && ctx.actor.id === ctx.owner;
  /** The most principals that belong to one person. A person with more cannot be erased: erase would miss some. */
  const MAX_ACTORS = 1000;
  /**
   * The person and every agent of theirs, from the `principals` collection, as identity finds them: agents with
   * their own identity name the person as `ownerId`, and delegated agents name their parent as `parentId`.
   */
  async function actorsOf(ops: StoreOps, id: string): Promise<{ actors: string[]; ownedAgents: string[] }> {
    const ownedAgents = (await allWhere(ops, "principals", { ownerId: id })).map((p) => p.id);
    const actors = [id, ...ownedAgents];
    for (let depth = 0, from = 0; from < actors.length && depth < 8; depth++) {
      const next = actors.length;
      for (; from < next; from++) for (const child of await allWhere(ops, "principals", { parentId: actors[from]! })) if (!actors.includes(child.id)) actors.push(child.id);
      if (actors.length > MAX_ACTORS) throw new DriveError("TOO_MANY_ITEMS", `a person can have at most ${MAX_ACTORS} agents here`);
    }
    return { actors, ownedAgents };
  }
  /** Items that any of these actors made or changed. A node from before the author ids existed is found by `createdBy` only when it also has an id field. */
  async function madeBy(ops: StoreOps, actors: string[]): Promise<Node[]> {
    const made = new Map<string, Node>();
    for (const actor of actors) for (const field of ["createdById", "updatedById"]) for (const { data } of await allWhere(ops, NODES, { [field]: actor })) made.set(data.id as string, data as Node);
    return [...made.values()];
  }

  /** Deletes every item and blob of one owner, and the shares of the drive root. The caller has checked the right. */
  async function eraseDrive(owner: string): Promise<number> {
    let removed = 0;
    // A file created during a pass shows up in the next one.
    for (let pass = 0; pass < 5; pass++) {
      const all = await rawOwnerNodes(owner, true);
      if (all.length === 0) {
        // The root has shares too. Erase them, so an old share never reaches a new file.
        const rootId = await rootResource(owner);
        await transact(async (tx) => {
          const shares = sharing ? await sharesOf(tx, rootId) : [];
          for (const share of shares) await tx.delete(share.collection, share.id);
          if (sharing) await tx.delete("resources", rootId);
        });
        return removed;
      }
      removed += await removeNodes(all);
    }
    throw new DriveError("BUSY", "the drive kept changing while it was deleted. Run it again.");
  }

  /** Every grant, link, and invite of one resource, page by page. */
  async function sharesOf(ops: StoreOps, resourceId: string) {
    const out: { collection: string; id: string }[] = [];
    for (const collection of ["grants", "links", "invites"]) {
      for (let cursor: string | undefined; ; ) {
        const page = await ops.query(collection, { where: { resourceId }, limit: 100, cursor });
        out.push(...page.items.map((item) => ({ collection, id: item.id })));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    return out;
  }

  /**
   * Deletes nodes for good, and returns how many it deleted. Step 1 marks each node that still looks as
   * it did when it was read. A marked node is invisible and cannot be restored, moved, or changed, so
   * nothing can bring it back while its bytes go. A node that changed before its mark stays untouched,
   * with its bytes and its name. With a `top` item, parents come before children, and a node is marked
   * only when its parent is: a subtree that a restore moved out is skipped whole. If the top item
   * changed, nothing is deleted. Step 2 deletes the blobs of the marked nodes, then their rows
   * (children first) and their claims. Work comes in small chunks, and each chunk commits, so a call
   * that fails or runs out of time leaves progress behind. Nodes that an earlier call marked need no
   * new mark, so the same call can run again until it is done.
   */
  async function removeNodes(nodes: Node[], top?: Node): Promise<number> {
    const unchanged = (now: Node | null, seen: Node) =>
      now !== null && now.trashed === seen.trashed && now.parentId === seen.parentId && now.updatedAt === seen.updatedAt;
    const size = sharing ? SHARED_CHUNK : CHUNK;
    const marked: Node[] = [];
    const markedIds = new Set<string>();
    for (let i = 0; i < nodes.length; i += size) {
      const slice = nodes.slice(i, i + size);
      for (const node of slice) {
        if (node.purging === true) {
          marked.push(node);
          markedIds.add(node.id);
        }
      }
      const found = await transact(async (tx) => {
        const out: Node[] = [];
        const ids = new Set(markedIds);
        for (const node of slice) {
          if (node.purging === true) continue;
          if (top && node.id !== top.id && !ids.has(node.parentId)) continue;
          const current = await tx.get<Node>(NODES, node.id);
          if (unchanged(current, node)) {
            out.push(current as Node);
            ids.add(node.id);
          }
        }
        for (const node of out) await tx.put(NODES, node.id, { ...node, purging: true });
        return out;
      });
      for (const node of found) {
        marked.push(node);
        markedIds.add(node.id);
      }
      if (top && i === 0 && !markedIds.has(top.id)) throw new DriveError("BUSY", `${top.name} changed during the purge. Nothing was deleted.`);
    }
    const rows = marked.reverse();
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      for (const node of chunk) if (node.blobKey) await blobs.delete(node.blobKey);
      await transact(async (tx) => {
        const held: { node: Node; claim: string | null; owns: boolean; shares: { collection: string; id: string }[] }[] = [];
        for (const node of chunk) {
          // A trashed item gave up its name when it was trashed, and another item may hold it now.
          const claim = node.trashed ? null : await claimId(node.owner, node.parentId, node.nameKey);
          // The shares of a deleted item go with it: its grants, links, and invites.
          const shares = sharing ? await sharesOf(tx, node.id) : [];
          held.push({ node, claim, owns: claim !== null && (await tx.get<Claim>(NAMES, claim))?.nodeId === node.id, shares });
        }
        for (const { node, claim, owns, shares } of held) {
          await tx.delete(NODES, node.id);
          if (claim && owns) await tx.delete(NAMES, claim);
          if (sharing) await tx.delete("resources", node.id);
          for (const share of shares) await tx.delete(share.collection, share.id);
        }
      });
    }
    return marked.length;
  }

  /**
   * Reads an item for a link visitor (`principal` null) or a signed-in person who holds a link.
   * Anyone who is denied gets NOT_FOUND, so a stranger cannot tell which ids exist.
   */
  async function openShared(principal: PrincipalContext | null, id: string, linkToken?: string): Promise<Node> {
    if (!sharing) throw new DriveError("INVALID_SHARE", "sharing is not set up");
    const node = await rawNode(store, id, "", VISITOR);
    if (!node || node.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
    const decision = await sharing.can(principal, "read", id, linkToken === undefined ? {} : { linkToken });
    if (!decision.allowed) throw new DriveError("NOT_FOUND", `no item ${id}`);
    if (!(await isLive(store, { owner: node.owner, actor: node.createdBy }, node))) throw new DriveError("TRASHED", `${id} is in the trash`);
    return node;
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
        .filter((n) => !n.trashed && n.purging !== true)
        .sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : a.name < b.name ? -1 : 1));
    },

    async mkdir(ctx: Ctx, path: string, opts: { parents?: boolean } = {}): Promise<Node> {
      return transact(async (tx) => {
        const w = batch();
        const { parent, name } = await parentAndName(tx, w, ctx, path, opts.parents ?? false);
        const existing = w.fresh.has(parent.id) ? null : await liveChild(tx, parent, parseName(name).key);
        if (opts.parents && existing?.kind === "folder") {
          if (!(await can(ctx, "read", existing))) throw new DriveError("NOT_FOUND", `no item ${path}`);
          return existing;
        }
        const { node } = await insert(tx, w, ctx, parent, name, { kind: "folder" }, "fail");
        await w.apply(tx);
        return node;
      });
    },

    /**
     * Stores one blob and one node. The blob is written first. The new node commits before
     * any old blob goes. A failed old-blob delete leaves an orphan and never undoes the commit.
     */
    async putFile(ctx: Ctx, path: string, data: Uint8Array, opts: { mime?: string; parents?: boolean; onConflict?: OnConflict } = {}): Promise<Node> {
      const mime = opts.mime === undefined ? null : safeMime(opts.mime);
      const hash = await sha256Hex(data);
      const blobKey = `blobs/${newId()}`;
      const stored = await blobs.put(blobKey, data, { ifNoneMatch: "*", ...(mime ? { contentType: mime } : {}) });
      if (!stored) throw new DriveError("BLOB_EXISTS", "a blob with this key already exists");
      let committed: { node: Node; replacedBlob: string | null };
      try {
        committed = await transact(async (tx) => {
          const w = batch();
          const { parent, name } = await parentAndName(tx, w, ctx, path, opts.parents ?? false);
          const result = await insert(tx, w, ctx, parent, name, { kind: "file", size: data.byteLength, mime, hash, blobKey }, opts.onConflict ?? "fail");
          await w.apply(tx);
          return result;
        });
      } catch (error) {
        // The commit may have landed before the error. Keep the blob unless no node holds it.
        if (await isUnreferenced(blobKey)) await dropBlob(blobKey);
        throw error;
      }
      if (committed.replacedBlob) await dropBlob(committed.replacedBlob);
      return committed.node;
    },

    /** A reference points at a document in another app, such as `docs:<id>`. */
    async putRef(ctx: Ctx, path: string, ref: string, opts: { parents?: boolean; onConflict?: OnConflict } = {}): Promise<Node> {
      if (!REF.test(ref)) throw new DriveError("INVALID_REF", `a reference looks like "docs:<id>", got ${JSON.stringify(ref)}`);
      return transact(async (tx) => {
        const w = batch();
        const { parent, name } = await parentAndName(tx, w, ctx, path, opts.parents ?? false);
        const { node } = await insert(tx, w, ctx, parent, name, { kind: "ref", ref }, opts.onConflict === "replace" ? "fail" : opts.onConflict ?? "fail");
        await w.apply(tx);
        return node;
      });
    },

    async read(ctx: Ctx, loc: string): Promise<{ node: Node; data: Uint8Array; contentType?: string }> {
      const node = await resolve(store, ctx, loc);
      if (node.kind !== "file" || !node.blobKey) throw new DriveError("NOT_A_FILE", `${node.name} is not a file`);
      const blob = await blobs.get(node.blobKey);
      if (!blob) throw new DriveError("BLOB_MISSING", `the bytes of ${node.name} are missing`);
      return { node, ...blob };
    },

    /**
     * A time-limited URL to fetch the bytes. The URL signs an attachment header and the stored
     * type, so the link holder cannot change how the bytes are served. Trashing an item does
     * not revoke a link already issued.
     */
    async downloadUrl(ctx: Ctx, loc: string, expiresInSeconds = DEFAULT_URL_SECONDS): Promise<string> {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_URL_SECONDS) {
        throw new DriveError("INVALID_EXPIRY", `a link lasts 1 to ${MAX_URL_SECONDS} seconds`);
      }
      const node = await resolve(store, ctx, loc);
      if (node.kind !== "file" || !node.blobKey) throw new DriveError("NOT_A_FILE", `${node.name} is not a file`);
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(node.name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
      return blobs.signedUrl(node.blobKey, {
        method: "GET", expiresInSeconds,
        responseContentDisposition: disposition.length <= 1024 ? disposition : "attachment",
        responseContentType: node.mime ?? "application/octet-stream",
      });
    },

    async move(ctx: Ctx, src: string, destLoc: string, opts: { name?: string; onConflict?: OnConflict } = {}): Promise<Node> {
      // The height of a moved folder is read once, outside the transaction, so the transaction stays short.
      const probe = sharing ? await resolve(store, ctx, src) : null;
      const height = probe ? await heightFor(ctx, probe, destLoc) : 0;
      return transact(async (tx) => {
        const w = batch();
        const moved = await relocate(tx, w, ctx, await resolve(tx, ctx, src), destLoc, { ...opts, height });
        await w.apply(tx);
        return moved;
      });
    },

    async rename(ctx: Ctx, loc: string, name: string): Promise<Node> {
      return transact(async (tx) => {
        const w = batch();
        const node = await resolve(tx, ctx, loc);
        if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot change the root");
        const parent = await rawNode(tx, node.parentId, node.owner, ctx.actor);
        if (!parent) throw new DriveError("NOT_FOUND", `the folder of ${node.name} is missing`);
        const renamed = await relocate(tx, w, ctx, node, parent, { name });
        await w.apply(tx);
        return renamed;
      });
    },

    /** Hides an item and, for a folder, everything under it. Nothing else changes. */
    async trash(ctx: Ctx, loc: string): Promise<Node> {
      return transact(async (tx) => {
        const node = await resolve(tx, ctx, loc);
        if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot trash the root");
        await need(ctx, "write", node);
        const claim = await claimId(node.owner, node.parentId, node.nameKey);
        const held = await tx.get<Claim>(NAMES, claim);
        const t = now();
        const trashed: Node = { ...node, trashed: true, trashedAt: t, updatedAt: t, ...stamp(ctx, node) };
        await tx.put(NODES, node.id, trashed);
        // Trashing frees the name. Release only a claim that this item holds.
        if (held?.nodeId === node.id) await tx.delete(NAMES, claim);
        return trashed;
      });
    },

    /** Items trashed on their own, newest first. */
    async listTrash(ctx: Ctx): Promise<Node[]> {
      await need(ctx, "read", rootNode(ctx.owner, ctx.actor));
      const page = await store.query<Node>(NODES, { where: { owner: ctx.owner, trashed: true }, limit: 1000 });
      const out: Node[] = [];
      for (const { data } of page.items) if (data.purging !== true) out.push(data);
      return out.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
    },

    /** Puts a trashed item back. It needs a live parent folder. */
    async restore(ctx: Ctx, id: string, opts: { parentId?: string; onConflict?: OnConflict } = {}): Promise<Node> {
      // Only a caller who may read both the folder and the new parent makes the store count the subtree.
      let height = 0;
      if (sharing && opts.parentId !== undefined) {
        const probe = await fetch(store, ctx, id);
        const target = await rawNode(store, opts.parentId, ctx.owner, ctx.actor);
        if (probe?.trashed && target && (await can(ctx, "read", target))) height = await heightFor(ctx, probe, target);
      }
      return transact(async (tx) => {
        const node = await fetch(tx, ctx, id);
        if (!node || node.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
        if (!node.trashed) throw new DriveError("NOT_TRASHED", `${node.name} is not in the trash`);
        await need(ctx, "write", node);
        // A parent id the caller names is read from the caller's drive, so "root" is the caller's own root.
        const parent = opts.parentId === undefined ? await rawNode(tx, node.parentId, node.owner, ctx.actor) : await rawNode(tx, opts.parentId, ctx.owner, ctx.actor);
        // A caller must read a parent that it names. Missing, unreadable, and unusable parents all look the same.
        const visible = parent !== null && (opts.parentId === undefined || (await can(ctx, "read", parent)));
        if (!parent || !visible || parent.kind !== "folder" || !(await isLive(tx, ctx, parent))) {
          throw new DriveError("PARENT_GONE", `the folder of ${node.name} is gone or in the trash`);
        }
        if (parent.owner !== node.owner) throw new DriveError("CROSS_DRIVE", "an item cannot move into another person's drive");
        if (parent.id !== node.parentId) {
          await need(ctx, "write", parent);
          await noClimb(ctx, node, parent);
          await fitsUnder(tx, batch(), parent, height);
        }
        let { name, key } = parseName(node.name);
        if ((await claimed(tx, parent.owner, parent.id, key)).taken) {
          if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
          name = await freeName(tx, parent.owner, parent.id, name);
          key = parseName(name).key;
        }
        const restored: Node = { ...node, parentId: parent.id, name, nameKey: key, trashed: false, trashedAt: null, updatedAt: now(), ...stamp(ctx, node) };
        await tx.put(NODES, restored.id, restored);
        await tx.put(NAMES, await claimId(parent.owner, parent.id, key), { nodeId: restored.id, owner: parent.owner, parentId: parent.id });
        if (sharing && parent.id !== node.parentId) await tx.put("resources", restored.id, await resourceDoc(restored, parent));
        return restored;
      });
    },

    /** Live items that match every field given, sorted by path. */
    async search(ctx: Ctx, q: SearchQuery = {}): Promise<{ node: Node; path: string }[]> {
      const limit = q.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const all = await ownerNodes(ctx);
      const byId = new Map(all.map((n) => [n.id, n]));
      const needle = q.name?.normalize("NFC").toLowerCase();
      const hits: { node: Node; path: string }[] = [];
      for (const node of all) {
        const path = pathIn(byId, node, true);
        if (path === null || node.purging) continue;
        if (needle !== undefined && !node.nameKey.includes(needle)) continue;
        if (q.kind && node.kind !== q.kind) continue;
        if (q.mime && !(q.mime.endsWith("/*") ? node.mime?.startsWith(q.mime.slice(0, -1)) : node.mime === q.mime)) continue;
        if (q.minSize !== undefined && node.size < q.minSize) continue;
        if (q.maxSize !== undefined && node.size > q.maxSize) continue;
        if (q.createdByKind && node.createdBy.kind !== q.createdByKind) continue;
        if (q.app !== undefined && appOf(node) !== q.app) continue;
        hits.push({ node, path });
      }
      return hits.sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, limit);
    },

    /** Every item of the owner, trashed or not, with its original path and bytes. For export. */
    async exportData(ctx: Ctx): Promise<{ node: Node; path: string; data: Uint8Array | null; missing: boolean }[]> {
      const all = await ownerNodes(ctx);
      const byId = new Map(all.map((n) => [n.id, n]));
      const out: { node: Node; path: string; data: Uint8Array | null; missing: boolean }[] = [];
      for (const node of all.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const blob = node.blobKey ? await blobs.get(node.blobKey) : null;
        out.push({ node, path: pathIn(byId, node, false) as string, data: blob?.data ?? null, missing: node.blobKey !== null && !blob });
      }
      return out;
    },

    /** Deletes every item and blob of the owner for good. Only the owner may do this, never an agent for them. A failed call can run again. */
    async deleteAll(ctx: Ctx): Promise<{ removed: number }> {
      assertInPerson(ctx, "delete the whole drive");
      await need(ctx, "delete", rootNode(ctx.owner, ctx.actor));
      return { removed: await eraseDrive(ctx.owner) };
    },
    /** Deletes a trashed item for good, with everything under it and all their bytes. */
    async purge(ctx: Ctx, id: string): Promise<{ removed: number }> {
      const top = await fetch(store, ctx, id, true);
      if (!top || top.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
      if (!top.trashed) throw new DriveError("NOT_TRASHED", `${top.name} is not in the trash`);
      await need(ctx, "delete", top);
      // A trashed folder takes no new children, so one read pass sees the whole subtree.
      const nodes: Node[] = [];
      for (const queue = [top]; queue.length; ) {
        const node = queue.pop() as Node;
        nodes.push(node);
        if (node.kind === "folder") queue.push(...(await children(store, node.owner, node.id)));
      }
      return { removed: await removeNodes(nodes, top) };
    },

    /**
     * What the home view shows: every file and every reference to an app's document, newest change first.
     * `apps` counts references per app, and `files` counts plain files, before `app` and `limit` apply.
     */
    async home(ctx: Ctx, q: { app?: string; limit?: number } = {}) {
      const limit = q.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const all = await ownerNodes(ctx);
      const byId = new Map(all.map((n) => [n.id, n]));
      const apps: Record<string, number> = {};
      let files = 0;
      const items: { node: Node; path: string; app: string | null }[] = [];
      for (const node of all) {
        const path = pathIn(byId, node, true);
        if (path === null || node.kind === "folder") continue;
        const app = appOf(node);
        if (app === null) files++;
        else apps[app] = (apps[app] ?? 0) + 1;
        if (q.app === undefined || app === q.app) items.push({ node, path, app });
      }
      items.sort((x, y) => y.node.updatedAt - x.node.updatedAt || (x.path < y.path ? -1 : 1));
      return { items: items.slice(0, limit), apps, files };
    },

    /**
     * An app puts one of its documents in this drive, as a reference such as `docs:<id>`. A document that is
     * already in the drive comes back as it is, so an app can register again. The reference sits in `folder`
     * (a path or a folder id, "/" by default) under `name`, and gets a free name when that one is taken.
     */
    async registerDocument(ctx: Ctx, input: { ref: string; name: string; folder?: string }): Promise<Node> {
      if (!REF.test(input.ref)) throw new DriveError("INVALID_REF", `a reference looks like "docs:<id>", got ${JSON.stringify(input.ref)}`);
      parseName(input.name);
      await need(ctx, "read", rootNode(ctx.owner, ctx.actor));
      const dir = input.folder ?? "/";
      // A folder named by id may sit in another person's drive, where the reference belongs.
      const owner = dir.startsWith("/") ? ctx.owner : (await resolve(store, ctx, dir.split("/")[0] as string)).owner;
      for (const { data } of await allWhere(store, NODES, { owner, ref: input.ref })) {
        const node = data as Node;
        // A match the caller cannot read looks like no match.
        if (node.kind === "ref" && !node.trashed && node.purging !== true && (await isLive(store, ctx, node)) && (await can(ctx, "read", node))) return node;
      }
      return api.putRef(ctx, dir.endsWith("/") ? `${dir}${input.name}` : `${dir}/${input.name}`, input.ref, { parents: true, onConflict: "rename" });
    },

    /** An app deleted a document. Its references in this drive go to the trash. Returns how many. */
    async forgetDocument(ctx: Ctx, ref: string): Promise<{ trashed: number }> {
      if (!REF.test(ref)) throw new DriveError("INVALID_REF", `a reference looks like "docs:<id>", got ${JSON.stringify(ref)}`);
      await need(ctx, "read", rootNode(ctx.owner, ctx.actor));
      let trashed = 0;
      for (const { data } of await allWhere(store, NODES, { owner: ctx.owner, ref })) {
        if (data.kind !== "ref" || data.trashed || data.purging === true) continue;
        try {
          await api.trash(ctx, data.id as string);
          trashed++;
        } catch (error) {
          // A reference inside a folder that is already in the trash is hidden already.
          if (!(error instanceof DriveError && error.code === "TRASHED")) throw error;
        }
      }
      return { trashed };
    },

    /**
     * What drive holds about the person behind a call, besides their own drive (`exportData` has that). It is
     * only for the person in person: an agent gets `partial: true` and nothing else. It holds the ids of the
     * items they or their agents made or changed in other drives (no names, and nothing of the people who own
     * them), the shares they hold, the invites they sent, and the audit entries of what they and their agents
     * did. Invitee emails and link tokens are not in it.
     */
    async exportPerson(ctx: Ctx) {
      await need(ctx, "read", rootNode(ctx.owner, ctx.actor));
      const subject = subjectOf(ctx);
      if (!isInPerson(ctx)) return { subject, partial: true, authored: [], agents: [], shares: { held: [], invitesCreated: [] }, audit: [] };
      const { actors, ownedAgents } = await actorsOf(store, subject.id);
      const authored = (await madeBy(store, actors))
        .filter((n) => n.owner !== subject.id && n.purging !== true)
        .map((n) => ({
          id: n.id, kind: n.kind, created: actors.includes(n.createdById), updated: actors.includes(n.updatedById),
          createdAt: actors.includes(n.createdById) ? n.createdAt : null, updatedAt: actors.includes(n.updatedById) ? n.updatedAt : null,
          by: [...new Set([actors.includes(n.createdById) ? n.createdBy : null, actors.includes(n.updatedById) ? n.updatedBy : null].filter((a) => a !== null).map((a) => JSON.stringify(a)))].map((a) => JSON.parse(a as string)),
        }))
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      const held: { subjectId: unknown; resourceId: unknown; role: unknown }[] = [];
      for (const actor of actors) for (const g of await allWhere(store, "grants", { subjectId: actor })) held.push({ subjectId: g.data.subjectId, resourceId: g.data.resourceId, role: g.data.role });
      // An agent with its own identity has its own drive. It belongs to the person. The bytes are not in the export.
      const agents = [];
      for (const agent of ownedAgents) {
        const items = (await rawOwnerNodes(agent, false)).map((n) => ({ id: n.id, kind: n.kind, name: n.name, size: n.size, mime: n.mime, createdAt: n.createdAt, updatedAt: n.updatedAt, trashed: n.trashed }));
        agents.push({ id: agent, items });
      }
      const invitesCreated: { id: unknown; resourceId: unknown; role: unknown; expiresAt: unknown; accepted: boolean }[] = [];
      const audit: { at: unknown; action: unknown; resourceId: unknown; outcome: unknown; principalId: unknown; principalKind: unknown; machineMade: unknown }[] = [];
      for (const actor of actors) {
        for (const i of await allWhere(store, "invites", { createdBy: actor })) {
          invitesCreated.push({ id: i.data.id, resourceId: i.data.resourceId, role: i.data.role, expiresAt: i.data.expiresAt ?? null, accepted: i.data.acceptedAt !== undefined });
        }
        for (const e of await allWhere(store, "audit", { principalId: actor }, { field: "at" })) {
          audit.push({ at: e.data.at, action: e.data.action, resourceId: e.data.resourceId ?? null, outcome: e.data.outcome, principalId: e.data.principalId, principalKind: e.data.principalKind, machineMade: e.data.machineMade });
        }
      }
      audit.sort((x, y) => (x.at as number) - (y.at as number));
      return { subject, partial: false, authored, agents, shares: { held, invitesCreated }, audit };
    },

    /**
     * Erases a person for good. Only the person in person may. Their drive and its shares go. So do the shares
     * they hold and the invites they or their agents sent, on drive items only: the grants of other apps stay for
     * those apps and for identity. What they or their agents made in other drives stays, because it belongs to
     * those drives: the id becomes "erased", and the kind stays, so machine-made work keeps its label. The audit
     * trail stays: it holds ids and kinds only. A failed call can run again.
     */
    async erasePerson(ctx: Ctx): Promise<{ removed: number; grants: number; invites: number; anonymized: number }> {
      assertInPerson(ctx, "erase a person");
      const { id } = subjectOf(ctx);
      const { actors, ownedAgents } = await actorsOf(store, id);
      let { removed } = await api.deleteAll(ctx);
      // An agent with its own identity belongs to the person, and so does its drive.
      for (const agent of ownedAgents) removed += await eraseDrive(agent);
      const ofDrive = async (docs: { id: string; data: Doc }[]) => {
        const out: { id: string }[] = [];
        for (const doc of docs) if ((await store.get("resources", doc.data.resourceId as string))?.type === "drive") out.push({ id: doc.id });
        return out;
      };
      const sweep = async (docs: { id: string }[], collection: string) => {
        for (let i = 0; i < docs.length; i += 100) {
          await transact(async (tx) => {
            for (const doc of docs.slice(i, i + 100)) await tx.delete(collection, doc.id);
          });
        }
        return docs.length;
      };
      let grants = 0;
      let invites = 0;
      for (const actor of actors) grants += await sweep(await ofDrive(await allWhere(store, "grants", { subjectId: actor })), "grants");
      for (const actor of actors) invites += await sweep(await ofDrive(await allWhere(store, "invites", { createdBy: actor })), "invites");
      const todo = await madeBy(store, actors);
      for (let i = 0; i < todo.length; i += CHUNK) {
        await transact(async (tx) => {
          const current: Node[] = [];
          for (const node of todo.slice(i, i + CHUNK)) {
            const found = await tx.get<Node>(NODES, node.id);
            if (found) current.push(found);
          }
          for (const node of current) {
            const next: Node = { ...node };
            if (actors.includes(node.createdById ?? node.createdBy.id)) Object.assign(next, { createdBy: { id: ERASED, kind: node.createdBy.kind }, createdById: ERASED });
            if (actors.includes(node.updatedById ?? node.updatedBy.id)) Object.assign(next, { updatedBy: { id: ERASED, kind: node.updatedBy.kind }, updatedById: ERASED });
            await tx.put(NODES, node.id, next);
          }
        });
      }
      return { removed, grants, invites, anonymized: todo.length };
    },

    /** Gives a person or an agent a role on an item and everything under it. Only an owner may. */
    async shareWith(ctx: Ctx, loc: string, subjectId: string, role: Role): Promise<void> {
      const resource = await resourceOf(await resolve(store, ctx, loc));
      await viaSharing(ctx, (s, p) => s.grant(p, resource, subjectId, role));
    },

    async unshare(ctx: Ctx, loc: string, subjectId: string): Promise<void> {
      const resource = await resourceOf(await resolve(store, ctx, loc));
      await viaSharing(ctx, (s, p) => s.revokeGrant(p, resource, subjectId));
    },

    /** Invite by `email` (a person) or `handle` (an agent). The invite lasts `expiresInMs`, if given. It sends no message. */
    async invite(ctx: Ctx, loc: string, input: { role: Role; email?: string; handle?: string; expiresInMs?: number }): Promise<{ id: string }> {
      const resource = await resourceOf(await resolve(store, ctx, loc));
      return viaSharing(ctx, (s, p) => s.createInvite(p, resource, input));
    },

    /** `identity` is the verified email of a person, or the handle of an agent. */
    async acceptInvite(ctx: Ctx, inviteId: string, identity: { email?: string; handle?: string }): Promise<void> {
      await viaSharing(ctx, (s, p) => s.acceptInvite(p, inviteId, identity));
    },

    /** The token comes back once. Only its hash is stored. */
    async createLink(ctx: Ctx, loc: string, input: { role: Role; expiresAt?: number; signedInOnly?: boolean }): Promise<{ id: string; token: string }> {
      const resource = await resourceOf(await resolve(store, ctx, loc));
      return viaSharing(ctx, (s, p) => s.createLink(p, resource, input));
    },

    async revokeLink(ctx: Ctx, linkId: string): Promise<void> {
      await viaSharing(ctx, (s, p) => s.revokeLink(p, linkId));
    },

    /** Who can reach an item, and by which links and invites. Only an owner may look. Link tokens are never shown. */
    async shares(ctx: Ctx, loc: string) {
      const node = await resolve(store, ctx, loc);
      await need(ctx, "delete", node);
      const where = { resourceId: await resourceOf(node) };
      const rows = async (collection: string) => (await store.query(collection, { where, limit: 100 })).items.map((item) => item.data);
      return {
        grants: (await rows("grants")).map((g) => ({ subjectId: g.subjectId, role: g.role })),
        links: (await rows("links")).map((l) => ({ id: l.id, role: l.role, signedInOnly: l.signedInOnly === true, expiresAt: l.expiresAt ?? null, revoked: l.revokedAt != null })),
        invites: (await rows("invites")).map((i) => ({ id: i.id, role: i.role, email: i.email ?? null, handle: i.handle ?? null, expiresAt: i.expiresAt ?? null, accepted: i.acceptedAt !== undefined })),
      };
    },

    openShared,

    /** Live children of a folder that a link visitor or a signed-in person may read, sorted by name. */
    async listShared(principal: PrincipalContext | null, id: string, linkToken?: string): Promise<Node[]> {
      const folder = await openShared(principal, id, linkToken);
      if (folder.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${folder.name} is not a folder`);
      return (await children(store, folder.owner, folder.id))
        .filter((n) => !n.trashed && n.purging !== true)
        .sort((x, y) => (x.nameKey < y.nameKey ? -1 : x.nameKey > y.nameKey ? 1 : x.name < y.name ? -1 : 1));
    },

    async readShared(principal: PrincipalContext | null, id: string, linkToken?: string): Promise<{ node: Node; data: Uint8Array; contentType?: string }> {
      const node = await openShared(principal, id, linkToken);
      if (node.kind !== "file" || !node.blobKey) throw new DriveError("NOT_A_FILE", `${node.name} is not a file`);
      const blob = await blobs.get(node.blobKey);
      if (!blob) throw new DriveError("BLOB_MISSING", `the bytes of ${node.name} are missing`);
      return { node, ...blob };
    },
  };

  /** Runs a call on identity's sharing for the caller. Its short errors become drive errors. */
  async function viaSharing<R>(ctx: Ctx, fn: (s: Sharing, p: PrincipalContext) => Promise<R>): Promise<R> {
    if (!sharing) throw new DriveError("INVALID_SHARE", "sharing is not set up");
    if (!ctx.principal) throw new DriveError("FORBIDDEN", "sign in to share");
    try {
      return await fn(sharing, ctx.principal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "forbidden") throw new DriveError("FORBIDDEN", "not allowed to share this item");
      if (SHARE_ERROR.test(message)) throw new DriveError("INVALID_SHARE", message);
      throw error;
    }
  }

  /** The drive root is a resource too, so a person's own role on it can be checked. It is made on first use. */
  async function prepare(ctx: Ctx) {
    if (!sharing || ctx.principal === undefined) return;
    // The owner is the root of the chain. A caller whose owner is someone else's id would read that drive.
    if (ctx.principal.chain[0]?.id !== ctx.owner) throw new DriveError("FORBIDDEN", "the caller does not own this drive");
    const id = await rootResource(ctx.owner);
    if ((await store.get("resources", id))?.type === "drive") return;
    try {
      await sharing.createResource(ctx.principal, { id, type: "drive" });
    } catch {
      // The caller may only read, or the root was made a moment ago. Either way `can` decides next.
    }
  }
  const guarded = (call: (ctx: Ctx, ...args: never[]) => unknown) => async (ctx: Ctx, ...args: never[]) => {
    await prepare(ctx);
    return call(ctx, ...args);
  };
  const open = new Set(["openShared", "listShared", "readShared"]);
  return Object.fromEntries(Object.entries(api).map(([name, call]) => [name, open.has(name) ? call : guarded(call as never)])) as typeof api;
}

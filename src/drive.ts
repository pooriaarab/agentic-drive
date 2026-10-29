import type { Blobs, Doc, Store, StoreOps } from "agentic-identity";

export const ROOT_ID = "root";
const NODES = "drive_nodes";
/** One claim doc per live name. Its id is a hash of the owner, the folder, and the name. */
const NAMES = "drive_names";

export const ACTOR_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

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
  | "MOVE_INTO_SELF" | "TOO_DEEP" | "PARENT_GONE" | "TRASHED" | "NOT_TRASHED" | "IS_ROOT" | "FORBIDDEN" | "BLOB_MISSING" | "TOO_LARGE" | "INVALID_EXPIRY" | "BUSY";

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
  /** Most parent steps any ancestor walk takes. A walk that hits it fails closed. */
  maxDepth?: number;
  /** Called with a blob key that no node points at and that could not be deleted. */
  onOrphan?: (key: string, error: unknown) => void;
}

export type Drive = ReturnType<typeof createDrive>;

const MAX_PATH_SEGMENTS = 64;
const DEFAULT_MAX_DEPTH = 256;
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
  return {
    fresh,
    put: (collection: string, id: string, doc: Doc) => void writes.push({ collection, id, doc }),
    remove: (collection: string, id: string) => void writes.push({ collection, id, doc: null }),
    async apply(ops: StoreOps) {
      for (const w of writes) await (w.doc ? ops.put(w.collection, w.id, w.doc) : ops.delete(w.collection, w.id));
    },
  };
}

const claimId = (owner: string, parentId: string, key: string) => sha256Hex(new TextEncoder().encode(`${owner}\0${parentId}\0${key}`));

export function createDrive(deps: DriveDeps) {
  const { store, blobs } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const onOrphan = deps.onOrphan ?? ((key: string, error: unknown) =>
    console.error(`orphan blob ${key}: ${error instanceof Error ? error.name : "delete failed"}`));
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
  /**
   * Who holds a name in a folder. `taken` is true for any claim doc, even one that names no live item:
   * a claim that cannot be explained still blocks the name. `node` is set only for a live item.
   */
  async function claimed(ops: StoreOps, owner: string, parentId: string, key: string) {
    const claim = await ops.get<Claim>(NAMES, await claimId(owner, parentId, key));
    const found = claim ? await ops.get<Node>(NODES, claim.nodeId) : null;
    const node = found && !found.trashed && found.parentId === parentId && found.nameKey === key ? found : null;
    return { taken: claim !== null, node };
  }
  const liveChild = async (ops: StoreOps, ctx: Ctx, parentId: string, key: string) => (await claimed(ops, ctx.owner, parentId, key)).node;

  /** True when the node and each ancestor are out of the trash. */
  async function isLive(ops: StoreOps, ctx: Ctx, node: Node) {
    for (let n: Node | null = node, depth = 0; n && depth < maxDepth; depth++) {
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
      if (!(await claimed(ops, ctx.owner, parentId, parseName(candidate).key)).taken) return candidate;
    }
  }

  /** Walks the parents of a path. With `create`, missing folders are added to the batch. */
  async function folderAt(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, segs: ReturnType<typeof splitPath>, create: boolean) {
    let node = rootNode(ctx);
    for (const seg of segs) {
      if (node.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${node.name} is not a folder`);
      let next = w.fresh.has(node.id) ? null : await liveChild(ops, ctx, node.id, seg.key);
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
  async function insert(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, parent: Node, rawName: string, fields: NewFields, onConflict: OnConflict) {
    let { name, key } = parseName(rawName);
    const empty = w.fresh.has(parent.id);
    if (!empty) await need(ctx, "write", parent);
    const slot = empty ? null : await claimed(ops, ctx.owner, parent.id, key);
    if (slot?.taken) {
      if (onConflict === "replace" && slot.node?.kind === "file" && fields.kind === "file") {
        const node: Node = { ...slot.node, ...fields, updatedAt: now(), updatedBy: who(ctx) } as Node;
        w.put(NODES, node.id, node);
        return { node, replacedBlob: slot.node.blobKey };
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
    w.put(NODES, node.id, node);
    w.put(NAMES, await claimId(ctx.owner, parent.id, key), { nodeId: node.id, owner: ctx.owner, parentId: parent.id });
    return { node, replacedBlob: null as string | null };
  }

  /** Splits a path into its parent folder and the new item's name. */
  async function parentAndName(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, path: string, parents: boolean) {
    const segs = splitPath(path);
    const last = segs.pop();
    if (!last) throw new DriveError("IS_ROOT", "the root already exists");
    return { parent: await folderAt(ops, w, ctx, segs, parents), name: last.name };
  }

  async function relocate(ops: StoreOps, w: ReturnType<typeof batch>, ctx: Ctx, node: Node, destLoc: string, opts: { name?: string; onConflict?: OnConflict }) {
    if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot change the root");
    const dest = await resolve(ops, ctx, destLoc);
    if (dest.kind !== "folder") throw new DriveError("NOT_A_FOLDER", `${dest.name} is not a folder`);
    // Walk from the destination up to the root. Any gap or overrun refuses the move.
    for (let n = dest, depth = 0; n.id !== ROOT_ID; depth++) {
      if (n.id === node.id) throw new DriveError("MOVE_INTO_SELF", `cannot move ${node.name} into itself`);
      if (depth >= maxDepth) throw new DriveError("TOO_DEEP", `the destination is deeper than ${maxDepth} folders`);
      const parent = await fetch(ops, ctx, n.parentId);
      if (!parent) throw new DriveError("NOT_FOUND", `a parent folder of ${dest.name} is missing`);
      n = parent;
    }
    await need(ctx, "write", node);
    await need(ctx, "write", dest);
    let { name, key } = parseName(opts.name ?? node.name);
    const slot = await claimed(ops, ctx.owner, dest.id, key);
    if (slot.taken && slot.node?.id !== node.id) {
      if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
      name = await freeName(ops, ctx, dest.id, name);
      key = parseName(name).key;
    }
    const moved: Node = { ...node, parentId: dest.id, name, nameKey: key, updatedAt: now(), updatedBy: who(ctx) };
    w.put(NODES, moved.id, moved);
    const [from, to] = [await claimId(ctx.owner, node.parentId, node.nameKey), await claimId(ctx.owner, dest.id, key)];
    if (from !== to) {
      // Release only a claim that this item holds.
      if ((await ops.get<Claim>(NAMES, from))?.nodeId === node.id) w.remove(NAMES, from);
      w.put(NAMES, to, { nodeId: moved.id, owner: ctx.owner, parentId: dest.id });
    }
    return moved;
  }

  /** True only when a query proves no node holds the key. An unreadable store keeps the blob. */
  async function isUnreferenced(ctx: Ctx, blobKey: string) {
    try {
      return (await store.query<Node>(NODES, { where: { owner: ctx.owner, blobKey }, limit: 1 })).items.length === 0;
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
  async function ownerNodes(ctx: Ctx): Promise<Node[]> {
    const root = rootNode(ctx);
    if (!(await can(ctx, "read", root))) throw new DriveError("FORBIDDEN", "not allowed to read this drive");
    const out: Node[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await store.query<Node>(NODES, { where: { owner: ctx.owner }, limit: 100, cursor });
      out.push(...page.items.map((item) => item.data));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
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

  /**
   * Removes the nodes that still look as they did when they were read. A node that was restored,
   * moved, or changed in the meantime stays, with its bytes and its name. A chunk deletes its blobs
   * first (a delete is idempotent), then its rows, children before parents. A failure at any step
   * leaves rows that still name what is left, so the same call can run again.
   */
  async function removeNodes(nodes: Node[], top?: Node) {
    const unchanged = (now: Node | null, seen: Node) =>
      now !== null && now.trashed === seen.trashed && now.parentId === seen.parentId && now.updatedAt === seen.updatedAt;
    const rows = [...nodes].reverse();
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const keep = async (tx: StoreOps) => {
        const out: { node: Node; claim: string | null; held: Claim | null }[] = [];
        // A restored top item keeps its whole tree.
        if (top && !unchanged(await tx.get<Node>(NODES, top.id), top)) return out;
        for (const node of chunk) {
          if (!unchanged(await tx.get<Node>(NODES, node.id), node)) continue;
          // A trashed item gave up its name when it was trashed, and another item may hold it now.
          const claim = node.trashed ? null : await claimId(node.owner, node.parentId, node.nameKey);
          out.push({ node, claim, held: claim ? await tx.get<Claim>(NAMES, claim) : null });
        }
        return out;
      };
      for (const { node } of await transact(keep)) if (node.blobKey) await blobs.delete(node.blobKey);
      await transact(async (tx) => {
        const found = await keep(tx);
        for (const { node, claim, held } of found) {
          await tx.delete(NODES, node.id);
          if (claim && held?.nodeId === node.id) await tx.delete(NAMES, claim);
        }
      });
    }
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
      return transact(async (tx) => {
        const w = batch();
        const { parent, name } = await parentAndName(tx, w, ctx, path, opts.parents ?? false);
        const existing = w.fresh.has(parent.id) ? null : await liveChild(tx, ctx, parent.id, parseName(name).key);
        if (opts.parents && existing?.kind === "folder") return existing;
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
      const blobKey = `${ctx.owner}/${newId()}`;
      await blobs.put(blobKey, data, mime ? { contentType: mime } : undefined);
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
        if (await isUnreferenced(ctx, blobKey)) await dropBlob(blobKey);
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
     * A time-limited URL to fetch the bytes. The Worker that verifies it serves an attachment with a
     * safe type, because the shared Blobs port cannot sign those headers yet. Trashing an item does
     * not revoke a link already issued.
     */
    async downloadUrl(ctx: Ctx, loc: string, expiresInSeconds = DEFAULT_URL_SECONDS): Promise<string> {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_URL_SECONDS) {
        throw new DriveError("INVALID_EXPIRY", `a link lasts 1 to ${MAX_URL_SECONDS} seconds`);
      }
      const node = await resolve(store, ctx, loc);
      if (node.kind !== "file" || !node.blobKey) throw new DriveError("NOT_A_FILE", `${node.name} is not a file`);
      return blobs.signedUrl(node.blobKey, { method: "GET", expiresInSeconds });
    },

    async move(ctx: Ctx, src: string, destLoc: string, opts: { name?: string; onConflict?: OnConflict } = {}): Promise<Node> {
      return transact(async (tx) => {
        const w = batch();
        const moved = await relocate(tx, w, ctx, await resolve(tx, ctx, src), destLoc, opts);
        await w.apply(tx);
        return moved;
      });
    },

    async rename(ctx: Ctx, loc: string, name: string): Promise<Node> {
      return transact(async (tx) => {
        const w = batch();
        const node = await resolve(tx, ctx, loc);
        const renamed = await relocate(tx, w, ctx, node, node.parentId, { name });
        await w.apply(tx);
        return renamed;
      });
    },

    /** Hides an item and, for a folder, everything under it. Nothing else changes. */
    async trash(ctx: Ctx, loc: string): Promise<Node> {
      return transact(async (tx) => {
        const node = await resolve(tx, ctx, loc);
        if (node.id === ROOT_ID) throw new DriveError("IS_ROOT", "cannot trash the root");
        await need(ctx, "delete", node);
        const claim = await claimId(node.owner, node.parentId, node.nameKey);
        const held = await tx.get<Claim>(NAMES, claim);
        const t = now();
        const trashed: Node = { ...node, trashed: true, trashedAt: t, updatedAt: t, updatedBy: who(ctx) };
        await tx.put(NODES, node.id, trashed);
        // Trashing frees the name. Release only a claim that this item holds.
        if (held?.nodeId === node.id) await tx.delete(NAMES, claim);
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
      return transact(async (tx) => {
        const node = await fetch(tx, ctx, id);
        if (!node || node.id === ROOT_ID) throw new DriveError("NOT_FOUND", `no item ${id}`);
        if (!node.trashed) throw new DriveError("NOT_TRASHED", `${node.name} is not in the trash`);
        await need(ctx, "write", node);
        const parent = await fetch(tx, ctx, opts.parentId ?? node.parentId);
        if (!parent || parent.kind !== "folder" || !(await isLive(tx, ctx, parent))) {
          throw new DriveError("PARENT_GONE", `the folder of ${node.name} is gone or in the trash`);
        }
        let { name, key } = parseName(node.name);
        if ((await claimed(tx, ctx.owner, parent.id, key)).taken) {
          if (opts.onConflict !== "rename") throw new DriveError("NAME_TAKEN", `"${name}" already exists`);
          name = await freeName(tx, ctx, parent.id, name);
          key = parseName(name).key;
        }
        const restored: Node = { ...node, parentId: parent.id, name, nameKey: key, trashed: false, trashedAt: null, updatedAt: now(), updatedBy: who(ctx) };
        await tx.put(NODES, restored.id, restored);
        await tx.put(NAMES, await claimId(ctx.owner, parent.id, key), { nodeId: restored.id, owner: ctx.owner, parentId: parent.id });
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
        if (path === null) continue;
        if (needle !== undefined && !node.nameKey.includes(needle)) continue;
        if (q.kind && node.kind !== q.kind) continue;
        if (q.mime && !(q.mime.endsWith("/*") ? node.mime?.startsWith(q.mime.slice(0, -1)) : node.mime === q.mime)) continue;
        if (q.minSize !== undefined && node.size < q.minSize) continue;
        if (q.maxSize !== undefined && node.size > q.maxSize) continue;
        if (q.createdByKind && node.createdBy.kind !== q.createdByKind) continue;
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

    /** Deletes every item and byte of the owner for good. Only the owner may do this, never an agent for them. */
    /** Deletes every item and blob of one owner. Blobs go first, so a failure can be retried. */
    async deleteAll(ctx: Ctx): Promise<{ removed: number }> {
      if (ctx.actor.kind !== "human" || ctx.actor.id !== ctx.owner) throw new DriveError("FORBIDDEN", "only the owner in person can delete the whole drive");
      await need(ctx, "delete", rootNode(ctx));
      let removed = 0;
      // A file created during a pass shows up in the next one.
      for (let pass = 0; pass < 5; pass++) {
        const all = await ownerNodes(ctx);
        if (all.length === 0) return { removed };
        await removeNodes(all);
        removed += all.length;
      }
      throw new DriveError("BUSY", "the drive kept changing while it was deleted. Run it again.");
    },
    /** Deletes a trashed item for good, with everything under it and all their bytes. */
    async purge(ctx: Ctx, id: string): Promise<{ removed: number }> {
      const top = await fetch(store, ctx, id);
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
      await removeNodes(nodes, top);
      return { removed: nodes.length };
    },

  };
  return api;
}

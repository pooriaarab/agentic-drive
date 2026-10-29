import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  AppShell, Button, Dialog, DialogClose, EmptyState, FileIcon, FileList, FileRow, FolderIcon, IconButton, Input, Menu, MoreIcon, PlusIcon, PresenceChip,
  Select, ShareDialog, SidebarNav, Toolbar, ToolbarButton, useTheme, useToast, type LinkExpiry, type PresenceEntry, type ShareLink, type ShareRole,
} from "agentic-design/react";
import { BulkBar, ExpandableSearch, ItemTable, sortItems, type Sort, type SortKey } from "./browse.js";
import { createClient, DriveApiError, type DriveClient, type Item, type Role } from "../src/client.js";

const TOKEN_KEY = "agentic-drive-token";
const errorText = (e: unknown) => (e instanceof DriveApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Something went wrong");
const byName = (a: Item, b: Item) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name);
const who = (a: Item["createdBy"], owner: string): PresenceEntry =>
  a.kind === "human" ? { id: a.id, name: a.id, kind: "person" } : { id: a.id, name: a.id, kind: "agent", actingFor: owner };
/** The AI Act marker. It has text, and it reads `machineMade` from the API. */
const MachineLabel = ({ item }: { item: Item }) => (item.machineMade ? <span className="agd-pill">Created by agent</span> : null);

type Load<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; data: T };
/** Runs `fn` on mount and on `reload`. A view remounts per route, so state never leaks between folders. */
function useLoad<T>(fn: () => Promise<T>): [Load<T>, () => void] {
  const [state, set] = useState<Load<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((data) => live && set({ status: "ok", data }), (e) => live && set({ status: "error", error: errorText(e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  return [state, () => setTick((n) => n + 1)];
}

function Status({ state, retry, children }: { state: Load<unknown>; retry: () => void; children: ReactNode }) {
  if (state.status === "loading") return <p role="status" className="drive-status"><span className="agd-spinner" aria-hidden="true" /> Loading…</p>;
  if (state.status === "error") return <div role="alert"><EmptyState title="Could not load this page" description={state.error} action={<Button onClick={retry}>Try again</Button>} /></div>;
  return <>{children}</>;
}

const routeParts = (hash: string) => hash.replace(/^#\/?/, "").split("/");
/** Points the page address at a folder, and tells the app. */
const goHash = (loc: string) => {
  history.replaceState(null, "", `#/${loc}`);
  dispatchEvent(new HashChangeEvent("hashchange"));
};

/** The signed-in views. `origin` is the server that signs download links and makes share links. `go` opens a folder. */
export function Routes({ hash, client, origin, go }: { hash: string; client: DriveClient; origin: string; go: (loc: string) => void }) {
  const parts = routeParts(hash);
  if (parts[0] === "trash") return <TrashView key="trash" client={client} />;
  if (parts[0] === "f" && parts[1]) return <Download key={hash} client={client} id={parts[1]} origin={origin} go={go} />;
  return <Browser key={hash} client={client} loc={parts[0] || "/"} origin={origin} />;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // A file dropped outside the drop zone must not open in the tab and leave the app.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    addEventListener("dragover", stop);
    addEventListener("drop", stop);
    return () => { removeEventListener("dragover", stop); removeEventListener("drop", stop); };
  }, []);
  const client = useMemo(() => {
    try {
      return createClient({ baseUrl: location.origin, ...(token ? { token } : {}) });
    } catch {
      return createClient({ baseUrl: location.origin });
    }
  }, [token]);
  // A stored token the client refuses is dropped, so the page shows the sign-in form.
  useEffect(() => {
    if (token && !/^[A-Za-z0-9_-]{1,512}$/.test(token)) { sessionStorage.removeItem(TOKEN_KEY); setToken(""); }
  }, [token]);
  const signOut = () => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); location.hash = "#/"; };
  const parts = routeParts(hash);
  if (parts[0] === "s" && parts[1]) return <Chrome signedIn={false} signOut={signOut}><SharedView key={hash} client={client} id={parts[1]} linkToken={parts[2]} /></Chrome>;
  if (!token) return <Chrome signedIn={false} signOut={signOut}><SignIn onToken={(t) => { sessionStorage.setItem(TOKEN_KEY, t); setToken(t); }} /></Chrome>;
  return (
    <Chrome signedIn signOut={signOut} current={parts[0] === "trash" ? "trash" : "files"}>
      <Routes hash={hash} client={client} origin={location.origin} go={goHash} />
    </Chrome>
  );
}

function Chrome({ children, signedIn, signOut, current }: { children: ReactNode; signedIn: boolean; signOut: () => void; current?: "files" | "trash" }) {
  const { preference, setPreference } = useTheme();
  return (
    <AppShell
      brand="Drive"
      sidebar={signedIn ? (
        <SidebarNav label="Places" items={[
          { href: "#/", label: "My files", icon: <FolderIcon aria-hidden="true" />, current: current === "files" },
          { href: "#/trash", label: "Trash", current: current === "trash" },
        ]} />
      ) : <p className="drive-muted">Sign in to see your files.</p>}
      topbar={<>
        <Select hideLabel label="Theme" value={preference} onChange={(e) => setPreference(e.target.value as "light" | "dark" | "system")}>
          <option value="system">Theme: system</option><option value="light">Theme: light</option><option value="dark">Theme: dark</option>
        </Select>
        {signedIn && <Button variant="ghost" onClick={signOut}>Sign out</Button>}
      </>}
    >
      <div className="drive-main">{children}</div>
    </AppShell>
  );
}

function SignIn({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await createClient({ baseUrl: location.origin, token: value.trim() }).list("/");
      onToken(value.trim());
    } catch (err) {
      setError(err instanceof TypeError ? "A token has letters, digits, - and _ only." : err instanceof DriveApiError && err.code === "UNAUTHORIZED" ? "This token is not valid." : errorText(err));
    }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="drive-signin" aria-labelledby="signin-title">
      <h1 id="signin-title">Sign in</h1>
      <Input label="Access token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} error={error} hint="The bearer token of a person or an agent. The tab keeps it until you close it." required />
      <Button type="submit" loading={busy}>Sign in</Button>
    </form>
  );
}

type Dlg = { kind: "mkdir" } | { kind: "rename" | "move" | "share"; item: Item };

function Browser({ client, loc, origin }: { client: DriveClient; loc: string; origin: string }) {
  const toast = useToast();
  const [view, setView] = useState<"list" | "grid">(() => (localStorage.getItem("agentic-drive-view") === "grid" ? "grid" : "list"));
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const [state, reload] = useLoad(async () => {
    const root = await client.stat("/");
    const folder = loc === "/" ? root : await client.stat(loc);
    const crumbs: Item[] = [];
    try {
      for (let n = folder; n.id !== root.id; n = await client.stat(n.parentId)) crumbs.unshift(n);
    } catch (e) {
      // A person with a grant on a sub-folder cannot read its parents. Show the path from that folder.
      if (!(e instanceof DriveApiError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN"))) throw e;
    }
    const children = async (f: Item) => (await client.list(f.id === root.id ? "/" : f.id)).sort(byName);
    const items = await children(folder);
    const tree = new Map<string, Item[]>([[root.id, f(await children(root))]]);
    for (const c of crumbs) tree.set(c.id, c.id === folder.id ? f(items) : f(await children(c)));
    return { root, folder, crumbs, items, tree };
  });
  function f(items: Item[]) { return items.filter((i) => i.kind === "folder"); }

  const act = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); toast({ title: done, tone: "success" }); setDlg(null); } catch (e) { toast({ title: "That did not work", description: errorText(e), tone: "danger" }); }
    reload();
  };
  const upload = async (files: FileList | File[]) => {
    if (state.status !== "ok") return;
    if (busy) return void toast({ title: "An upload is running", description: "Wait for it to finish, then add more files.", tone: "info" });
    const { folder, root } = state.data;
    setBusy(true);
    for (const file of Array.from(files)) {
      await act(() => client.upload(folder.id === root.id ? `/${file.name}` : `${folder.id}/${file.name}`, file, { mime: file.type || undefined, onConflict: "rename" }), `Uploaded ${file.name}`);
    }
    setBusy(false);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); };
  const onSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  const trashSelected = async (ids: string[]) => {
    setBusy(true);
    const results = await Promise.allSettled(ids.map((id) => client.trash(id)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) toast({ title: `${failed.length} of ${ids.length} items did not move`, description: errorText((failed[0] as PromiseRejectedResult).reason), tone: "danger" });
    else toast({ title: `Moved ${ids.length} ${ids.length === 1 ? "item" : "items"} to trash`, tone: "success" });
    setSelected(new Set());
    setBusy(false);
    reload();
  };
  const setViewMode = (v: "list" | "grid") => { localStorage.setItem("agentic-drive-view", v); setView(v); };

  return (
    <section onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); }} onDrop={onDrop} className={drag ? "drive-drop drive-drop--over" : "drive-drop"} aria-label="Files">
      <Status state={state} retry={reload}>
        {state.status === "ok" && (() => {
          const { folder, root, crumbs, tree } = state.data;
          const needle = query.trim().toLowerCase();
          const items = sortItems(state.data.items.filter((i) => i.name.toLowerCase().includes(needle)), sort);
          const picked = items.filter((i) => selected.has(i.id)).map((i) => i.id);
          const actions = (item: Item) => (
            <>
              <MachineLabel item={item} />
              <Menu align="end" trigger={<IconButton label={`Actions for ${item.name}`} icon={<MoreIcon />} variant="ghost" />} items={[
                { label: "Rename", onSelect: () => setDlg({ kind: "rename", item }) },
                { label: "Move", onSelect: () => setDlg({ kind: "move", item }) },
                { label: "Share", onSelect: () => setDlg({ kind: "share", item }) },
                "separator",
                { label: "Move to trash", danger: true, onSelect: () => void act(() => client.trash(item.id), `Moved ${item.name} to trash`) },
              ]} />
            </>
          );
          const href = (i: Item) => (i.kind === "folder" ? `#/${i.id}` : `#/f/${i.id}`);
          const level = (id: string): ReactNode => (
            <ul className="drive-tree">
              {(tree.get(id) ?? []).map((n) => (
                <li key={n.id}>
                  <a href={`#/${n.id}`} aria-current={n.id === folder.id ? "page" : undefined}><FolderIcon aria-hidden="true" /> {n.name}</a>
                  {tree.has(n.id) && level(n.id)}
                </li>
              ))}
            </ul>
          );
          return (
            <>
              <nav aria-label="Breadcrumb" className="drive-crumbs">
                <ol>
                  <li>{crumbs.length ? <a href="#/">My files</a> : <span aria-current="page">My files</span>}</li>
                  {crumbs.map((c, i) => <li key={c.id}>{i === crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <a href={`#/${c.id}`}>{c.name}</a>}</li>)}
                </ol>
              </nav>
              <div className="drive-bar">
                <div className="drive-title">
                  <h1>{folder.id === root.id ? "My files" : folder.name}</h1>
                  {folder.id !== root.id && <Button variant="secondary" size="sm" onClick={() => setDlg({ kind: "share", item: folder })}>Share</Button>}
                </div>
                <Toolbar label="Folder actions">
                  <ToolbarButton label="New folder" icon={<PlusIcon />} onClick={() => setDlg({ kind: "mkdir" })} />
                  <ToolbarButton label="Upload files" icon={<FileIcon />} onClick={() => input.current?.click()} disabled={busy} />
                  <ToolbarButton label="List view" icon={<span aria-hidden="true">☰</span>} pressed={view === "list"} onClick={() => setViewMode("list")} />
                  <ToolbarButton label="Grid view" icon={<span aria-hidden="true">▦</span>} pressed={view === "grid"} onClick={() => setViewMode("grid")} />
                </Toolbar>
                <input ref={input} type="file" multiple hidden aria-label="Choose files to upload" onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
              </div>
              <div className="drive-split">
              <nav aria-label="Folders" className="drive-folders">{level(root.id)}</nav>
              <div>
              <div className="drive-tools"><ExpandableSearch value={query} onChange={setQuery} /></div>
              {state.data.items.length === 0 ? (
                <EmptyState title="This folder is empty" description="Drop files here, or use Upload files." action={<Button onClick={() => input.current?.click()} disabled={busy}>Upload files</Button>} />
              ) : items.length === 0 ? (
                <EmptyState title="Nothing matches" description={`No item in this folder has “${query.trim()}” in its name.`} action={<Button onClick={() => setQuery("")}>Clear search</Button>} />
              ) : view === "list" ? (
                <ItemTable label={`Items in ${folder.name || "My files"}`} items={items} sort={sort} onSort={onSort} selected={selected} onSelect={setSelected} href={href} who={who} actions={actions} />
              ) : (
                <ul className="drive-grid" aria-label={`Items in ${folder.name || "My files"}`}>
                  {items.map((i) => (
                    <li key={i.id} className="drive-card">
                      <span className="drive-card__icon" aria-hidden="true">{i.kind === "folder" ? <FolderIcon /> : <FileIcon />}</span>
                      <a href={href(i)} className="drive-card__name">{i.name}</a>
                      <span className="drive-card__meta">Edited by <PresenceChip entry={who(i.updatedBy, i.owner)} /></span>
                      <span className="drive-card__actions">{actions(i)}</span>
                    </li>
                  ))}
                </ul>
              )}
              </div>
              </div>
              <BulkBar count={picked.length} busy={busy} onTrash={() => void trashSelected(picked)} onClear={() => setSelected(new Set())} />
              {dlg?.kind === "mkdir" && <Prompt open title="New folder" label="Folder name" initial="" submit="Create" onClose={() => setDlg(null)} onSubmit={(name) => act(() => client.mkdir(folder.id === root.id ? `/${name}` : `${folder.id}/${name}`), `Created ${name}`)} />}
              {dlg?.kind === "rename" && <Prompt open title="Rename" label="New name" initial={dlg.item.name} submit="Rename" onClose={() => setDlg(null)} onSubmit={(name) => act(() => client.move(dlg.item.id, dlg.item.parentId, { name }), `Renamed to ${name}`)} />}
              {dlg?.kind === "move" && <MoveDialog client={client} item={dlg.item} onClose={() => setDlg(null)} onMove={(to) => act(() => client.move(dlg.item.id, to), `Moved ${dlg.item.name}`)} />}
              {dlg?.kind === "share" && <Sharing client={client} item={dlg.item} origin={origin} onClose={() => setDlg(null)} />}
            </>
          );
        })()}
      </Status>
    </section>
  );
}

function Prompt({ open, title, label, initial, submit, onClose, onSubmit }: { open?: boolean; title: string; label: string; initial: string; submit: string; onClose: () => void; onSubmit: (v: string) => Promise<unknown> }) {
  const [value, setValue] = useState(initial);
  const sent = useRef(false);
  const [problem, setProblem] = useState<string>();
  // One request at a time. A failed request frees the form, so the person can fix the name and send again.
  const send = (name: string) => {
    if (!name) return;
    if (name.includes("/")) return setProblem("A name cannot have a slash.");
    setProblem(undefined);
    sent.current = true;
    void onSubmit(name).finally(() => { sent.current = false; });
  };
  return (
    <Dialog open={!!open} onOpenChange={(o) => { if (!o) onClose(); }} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); if (!sent.current) send(value.trim()); }} className="drive-form">
        <Input label={label} value={value} onChange={(e) => setValue(e.target.value)} error={problem} required />
        <div className="drive-form__actions"><DialogClose asChild><Button variant="ghost" type="button">Cancel</Button></DialogClose><Button type="submit">{submit}</Button></div>
      </form>
    </Dialog>
  );
}

function MoveDialog({ client, item, onClose, onMove }: { client: DriveClient; item: Item; onClose: () => void; onMove: (to: string) => Promise<unknown> }) {
  const [folders, retry] = useLoad(async () => {
    const root = await client.stat("/");
    const all = await client.search({ kind: "folder", limit: 1000 });
    // A folder cannot move into itself or below itself.
    const own = all.find((x) => x.id === item.id)?.path;
    return [{ id: "/", path: "/", name: "My files" }, ...all.filter((x) => x.id !== root.id && !(own && (x.path === own || x.path.startsWith(`${own}/`))))];
  });
  const [to, setTo] = useState("/");
  const sent = useRef(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Move ${item.name}`}>
      <Status state={folders} retry={retry}>
        {folders.status === "ok" && (
          <form onSubmit={(e) => { e.preventDefault(); if (sent.current) return; sent.current = true; void onMove(to).finally(() => { sent.current = false; }); }} className="drive-form">
            <Select label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
              {folders.data.map((x) => <option key={x.id} value={x.id}>{x.path === "/" ? "My files" : x.path}</option>)}
            </Select>
            <div className="drive-form__actions"><DialogClose asChild><Button variant="ghost" type="button">Cancel</Button></DialogClose><Button type="submit">Move</Button></div>
          </form>
        )}
      </Status>
    </Dialog>
  );
}

const EXPIRY_MS: Record<LinkExpiry, number | undefined> = { never: undefined, "1d": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };
type LinkState = { id?: string; token?: string; role: ShareRole; expiry: LinkExpiry; signedInOnly: boolean };

function Sharing({ client, item, origin, onClose }: { client: DriveClient; item: Item; origin: string; onClose: () => void }) {
  const toast = useToast();
  const [state, reload] = useLoad(() => client.shares(item.id));
  const [link, setLink] = useState<LinkState>({ role: "viewer", expiry: "never", signedInOnly: false });
  const liveLinks = state.status === "ok" ? state.data.links.filter((l) => !l.revoked && (l.expiresAt === null || l.expiresAt > Date.now())) : [];
  const live = liveLinks[0];
  const current = link.id ? link : live ? { ...link, id: live.id, role: live.role === "owner" ? "editor" : live.role, signedInOnly: live.signedInOnly } : link;
  const run = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (e) { toast({ title: "That did not work", description: errorText(e), tone: "danger" }); }
    reload();
  };
  const entries = state.status === "ok" ? state.data.grants.map((g) => ({ entry: { id: g.subjectId, name: g.subjectId, kind: g.subjectKind === "agent" ? "agent" as const : "person" as const }, role: g.role as ShareRole | "owner" })) : [];
  const kindOf = (id: string) => (state.status === "ok" && state.data.grants.find((g) => g.subjectId === id)?.subjectKind) || "human";
  /** Turning a link off, or changing it, ends every live link of the item, also one made with the CLI. */
  const revokeAll = async () => { for (const id of new Set([...liveLinks.map((l) => l.id), ...(current.id ? [current.id] : [])])) await client.revokeLink(id); };
  const change = (next: LinkState) => run(async () => {
    await revokeAll();
    const made = await client.createLink(item.id, { role: next.role as Role, signedInOnly: next.signedInOnly, ...(EXPIRY_MS[next.expiry] ? { expiresInMs: EXPIRY_MS[next.expiry] } : {}) });
    setLink({ ...next, id: made.id, token: made.token });
    toast({ title: "New link made", description: current.id ? "The old link no longer works." : undefined, tone: "info" });
  });
  const shareLink: ShareLink = {
    enabled: !!current.id, role: current.role, expiry: current.expiry, signedInOnly: current.signedInOnly,
    url: current.token ? `${origin}/#/s/${item.id}/${current.token}` : "Turn the link off and on to make a new one. The address shows once.",
    expiresAt: live?.expiresAt ? new Date(live.expiresAt) : null,
  };
  return (
    <ShareDialog
      open onOpenChange={(o) => { if (!o) onClose(); }} resourceName={item.name} people={entries}
      onInvite={(inv) => void run(async () => { await client.invite(item.id, { role: inv.role, ...(inv.kind === "person" ? { email: inv.to } : { handle: inv.to.replace(/^@/, "") }) }); toast({ title: "Invite created", tone: "success" }); })}
      onChangeRole={(id, role) => void run(() => client.share(item.id, { kind: kindOf(id), id }, role))}
      onRemove={(id) => void run(() => client.unshare(item.id, { kind: kindOf(id), id }))}
      link={shareLink}
      onChangeLink={(next) => {
        if (!next.enabled) return void run(async () => { await revokeAll(); setLink({ ...current, id: undefined, token: undefined }); });
        void change({ role: next.role, expiry: next.expiry, signedInOnly: next.signedInOnly });
      }}
      snapshot={{ onCreate: () => toast({ title: "Snapshot links are not available in Drive yet", tone: "info" }) }}
      onCopy={(url) => current.token && void navigator.clipboard?.writeText(url).then(() => toast({ title: "Link copied", tone: "success" }), () => toast({ title: "Could not copy", tone: "warning" }))}
    />
  );
}

function TrashView({ client }: { client: DriveClient }) {
  const toast = useToast();
  const [state, reload] = useLoad(() => client.listTrash());
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const onSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  const restore = async (i: Item) => {
    try { await client.restore(i.id, { onConflict: "rename" }); toast({ title: `Restored ${i.name}`, tone: "success" }); } catch (e) { toast({ title: "Could not restore", description: errorText(e), tone: "danger" }); }
    reload();
  };
  return (
    <section aria-label="Trash">
      <h1>Trash</h1>
      <Status state={state} retry={reload}>
        {state.status === "ok" && (state.data.length === 0 ? <EmptyState title="The trash is empty" description="Items you move to the trash show up here." /> : (
          <ItemTable label="Items in the trash" items={sortItems(state.data, sort)} sort={sort} onSort={onSort} href={() => "#/trash"} who={who} actions={(i) => <><MachineLabel item={i} /><Button size="sm" onClick={() => void restore(i)}>{`Restore ${i.name}`}</Button></>} />
        ))}
      </Status>
    </section>
  );
}

/** Opens a signed download link, then goes back to the folder of the file. */
function Download({ client, id, origin, go }: { client: DriveClient; id: string; origin: string; go: (loc: string) => void }) {
  const [state, retry] = useLoad(async () => {
    const item = await client.stat(id);
    const { url } = await client.url(id);
    if (new URL(url, origin).origin !== origin) throw new Error("The download link points to another site.");
    const a = document.createElement("a");
    a.href = url;
    a.download = item.name;
    a.click();
    go(item.parentId);
    return item;
  });
  return <Status state={state} retry={retry}>{null}</Status>;
}

function SharedView({ client, id, linkToken }: { client: DriveClient; id: string; linkToken?: string }) {
  const [state, reload] = useLoad(async () => {
    const item = await client.openShared(id, { linkToken });
    return { item, items: item.kind === "folder" ? (await client.listShared(id, { linkToken })).sort(byName) : [] };
  });
  const toast = useToast();
  const save = async () => {
    if (state.status !== "ok") return;
    try {
      const { data, contentType } = await client.readShared(id, { linkToken });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: contentType }));
      a.download = state.data.item.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      toast({ title: "Could not download", description: errorText(e), tone: "danger" });
    }
  };
  return (
    <section aria-label="Shared item">
      <Status state={state} retry={reload}>
        {state.status === "ok" && (
          <>
            <div className="drive-bar">
              <div className="drive-title"><h1>{state.data.item.name}</h1><MachineLabel item={state.data.item} /></div>
              {state.data.item.kind !== "folder" && <Button onClick={() => void save()}>Download</Button>}
            </div>
            <p className="drive-muted">Shared with you.</p>
            {state.data.item.kind === "folder"
              ? (state.data.items.length === 0 ? <EmptyState title="This folder is empty" /> : <FileList label="Shared items">{state.data.items.map((i) => <FileRow key={i.id} name={i.name} href={`#/s/${i.id}${linkToken ? `/${linkToken}` : ""}`} kind={i.kind === "folder" ? "folder" : "file"} modified={new Date(i.updatedAt)} editedBy={who(i.updatedBy, i.owner)} actions={<MachineLabel item={i} />} />)}</FileList>)
              : null}
          </>
        )}
      </Status>
    </section>
  );
}

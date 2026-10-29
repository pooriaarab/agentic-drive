import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, FileIcon, FolderIcon, PresenceChip, type PresenceEntry } from "agentic-design/react";
import type { Item } from "../src/client.js";

export type SortKey = "name" | "modified";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Folders first, then the chosen column. A name sort keeps natural order for numbers. */
export function sortItems(items: Item[], { key, dir }: Sort): Item[] {
  const sign = dir === "asc" ? 1 : -1;
  const by = key === "name" ? (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { numeric: true }) : (a: Item, b: Item) => a.updatedAt - b.updatedAt;
  return [...items].sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || sign * by(a, b) || a.name.localeCompare(b.name));
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A search that opens from a button, filters by name, and closes on Escape. */
export function ExpandableSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = () => { onChange(""); setOpen(false); };
  if (!open && !value) {
    return <Button variant="ghost" size="sm" aria-expanded="false" onClick={() => setOpen(true)}>Search</Button>;
  }
  return (
    <div className="drive-search" role="search">
      <input
        ref={input} type="search" className="drive-search__input" aria-label="Search this folder" placeholder="Search this folder" value={value}
        onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") close(); }}
      />
      <Button variant="ghost" size="sm" onClick={close}>Close search</Button>
    </div>
  );
}

type TableProps = {
  label: string;
  items: Item[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  /** Leave out `onSelect` for a table with no select column. */
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
  href: (i: Item) => string;
  who: (a: Item["updatedBy"], owner: string) => PresenceEntry;
  actions: (i: Item) => ReactNode;
};

/** The list view: a table with a select column, sortable headers, and a row menu. */
export function ItemTable({ label, items, sort, onSort, selected = new Set(), onSelect, href, who, actions }: TableProps) {
  const all = items.length > 0 && items.every((i) => selected.has(i.id));
  const some = !all && items.some((i) => selected.has(i.id));
  const head = useRef<HTMLInputElement>(null);
  useEffect(() => { if (head.current) head.current.indeterminate = some; }, [some]);
  const toggle = (id: string, on: boolean) => {
    if (!onSelect) return;
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    onSelect(next);
  };
  const th = (key: SortKey, text: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="drive-sort" onClick={() => onSort(key)}>{text}<span aria-hidden="true">{sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span></button>
    </th>
  );
  return (
    <table className="drive-table" aria-label={label}>
      <thead>
        <tr>
          {onSelect && (
            <th scope="col" className="drive-table__check">
              <input ref={head} type="checkbox" className="agd-checkbox" aria-label="Select all items" checked={all} onChange={(e) => onSelect(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />
            </th>
          )}
          {th("name", "Name")}
          <th scope="col">Edited by</th>
          {th("modified", "Modified")}
          <th scope="col"><span className="drive-sr">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="drive-row" data-selected={selected.has(i.id) || undefined}>
            {onSelect && (
              <td className="drive-table__check">
                <input type="checkbox" className="agd-checkbox" aria-label={`Select ${i.name}`} checked={selected.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
              </td>
            )}
            <td>
              <div className="drive-table__name">
                <span className="drive-table__icon" aria-hidden="true">{i.kind === "folder" ? <FolderIcon /> : <FileIcon />}</span>
                <a href={href(i)}>{i.name}</a>
              </div>
            </td>
            <td><PresenceChip entry={who(i.updatedBy, i.owner)} /></td>
            <td><time dateTime={new Date(i.updatedAt).toISOString()}>{dateFormat.format(new Date(i.updatedAt))}</time></td>
            <td className="drive-table__actions">{actions(i)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Sticks to the bottom of the page while rows are selected. */
export function BulkBar({ count, busy, onTrash, onClear }: { count: number; busy: boolean; onTrash: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div role="region" aria-label="Selected items" className="drive-bulk">
      <span role="status">{count} selected</span>
      <Button variant="danger" size="sm" onClick={onTrash} disabled={busy}>Move to trash</Button>
      <Button variant="ghost" size="sm" onClick={onClear}>Clear selection</Button>
    </div>
  );
}

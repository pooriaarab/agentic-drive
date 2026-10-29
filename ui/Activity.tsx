import type { ActivityEntry } from "../src/client.js";

const VERBS: Record<ActivityEntry["action"], string> = {
  create: "created this item", rename: "renamed it", move: "moved it", update: "replaced its content", share: "shared it", unshare: "stopped sharing it", delete: "moved it to the trash", restore: "restored it",
};
/** What changed, in words. It reads the detail the drive stores: names and ids, never content. */
function detailText(e: ActivityEntry): string {
  const d = e.detail ?? {};
  if (e.action === "rename") return `from "${d.from}" to "${d.to}"`;
  if (e.action === "share") return `with ${d.subjectId} as ${d.role}`;
  if (e.action === "unshare") return `from ${d.subjectId}`;
  return "";
}

/** The AI Act marker. It has text, and it reads the actor kind that the API stores on each entry. */
export const AgentLabel = ({ entry }: { entry: ActivityEntry }) => (entry.actor.kind === "agent" ? <span className="agd-pill">AI agent</span> : null);

/** The activity feed of one item, newest first.  */
export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) return <p className="drive-muted">No activity yet.</p>;
  return (
    <ol className="drive-activity" aria-label="Activity">
      {entries.map((e) => (
        <li key={e.id}>
          <strong>{e.actor.id}</strong> <AgentLabel entry={e} /> {VERBS[e.action]} {detailText(e)}{" "}
          <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
        </li>
      ))}
    </ol>
  );
}

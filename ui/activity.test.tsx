// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { ActivityList } from "./Activity.js";
import type { ActivityEntry } from "../src/client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string, kind: "human" | "agent", action: ActivityEntry["action"], detail?: ActivityEntry["detail"]): ActivityEntry => ({
  id, itemId: "i1", action, actor: { id: kind === "agent" ? "bot" : "ada", kind }, principalKind: kind === "agent" ? "agent_of_human" : "human", at: 1_700_000_000_000, ...(detail ? { detail } : {}),
});

async function render(entries: ActivityEntry[]) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(<ActivityList entries={entries} />));
  return host;
}

describe("ActivityList", () => {
  it("shows an AI agent label on agent entries only", async () => {
    const host = await render([entry("2", "agent", "rename", { from: "a", to: "b" }), entry("1", "human", "create")]);
    const rows = [...host.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("AI agent");
    expect(rows[0]!.textContent).toContain('renamed it from "a" to "b"');
    expect(rows[1]!.textContent).not.toContain("AI agent");
    expect(rows[1]!.textContent).toContain("ada");
  });
  it("says so when nothing happened", async () => {
    expect((await render([])).textContent).toContain("No activity yet.");
  });
});

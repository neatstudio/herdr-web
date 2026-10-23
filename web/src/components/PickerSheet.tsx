import { useState } from "react";
import type { AgentPane } from "@/lib/fleet";
import { orderByTone, paneAgent, paneListName, toneOf } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";

type Props = {
  open: boolean;
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedWorkspaceId: string | null;
  selectedPaneId: string | null;
  onWorkspace: (workspaceId: string) => void;
  onPane: (pane: AgentPane) => void;
  onClose: () => void;
};

type View = "agents" | "spaces";

/**
 * The phone's whole navigation, because both sidebar halves are hidden there.
 * It carries the same two lists and a switch between them, so the current
 * workspace and the running agents are each one tap away instead of stacked
 * into a scroll that never fits.
 */
export function PickerSheet({
  open,
  workspaces,
  panes,
  selectedWorkspaceId,
  selectedPaneId,
  onWorkspace,
  onPane,
  onClose,
}: Props) {
  const [view, setView] = useState<View>("agents");
  const [query, setQuery] = useState("");
  if (!open) {
    return null;
  }

  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const current = names.get(selectedWorkspaceId ?? "") ?? "none";
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  // Only panes with an agent: a plain shell is not something to watch here.
  const running = panes.filter((pane) => paneAgent(pane) !== "");
  const agents = orderByTone(running, (pane) => toneOf(pane.agentStatus)).filter((pane) => {
    if (terms.length === 0) {
      return true;
    }
    const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
    const haystack = [workspaceName, pane.id, paneAgent(pane), paneListName(pane, workspaceName)]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Navigate">
      <div className="sheet__head">
        <span className="sheet__title" id="herdr-sheet-title">
          {current}
        </span>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="sheet__views" role="tablist" aria-label="View">
        {(["agents", "spaces"] as View[]).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`herdr-sheet-view-${item}`}
            className="sheet__view"
            aria-selected={view === item}
            onClick={() => setView(item)}
          >
            {item}
            <span className="sheet__view-count">
              {item === "agents" ? running.length : workspaces.length}
            </span>
          </button>
        ))}
      </div>

      {view === "agents" && (
        <div className="col__filter">
          <input
            id="herdr-sheet-filter"
            className="col__input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="filter agents…"
            aria-label="Filter agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
            <button
              type="button"
              className="col__clear"
              aria-label="Clear the filter"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
      )}

      <div className="sheet__body">
        <div className="col__list">
          {view === "spaces"
            ? workspaces.map((workspace) => {
                const count = panes.filter((pane) => pane.workspaceId === workspace.id).length;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="srow srow--space"
                    data-workspace-id={workspace.id}
                    aria-current={workspace.id === selectedWorkspaceId ? "true" : undefined}
                    onClick={() => {
                      onWorkspace(workspace.id);
                      // Back to the agents: picking a space is always in order
                      // to look at what is running in it.
                      setView("agents");
                    }}
                  >
                    <span className="srow__name">
                      {workspace.name}
                      <span className="row__id">
                        {count} {count === 1 ? "pane" : "panes"}
                      </span>
                    </span>
                  </button>
                );
              })
            : agents.map((pane) => {
                const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
                return (
                  <button
                    key={pane.id}
                    type="button"
                    className="srow"
                    data-pane-id={pane.id}
                    data-tone={toneOf(pane.agentStatus)}
                    aria-current={pane.id === selectedPaneId ? "true" : undefined}
                    onClick={() => onPane(pane)}
                  >
                    <span className="srow__agent">{paneAgent(pane) || "shell"}</span>
                    <span className="srow__name">
                      {paneListName(pane, workspaceName)}
                      <span className="row__id">{workspaceName}</span>
                    </span>
                  </button>
                );
              })}
          {view === "spaces" && workspaces.length === 0 && (
            <p className="col__empty">No workspaces reported.</p>
          )}
          {view === "agents" && agents.length === 0 && (
            <p className="col__empty">No pane matches “{query}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

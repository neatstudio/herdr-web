import { useState } from "react";
import type { AgentPane } from "@/lib/fleet";
import { orderByTone, paneAgent, paneListName, paneRowName, statusNote, toneOf } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import { longPressHandlers } from "@/lib/press";

type Props = {
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedWorkspaceId: string | null;
  selectedPaneId: string | null;
  onWorkspace: (workspaceId: string) => void;
  onPane: (pane: AgentPane) => void;
  onWorkspaceMenu: (workspace: HerdrWorkspace, x: number, y: number) => void;
  /** Opens the sheet that makes a workspace or takes over a tmux session. */
  onNewWorkspace: () => void;
  onPaneMenu: (pane: AgentPane, x: number, y: number) => void;
};

/**
 * The sidebar in two equal halves. Spaces are a place you attach to, so they
 * are listed in the order herdr started them and carry no status at all; the
 * agents are what is actually running, so they are ordered by what they need
 * and coloured to say so, with no labels or markers in between.
 */
export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <Spaces {...props} />
      <Agents {...props} />
    </aside>
  );
}

function Spaces({
  workspaces,
  panes,
  selectedWorkspaceId,
  onWorkspace,
  onWorkspaceMenu,
  onNewWorkspace,
}: Props) {
  return (
    <section className="side side--spaces" aria-label="Workspaces">
      <div className="col__head">
        <span>workspaces</span>
        <span className="col__count">
          {workspaces.length}
          <button
            type="button"
            id="herdr-new-workspace"
            className="col__add"
            title="new workspace, or take over a tmux session"
            aria-label="New workspace"
            onClick={onNewWorkspace}
          >
            +
          </button>
        </span>
      </div>
      {workspaces.length === 0 ? (
        <p className="col__empty">No workspaces reported.</p>
      ) : (
        <div className="col__list">
          {workspaces.map((workspace) => {
            const own = panes.filter((pane) => pane.workspaceId === workspace.id);
            const agents = own.filter((pane) => paneAgent(pane) !== "").length;
            const active = workspace.id === selectedWorkspaceId;
            return (
              <button
                key={workspace.id}
                type="button"
                className="wrow"
                data-workspace-id={workspace.id}
                aria-current={active ? "true" : undefined}
                title={`${workspace.name} — ${workspace.id}`}
                onClick={() => onWorkspace(workspace.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onWorkspaceMenu(workspace, event.clientX, event.clientY);
                }}
                {...longPressHandlers({
                  onLongPress: (x, y) => onWorkspaceMenu(workspace, x, y),
                })}
              >
                <span className="wrow__name">{workspace.name}</span>
                <span className="wrow__count">
                  <span title={`${own.length} panes`}>{own.length}p</span>
                  {agents > 0 && <span title={`${agents} agents`}>{agents}a</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Agents({ panes, workspaces, selectedPaneId, onPane, onPaneMenu }: Props) {
  const [query, setQuery] = useState("");
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  // Only panes herdr recognised an agent in. A plain shell is not something to
  // watch here; the pane tabs above the transcript still reach it.
  const running = panes.filter((pane) => paneAgent(pane) !== "");
  const matched = orderByTone(running, (pane) => toneOf(pane.agentStatus)).filter((pane) => {
    if (terms.length === 0) {
      return true;
    }
    const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
    const haystack = [
      workspaceName,
      pane.id,
      paneAgent(pane),
      paneListName(pane, workspaceName),
      pane.cwd ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return (
    <section className="side side--agents" aria-label="Agents">
      <div className="col__head">
        <span>agents</span>
        <span>
          {terms.length === 0 ? running.length : `${matched.length}/${running.length}`}
        </span>
      </div>
      <div className="col__filter">
        <input
          id="herdr-agent-filter"
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
            id="herdr-agent-clear"
            className="col__clear"
            aria-label="Clear the filter"
            onClick={() => setQuery("")}
          >
            ×
          </button>
        )}
      </div>
      {panes.length === 0 ? (
        <p className="col__empty">No panes reported.</p>
      ) : running.length === 0 ? (
        <p className="col__empty">No agents running.</p>
      ) : matched.length === 0 ? (
        <p className="col__empty">No pane matches “{query}”.</p>
      ) : (
        <div className="col__list">
          {matched.map((pane) => {
            const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
            const agent = paneAgent(pane);
            const active = pane.id === selectedPaneId;
            const note = statusNote(pane.agentStatus);
            return (
              <button
                key={pane.id}
                type="button"
                className="row"
                data-pane-id={pane.id}
                data-tone={toneOf(pane.agentStatus)}
                aria-current={active ? "true" : undefined}
                title={`${paneListName(pane, workspaceName)} — ${pane.id} (${workspaceName})${
                  note === undefined ? "" : ` · ${note}`
                }`}
                onClick={() => onPane(pane)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onPaneMenu(pane, event.clientX, event.clientY);
                }}
                {...longPressHandlers({ onLongPress: (x, y) => onPaneMenu(pane, x, y) })}
              >
                {/* Status is the colour of the name, not a mark beside it. */}
                <span className="row__agent">{agent === "" ? "shell" : agent}</span>
                <span className="row__name">{paneRowName(pane, workspaceName)}</span>
                <span className="row__workspace" title={workspaceName}>
                  {workspaceName}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

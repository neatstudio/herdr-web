import { useState } from "react";
import type { AgentPane, FleetPane } from "@/lib/fleet";
import {
  TONE_CODE,
  TONE_LABEL,
  filterFleet,
  groupByTone,
  groupFleet,
  paneAgent,
  paneListName,
} from "@/lib/fleet";
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
  onPaneMenu: (pane: AgentPane, x: number, y: number) => void;
};

/**
 * The sidebar, split the way herdr splits it: the spaces you attach to on top,
 * and the agents actually working underneath. They answer different questions —
 * "where am I working" versus "what needs me" — so they get their own halves
 * and scroll independently.
 */
export function Sidebar({
  workspaces,
  panes,
  selectedWorkspaceId,
  selectedPaneId,
  onWorkspace,
  onPane,
  onWorkspaceMenu,
  onPaneMenu,
}: Props) {
  return (
    <aside className="sidebar">
      <Spaces
        workspaces={workspaces}
        panes={panes}
        selectedId={selectedWorkspaceId}
        onSelect={onWorkspace}
        onMenu={onWorkspaceMenu}
      />
      <Agents
        panes={panes}
        workspaces={workspaces}
        selectedId={selectedPaneId}
        onSelect={onPane}
        onMenu={onPaneMenu}
      />
    </aside>
  );
}

type SpacesProps = {
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedId: string | null;
  onSelect: (workspaceId: string) => void;
  onMenu: (workspace: HerdrWorkspace, x: number, y: number) => void;
};

function Spaces({ workspaces, panes, selectedId, onSelect, onMenu }: SpacesProps) {
  const groups = groupByTone(workspaces, (workspace) => workspace.agentStatus);

  return (
    <section className="side side--spaces" aria-label="Workspaces">
      <div className="col__head">
        <span>spaces</span>
        <span>{workspaces.length}</span>
      </div>
      {workspaces.length === 0 ? (
        <p className="col__empty">No workspaces reported.</p>
      ) : (
        <div className="col__list">
          {groups.map((group) => (
            <div key={group.tone} className="group" data-group={group.tone}>
              <div className="group__label">
                <span className="signal" data-tone={group.tone} aria-hidden />
                <span className="group__label-text">{TONE_LABEL[group.tone]}</span>
                <span className="group__code" aria-hidden>
                  {TONE_CODE[group.tone]}
                </span>
                <span className="group__count">{group.items.length}</span>
              </div>
              {group.items.map((workspace, index) => {
                const own = panes.filter((pane) => pane.workspaceId === workspace.id);
                const agents = own.filter((pane) => paneAgent(pane) !== "").length;
                const active = workspace.id === selectedId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="wrow"
                    data-workspace-id={workspace.id}
                    data-tone={group.tone}
                    aria-current={active ? "true" : undefined}
                    title={`${workspace.name} — ${workspace.id}`}
                    style={{ ["--i" as string]: index, ["--signal" as string]: `var(--${group.tone})` }}
                    onClick={() => onSelect(workspace.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onMenu(workspace, event.clientX, event.clientY);
                    }}
                    {...longPressHandlers({ onLongPress: (x, y) => onMenu(workspace, x, y) })}
                  >
                    <span className="signal" data-tone={group.tone} aria-hidden />
                    <span className="wrow__name">{workspace.name}</span>
                    <span className="wrow__count">
                      <span title={`${own.length} panes`}>{own.length}p</span>
                      {agents > 0 && <span title={`${agents} agents`}>{agents}a</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type AgentsProps = {
  panes: AgentPane[];
  workspaces: HerdrWorkspace[];
  selectedId: string | null;
  onSelect: (pane: AgentPane) => void;
  onMenu: (pane: AgentPane, x: number, y: number) => void;
};

function Agents({ panes, workspaces, selectedId, onSelect, onMenu }: AgentsProps) {
  const [query, setQuery] = useState("");
  const groups = groupFleet(panes, workspaces)
    .map((group) => ({ tone: group.tone, items: filterFleet(group.items, query) }))
    .filter((group) => group.items.length > 0);
  const matched = groups.reduce((count, group) => count + group.items.length, 0);
  const agents = panes.filter((pane) => paneAgent(pane) !== "").length;

  return (
    <section className="side side--agents" aria-label="Agents">
      <div className="col__head">
        <span>agents</span>
        <span>{query.trim() === "" ? `${agents}/${panes.length}` : `${matched}/${panes.length}`}</span>
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
      ) : groups.length === 0 ? (
        <p className="col__empty">No pane matches “{query}”.</p>
      ) : (
        <div className="col__list">
          {groups.map((group) => (
            <div
              key={group.tone}
              className={group.tone === "blocked" ? "group group--blocked" : "group"}
              data-group={group.tone}
            >
              <div className="group__label">
                <span className="signal" data-tone={group.tone} aria-hidden />
                <span className="group__label-text">{TONE_LABEL[group.tone]}</span>
                <span className="group__code" aria-hidden>
                  {TONE_CODE[group.tone]}
                </span>
                <span className="group__count">{group.items.length}</span>
              </div>
              {group.items.map((row, index) => (
                <AgentRow
                  key={row.pane.id}
                  row={row}
                  index={index}
                  tone={group.tone}
                  active={row.pane.id === selectedId}
                  onSelect={onSelect}
                  onMenu={onMenu}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type RowProps = {
  row: FleetPane;
  index: number;
  tone: string;
  active: boolean;
  onSelect: (pane: AgentPane) => void;
  onMenu: (pane: AgentPane, x: number, y: number) => void;
};

function AgentRow({ row, index, tone, active, onSelect, onMenu }: RowProps) {
  const agent = paneAgent(row.pane);
  const name = paneListName(row.pane, row.workspaceName);
  return (
    <button
      type="button"
      className="row"
      data-pane-id={row.pane.id}
      data-tone={tone}
      aria-current={active ? "true" : undefined}
      title={`${name} — ${row.pane.id} (${row.workspaceName})`}
      style={{ ["--i" as string]: index, ["--signal" as string]: `var(--${tone})` }}
      onClick={() => onSelect(row.pane)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(row.pane, event.clientX, event.clientY);
      }}
      {...longPressHandlers({ onLongPress: (x, y) => onMenu(row.pane, x, y) })}
    >
      <span className="signal" data-tone={tone} aria-hidden />
      <span className="row__agent" data-plain={agent === "" ? "true" : undefined}>
        {agent === "" ? "shell" : agent}
      </span>
      <span className="row__name">{name}</span>
      <span className="row__workspace" title={row.workspaceName}>
        {row.workspaceName}
      </span>
    </button>
  );
}

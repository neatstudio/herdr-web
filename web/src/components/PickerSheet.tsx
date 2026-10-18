import { useState } from "react";
import type { AgentPane } from "@/lib/fleet";
import {
  TONE_LABEL,
  filterFleet,
  groupFleet,
  paneAgent,
  paneListName,
  toneOf,
} from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import { longPressHandlers } from "@/lib/press";

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

/**
 * The phone's navigation, as two levels rather than two scrollers: the space is
 * the first level and starts collapsed, its panes are the second level and
 * start open. Switching space is one tap, and picking a pane closes the sheet,
 * so neither level ever needs a drag to find something.
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
  const [query, setQuery] = useState("");
  const [spacesOpen, setSpacesOpen] = useState(false);
  if (!open) {
    return null;
  }

  const searching = query.trim() !== "";
  const current = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const own = panes.filter((pane) => pane.workspaceId === selectedWorkspaceId);
  const matches = searching
    ? groupFleet(panes, workspaces)
        .map((group) => ({ tone: group.tone, items: filterFleet(group.items, query) }))
        .filter((group) => group.items.length > 0)
    : [];
  const matched = matches.reduce((count, group) => count + group.items.length, 0);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Choose a pane">
      <div className="sheet__head">
        <span className="sheet__title" id="herdr-sheet-title">
          {current?.name ?? "choose a pane"}
        </span>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="col__filter">
        <input
          id="herdr-sheet-filter"
          className="col__input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="filter every pane…"
          aria-label="Filter every pane"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && (
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

      <div className="sheet__body">
        {searching ? (
          <>
            <div className="sheet__level">all panes · {matched}</div>
            <div className="col__list">
              {matches.map((group) => (
                <div key={group.tone} className="group" data-group={group.tone}>
                  <div className="group__label">
                    <span className="signal" data-tone={group.tone} aria-hidden />
                    <span className="group__label-text">{TONE_LABEL[group.tone]}</span>
                    <span className="group__count">{group.items.length}</span>
                  </div>
                  {group.items.map((row) => (
                    <button
                      key={row.pane.id}
                      type="button"
                      className="srow"
                      data-pane-id={row.pane.id}
                      aria-current={row.pane.id === selectedPaneId ? "true" : undefined}
                      onClick={() => onPane(row.pane)}
                    >
                      <span className="signal" data-tone={group.tone} aria-hidden />
                      <span className="srow__agent">{paneAgent(row.pane) || "shell"}</span>
                      <span className="srow__name">
                        {paneListName(row.pane, row.workspaceName)}
                        <span className="row__id">{row.workspaceName}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Level one: the spaces, collapsed until asked for. */}
            <button
              type="button"
              id="herdr-sheet-spaces"
              className="sheet__level sheet__level--toggle"
              aria-expanded={spacesOpen}
              onClick={() => setSpacesOpen((open2) => !open2)}
            >
              <span>spaces</span>
              <span className="sheet__level-current">{current?.name ?? "none"}</span>
              <span className="sheet__chevron" aria-hidden>
                {spacesOpen ? "▾" : "▸"}
              </span>
            </button>
            {spacesOpen && (
              <div className="col__list">
                {workspaces.map((workspace) => {
                  const count = panes.filter((pane) => pane.workspaceId === workspace.id).length;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      className="srow"
                      data-workspace-id={workspace.id}
                      aria-current={workspace.id === selectedWorkspaceId ? "true" : undefined}
                      onClick={() => {
                        onWorkspace(workspace.id);
                        setSpacesOpen(false);
                      }}
                      onContextMenu={(event) => event.preventDefault()}
                      {...longPressHandlers({ onLongPress: () => setSpacesOpen(false) })}
                    >
                      <span className="signal" data-tone={toneOf(workspace.agentStatus)} aria-hidden />
                      <span className="srow__agent">space</span>
                      <span className="srow__name">
                        {workspace.name}
                        <span className="row__id">{count} panes</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Level two: this space's panes, open from the start. */}
            <div className="sheet__level">panes · {own.length}</div>
            <div className="col__list">
              {own.map((pane) => {
                const tone = toneOf(pane.agentStatus);
                return (
                  <button
                    key={pane.id}
                    type="button"
                    className="srow"
                    data-pane-id={pane.id}
                    aria-current={pane.id === selectedPaneId ? "true" : undefined}
                    onClick={() => onPane(pane)}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <span className="signal" data-tone={tone} aria-hidden />
                    <span className="srow__agent">{paneAgent(pane) || "shell"}</span>
                    <span className="srow__name">
                      {paneListName(pane, current?.name ?? "")}
                      {pane.label !== undefined && pane.label !== "" && (
                        <span className="row__id">{pane.id}</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {own.length === 0 && <p className="col__empty">This space reports no panes.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

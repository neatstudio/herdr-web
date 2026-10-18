import { useState } from "react";
import type { AgentPane } from "@/lib/fleet";
import {
  TONE_CODE,
  TONE_LABEL,
  filterFleet,
  groupByTone,
  groupFleet,
  paneAgent,
  paneListName,
  toneOf,
} from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";

type Props = {
  open: boolean;
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedWorkspaceId: string | null;
  selectedPaneId: string | null;
  onPick: (pane: AgentPane) => void;
  onClose: () => void;
};

/**
 * The phone's replacement for the two sidebar columns. Horizontal scrollers
 * were the alternative, and hunting for a pane by dragging a strip is exactly
 * the inconvenience this avoids: one tap opens a full-width list, and the
 * filter reaches every pane in every workspace at once.
 */
export function PickerSheet({
  open,
  workspaces,
  panes,
  selectedWorkspaceId,
  selectedPaneId,
  onPick,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  if (!open) {
    return null;
  }

  const searching = query.trim() !== "";
  const fleet = searching
    ? groupFleet(panes, workspaces).map((group) => ({
        tone: group.tone,
        items: filterFleet(group.items, query),
      }))
    : [];
  const byWorkspace = groupByTone(workspaces, (workspace) => workspace.agentStatus).map((group) => ({
    tone: group.tone,
    items: group.items.map((workspace) => ({
      workspace,
      panes: panes.filter((pane) => pane.workspaceId === workspace.id),
    })),
  }));
  const total = fleet.reduce((count, group) => count + group.items.length, 0);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Choose a pane">
      <div className="sheet__head">
        <span className="sheet__title">{searching ? `${total} matching panes` : "choose a pane"}</span>
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
          <div className="col__list">
            {fleet.map((group) => (
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
                    onClick={() => onPick(row.pane)}
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
        ) : (
          <div className="col__list">
            {byWorkspace.map((group) => (
              <div key={group.tone} className="group" data-group={group.tone}>
                <div className="group__label">
                  <span className="signal" data-tone={group.tone} aria-hidden />
                  <span className="group__label-text">{TONE_LABEL[group.tone]}</span>
                  <span className="group__code" aria-hidden>
                    {TONE_CODE[group.tone]}
                  </span>
                </div>
                {group.items.map(({ workspace, panes: own }) => (
                  <div key={workspace.id} className="sheet__workspace">
                    <div
                      className="sheet__workspace-name"
                      data-workspace-id={workspace.id}
                      data-current={workspace.id === selectedWorkspaceId ? "true" : undefined}
                    >
                      {workspace.name}
                      <span className="row__id">{own.length} panes</span>
                    </div>
                    {own.map((pane) => {
                      const tone = toneOf(pane.agentStatus);
                      return (
                        <button
                          key={pane.id}
                          type="button"
                          className="srow"
                          data-pane-id={pane.id}
                          aria-current={pane.id === selectedPaneId ? "true" : undefined}
                          onClick={() => onPick(pane)}
                        >
                          <span className="signal" data-tone={tone} aria-hidden />
                          <span className="srow__agent">{paneAgent(pane) || "shell"}</span>
                          <span className="srow__name">{paneListName(pane, workspace.name)}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

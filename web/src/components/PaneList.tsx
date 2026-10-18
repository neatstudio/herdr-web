import { useState } from "react";
import type { AgentPane, FleetPane } from "@/lib/fleet";
import { TONE_CODE, TONE_LABEL, filterFleet, groupFleet, paneAgent, paneListName, paneOwnHasName, shortPaneId } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import { longPressHandlers } from "@/lib/press";

type Props = {
  /** Every pane in the selected workspace. */
  panes: AgentPane[];
  workspaces: HerdrWorkspace[];
  selectedPaneId: string | null;
  onSelect: (pane: AgentPane) => void;
  onMenu: (pane: AgentPane, x: number, y: number) => void;
};

/**
 * The second column: the panes of the selected workspace, grouped by what each
 * pane needs from a human. Selecting one opens its transcript in the third
 * column, so no pane is ever more than one click away.
 */
export function PaneList({ panes, workspaces, selectedPaneId, onSelect, onMenu }: Props) {
  const [query, setQuery] = useState("");
  const groups = groupFleet(panes, workspaces)
    .map((group) => ({ tone: group.tone, items: filterFleet(group.items, query) }))
    .filter((group) => group.items.length > 0);
  const agents = panes.filter((pane) => paneAgent(pane) !== "").length;

  return (
    <div className="panes" aria-label="Panes">
      <div className="col__head">
        <span>panes</span>
        <span>
          {query.trim() === "" ? `${agents}/${panes.length} agents` : `${groups.reduce((n, g) => n + g.items.length, 0)}/${panes.length}`}
        </span>
      </div>

      <div className="col__filter">
        <input
          id="herdr-fleet-filter"
          className="col__input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="filter panes…"
          aria-label="Filter panes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== "" && (
          <button
            type="button"
            id="herdr-fleet-clear"
            className="col__clear"
            aria-label="Clear the filter"
            onClick={() => setQuery("")}
          >
            ×
          </button>
        )}
      </div>

      {panes.length === 0 ? (
        <p className="col__empty">This workspace reports no panes.</p>
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
                <PaneRow
                  key={row.pane.id}
                  row={row}
                  index={index}
                  tone={group.tone}
                  active={row.pane.id === selectedPaneId}
                  onSelect={onSelect}
                  onMenu={onMenu}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
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

function PaneRow({ row, index, tone, active, onSelect, onMenu }: RowProps) {
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
      <span className="row__name">
        {name}
        {paneOwnHasName(row.pane) && <span className="row__id">{shortPaneId(row.pane.id)}</span>}
      </span>
    </button>
  );
}

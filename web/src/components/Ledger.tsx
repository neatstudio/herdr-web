import type { AgentPane, FleetPane } from "@/lib/fleet";
import {
  TONE_CODE,
  TONE_LABEL,
  groupFleet,
  paneAgent,
  paneListName,
  paneOwnHasName,
  shortPaneId,
} from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";

type Props = {
  panes: AgentPane[];
  workspaces: HerdrWorkspace[];
  selectedPaneId: string | null;
  onSelect: (pane: AgentPane) => void;
};

/**
 * The fleet: one row per pane, grouped by what that pane needs from a human.
 *
 * herdr draws a real distinction here. A workspace is a directory plus a set
 * of tabs — closer to an SSH host than to a unit of work. The thing actually
 * working is the agent detected inside a pane, so the agent leads each row and
 * the workspace follows it as context.
 */
export function Ledger({ panes, workspaces, selectedPaneId, onSelect }: Props) {
  const groups = groupFleet(panes, workspaces);
  const agents = panes.filter((pane) => paneAgent(pane) !== "").length;

  return (
    <nav className="ledger" aria-label="Agents">
      <div className="ledger__head">
        <span>fleet</span>
        <span>
          {agents}/{panes.length} agents
        </span>
      </div>

      {panes.length === 0 ? (
        <p className="ledger__empty">
          No panes reported. Start a herdr session and this list fills in.
        </p>
      ) : (
        <div className="ledger__list">
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
                <Row
                  key={row.pane.id}
                  row={row}
                  index={index}
                  tone={group.tone}
                  active={row.pane.id === selectedPaneId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

type RowProps = {
  row: FleetPane;
  index: number;
  tone: string;
  active: boolean;
  onSelect: (pane: AgentPane) => void;
};

function Row({ row, index, tone, active, onSelect }: RowProps) {
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
    >
      <span className="signal" data-tone={tone} aria-hidden />
      {/* Which agent, then what it is called, then where it lives. */}
      <span className="row__agent" data-plain={agent === "" ? "true" : undefined}>
        {agent === "" ? "shell" : agent}
      </span>
      <span className="row__name">
        {name}
        {/* The short id only helps when the name is something else; when the
            name already is the id, repeating it just looks like noise. */}
        {paneOwnHasName(row.pane) && <span className="row__id">{shortPaneId(row.pane.id)}</span>}
      </span>
      <span className="row__workspace" title={row.workspaceName}>
        {row.workspaceName}
      </span>
    </button>
  );
}

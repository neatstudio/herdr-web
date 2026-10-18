import { TONE_CODE, TONE_LABEL, groupByTone, paneAgent } from "@/lib/fleet";
import type { AgentPane } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import { longPressHandlers } from "@/lib/press";

type Props = {
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedId: string | null;
  onSelect: (workspaceId: string) => void;
  onMenu: (workspace: HerdrWorkspace, x: number, y: number) => void;
};

/**
 * The main column: herdr workspaces, which is what an operator thinks of as a
 * host to attach to. Grouped by the workspace's own status so the ones that
 * need attention rise to the top, and each row carries how many panes and how
 * many of those are agents.
 */
export function WorkspaceRail({ workspaces, panes, selectedId, onSelect, onMenu }: Props) {
  const groups = groupByTone(workspaces, (workspace) => workspace.agentStatus);

  return (
    <nav className="rail" aria-label="Workspaces">
      <div className="col__head">
        <span>workspaces</span>
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
                const mine = panes.filter((pane) => pane.workspaceId === workspace.id);
                const agents = mine.filter((pane) => paneAgent(pane) !== "").length;
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
                    {...longPressHandlers({
                      onLongPress: (x, y) => onMenu(workspace, x, y),
                    })}
                  >
                    <span className="signal" data-tone={group.tone} aria-hidden />
                    <span className="wrow__name">{workspace.name}</span>
                    <span className="wrow__count">
                      <span title={`${mine.length} panes`}>{mine.length}p</span>
                      {agents > 0 && <span title={`${agents} agents`}>{agents}a</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

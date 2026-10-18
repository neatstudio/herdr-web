import type { HerdrWorkspace } from "@/lib/herdr";
import { TONE_CODE, TONE_LABEL, groupByTone } from "@/lib/fleet";

type Props = {
  workspaces: HerdrWorkspace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/** Workspaces grouped by what they need from a human, blocked first. */
export function Ledger({ workspaces, selectedId, onSelect }: Props) {
  const groups = groupByTone(workspaces, (workspace) => workspace.agentStatus);

  return (
    <nav className="ledger" aria-label="Workspaces">
      <div className="ledger__head">
        <span>workspaces</span>
        <span>{workspaces.length}</span>
      </div>

      {workspaces.length === 0 ? (
        <p className="ledger__empty">
          No workspaces reported. Start a herdr session and this list fills in.
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
              </div>
              {group.items.map((workspace, index) => {
                const active = workspace.id === selectedId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="row"
                    data-workspace-id={workspace.id}
                    data-tone={group.tone}
                    aria-current={active ? "true" : undefined}
                    style={{ ["--i" as string]: index, ["--signal" as string]: `var(--${group.tone})` }}
                    onClick={() => onSelect(workspace.id)}
                  >
                    <span className="signal" data-tone={group.tone} aria-hidden />
                    <span className="row__name" title={workspace.name}>
                      {workspace.name}
                    </span>
                    <span className="row__meta">
                      <span title={`${workspace.paneCount} panes`}>{workspace.paneCount}p</span>
                      <span title={`${workspace.windows} tabs`}>{workspace.windows}t</span>
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

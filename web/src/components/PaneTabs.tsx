import type { HerdrPane } from "@/lib/herdr";
import { paneListName, paneOwnHasName, shortPaneId, toneOf } from "@/lib/fleet";
import { longPressHandlers } from "@/lib/press";

type Props = {
  panes: HerdrPane[];
  /** Only used to skip a directory that merely repeats the space's name. */
  workspaceName: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onMenu: (paneId: string, x: number, y: number) => void;
  /** Split the active pane: how a new pane is made. */
  onNewPane: () => void;
  canSplit: boolean;
};

/**
 * The pane tabs above the transcript, as herdr shows them. Each tab carries the
 * pane's own name (label, then title, then terminal title) with the id beside
 * it, and doubles as the right-click and long-press target for the pane menu.
 */
export function PaneTabs({ panes, workspaceName, activeId, onSelect, onMenu, onNewPane, canSplit }: Props) {
  if (panes.length === 0) {
    return null;
  }
  return (
    <div className="strip" role="tablist" aria-label="Panes">
      {panes.map((pane, index) => {
        const active = pane.id === activeId;
        const tone = toneOf(pane.agentStatus);
        const name = paneListName(pane, workspaceName);
        const named = paneOwnHasName(pane);
        return (
          <button
            key={pane.id}
            type="button"
            role="tab"
            className="tab"
            data-pane-id={pane.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={named ? `${name} — ${pane.id}` : pane.id}
            onClick={() => onSelect(pane.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(pane.id, event.clientX, event.clientY);
            }}
            {...longPressHandlers({ onLongPress: (x, y) => onMenu(pane.id, x, y) })}
          >
            <span className="tab__index">{index + 1}</span>
            <span data-pane-title={pane.id} className="tab__name">
              {name}
            </span>
            {/* Keep the id visible when it is not already the name, so a tab
                can still be matched against `herdr pane` output. */}
            {named && <span className="tab__id">{shortPaneId(pane.id)}</span>}
            <span className="signal" data-tone={tone} aria-hidden />
          </button>
        );
      })}
      {canSplit && (
        <button
          type="button"
          id="herdr-new-pane"
          className="tab tab--new"
          title="new pane: split this one"
          aria-label="New pane"
          onClick={onNewPane}
        >
          +
        </button>
      )}
    </div>
  );
}

import type { HerdrPane } from "@/lib/herdr";
import { paneHasName, paneName, shortPaneId, toneOf } from "@/lib/fleet";
import { longPressHandlers } from "@/lib/press";

type Props = {
  panes: HerdrPane[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onMenu: (paneId: string, x: number, y: number) => void;
};

/**
 * Numbered pane tabs. Each tab shows the pane's own name (herdr label, then
 * title, then terminal title, then agent) and falls back to the pane id. The
 * tab label doubles as the right-click target, so the menu opens only on the
 * pane title and never on the surrounding chrome.
 */
export function PaneStrip({ panes, activeId, onSelect, onMenu }: Props) {
  if (panes.length === 0) {
    return null;
  }
  return (
    <div className="strip" role="tablist" aria-label="Panes">
      {panes.map((pane, index) => {
        const active = pane.id === activeId;
        const tone = toneOf(pane.agentStatus);
        const name = paneName(pane);
        const named = paneHasName(pane);
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
            <span className="tab__index">{String(index + 1).padStart(2, "0")}</span>
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
    </div>
  );
}

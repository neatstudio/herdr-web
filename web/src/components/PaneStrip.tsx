import type { HerdrPane } from "@/lib/herdr";
import { toneOf } from "@/lib/fleet";

type Props = {
  panes: HerdrPane[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onMenu: (paneId: string, x: number, y: number) => void;
};

/**
 * Numbered pane tabs. The tab label doubles as the right-click target, so the
 * menu opens only on the pane title and never on the surrounding chrome.
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
        return (
          <button
            key={pane.id}
            type="button"
            role="tab"
            className="tab"
            data-pane-id={pane.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(pane.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(pane.id, event.clientX, event.clientY);
            }}
          >
            <span className="tab__index">{String(index + 1).padStart(2, "0")}</span>
            <span data-pane-title={pane.id}>{pane.id}</span>
            <span className="signal" data-tone={tone} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

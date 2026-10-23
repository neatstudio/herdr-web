import { useEffect, useRef, useState } from "react";
import type { HerdrPane } from "@/lib/herdr";
import { paneListName, paneOwnHasName, shortPaneId, toneOf } from "@/lib/fleet";
import { longPressHandlers } from "@/lib/press";

type Props = {
  panes: HerdrPane[];
  /** Only used to skip a directory that merely repeats the space's name. */
  workspaceName: string;
  /**
   * The tab that holds the pane being read. A tab is selected because it
   * *contains* that pane, not because its label happens to be that pane: after a
   * split the pane in front is one the tab does not name.
   */
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onMenu: (paneId: string, x: number, y: number) => void;
  /** Add a tab to the workspace: a new shell, not a split. */
  onNewTab: () => void;
  canSplit: boolean;
};

/**
 * The pane tabs above the transcript, as herdr shows them. Each tab carries the
 * pane's own name (label, then title, then terminal title) with the id beside
 * it, and doubles as the right-click and long-press target for the pane menu.
 */
export function PaneTabs({
  panes,
  workspaceName,
  activeTabId,
  onSelect,
  onMenu,
  onNewTab,
  canSplit,
}: Props) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // A strip that overflows shows its first tabs, not the one being read. Keep
  // the selected tab in view; "nearest" means no scrolling when it already is.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // Scrolled, the leftmost tab is a fragment cut mid-glyph. Fading that edge
  // says "there is more to the left" instead of leaving a stray character.
  const [scrolled, setScrolled] = useState(false);

  if (panes.length === 0) {
    return null;
  }
  return (
    <div
      className={scrolled ? "strip strip--scrolled" : "strip"}
      role="tablist"
      aria-label="Panes"
      ref={stripRef}
      onScroll={() => {
        const left = stripRef.current?.scrollLeft ?? 0;
        if (left > 4 !== scrolled) {
          setScrolled(left > 4);
        }
      }}
    >
      {panes.map((pane, index) => {
        const active = pane.tabId === activeTabId;
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
            ref={active ? activeRef : undefined}
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
          id="herdr-new-tab"
          className="tab tab--new"
          title="new tab in this workspace"
          aria-label="New tab"
          onClick={onNewTab}
        >
          +
        </button>
      )}
    </div>
  );
}

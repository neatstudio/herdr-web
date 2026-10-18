import type { AgentPane } from "@/lib/fleet";
import { paneAgent, paneListName, paneOwnHasName, shortPaneId, toneOf } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import type { ArrangeMode, Tile } from "@/lib/layout";
import { Scope } from "@/components/Scope";
import { PROMPT_ID, keyboardIsPrimary } from "@/lib/focus";
import type { DisplayMode } from "@/lib/theme";

type Props = {
  tiles: Tile[];
  panes: AgentPane[];
  workspaces: HerdrWorkspace[];
  activePaneId: string | null;
  mode: ArrangeMode;
  theme: "light" | "dark";
  display: DisplayMode;
  onDisplay: (mode: DisplayMode) => void;
  onActivate: (paneId: string) => void;
  onMenu: (pane: AgentPane, x: number, y: number) => void;
};

/**
 * One tab's panes, laid out as herdr splits them. Each tile keeps its own
 * transcript, so a split reads as it does in the terminal; the tile holding the
 * caret is the one the prompt sends to.
 */
export function TabStage({
  tiles,
  panes,
  workspaces,
  activePaneId,
  mode,
  theme,
  display,
  onDisplay,
  onActivate,
  onMenu,
}: Props) {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));

  return (
    <div className="tiles" data-arrange={mode} data-count={tiles.length}>
      {tiles.map((tile) => {
        const pane = panes.find((candidate) => candidate.id === tile.id);
        if (pane === undefined) {
          return null;
        }
        const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
        const active = tile.id === activePaneId;
        const agent = paneAgent(pane);
        return (
          <section
            key={tile.id}
            className="tile"
            data-pane-id={tile.id}
            data-active={active ? "true" : undefined}
            data-tone={toneOf(pane.agentStatus)}
            aria-current={active ? "true" : undefined}
            style={
              mode === "stack"
                ? { height: `${tile.height}%` }
                : {
                    left: `${tile.left}%`,
                    top: `${tile.top}%`,
                    width: `${tile.width}%`,
                    height: `${tile.height}%`,
                  }
            }
            // Clicking anywhere in a tile makes it the one being typed at, and
            // leaves the caret in the prompt. The browser moves focus to the
            // page on mousedown, so this runs afterwards and takes it back;
            // a click that finished a text selection is left alone.
            onClick={(event) => {
              onActivate(tile.id);
              // A control inside the pane keeps the keyboard: pressing Enter on
              // the layout buttons must not hand the caret away and strand them.
              const onControl =
                (event.target as HTMLElement).closest("button, input, a, select, [role='button']") !== null;
              if (
                !onControl &&
                keyboardIsPrimary() &&
                (window.getSelection()?.isCollapsed ?? true)
              ) {
                document.getElementById(PROMPT_ID)?.focus();
              }
            }}
          >
            <header
              className="tile__head"
              // A right-click on the header targets the pane's menu, like the tab.
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(pane, event.clientX, event.clientY);
              }}
            >
              {agent !== "" && <span className="tile__agent">{agent}</span>}
              <span className="tile__name" data-pane-title={tile.id}>
                {paneListName(pane, workspaceName)}
              </span>
              {paneOwnHasName(pane) && <span className="tile__id">{shortPaneId(tile.id)}</span>}
              <span className="tile__spacer" />
              <span className="tile__status">{toneOf(pane.agentStatus)}</span>
            </header>
            {active ? (
              <Scope
                key={tile.id}
                paneId={tile.id}
                theme={theme}
                display={display}
                onDisplay={onDisplay}
              />
            ) : (
              // Only the active tile reads its pane: a split would otherwise
              // pull every pane's transcript on every poll.
              <div className="scope scope--idle">
                <p className="scope__idle">click to read this pane</p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

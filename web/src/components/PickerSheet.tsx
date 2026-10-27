import { useState } from "react";
import type { AgentPane } from "@/lib/fleet";
import { orderByTone, paneAgent, paneListName, paneRowName, statusNote, toneOf } from "@/lib/fleet";
import type { HerdrWorkspace } from "@/lib/herdr";
import {
  READING_DEFAULT,
  READ_MEASURES,
  READ_SIZES,
  isDefaultReading,
  type ReadMeasure,
  type ReadSize,
  type Reading,
} from "@/lib/reading";

type Props = {
  open: boolean;
  workspaces: HerdrWorkspace[];
  panes: AgentPane[];
  selectedWorkspaceId: string | null;
  selectedPaneId: string | null;
  onWorkspace: (workspaceId: string) => void;
  onPane: (pane: AgentPane) => void;
  onNewWorkspace: () => void;
  onClose: () => void;
  reading: Reading;
  onReading: (next: Reading) => void;
};

type View = "agents" | "spaces" | "text";

/** The order the tabs are read in: navigate, then navigate, then the one knob. */
const VIEWS: View[] = ["agents", "spaces", "text"];

/**
 * What each tab reads as. The ids keep the "text" suffix ("herdr-sheet-view-text",
 * "herdr-sheet-panel-text") because they are the stable hook for the grid rule
 * and the browser suites; only the word a user sees is "reading", which is what
 * the tab actually holds.
 */
const VIEW_LABEL: Record<View, string> = {
  agents: "agents",
  spaces: "spaces",
  text: "reading",
};

/**
 * The phone's whole navigation, because both sidebar halves are hidden there.
 * It carries the same two lists and a switch between them, so the current
 * workspace and the running agents are each one tap away instead of stacked
 * into a scroll that never fits.
 *
 * The third view is not a list: it is where the one preference a phone needs
 * for this console lives. Both alternatives were worse — a control in the
 * stage head is hidden the moment the keyboard comes up (index.css keeps only
 * the lens switch there), and a button in the transcript competes with the
 * answer. A tab in the sheet is one thumb-reachable tap from anywhere, and the
 * sheet is already the phone's settings surface.
 */
export function PickerSheet({
  open,
  workspaces,
  panes,
  selectedWorkspaceId,
  selectedPaneId,
  onWorkspace,
  onPane,
  onNewWorkspace,
  onClose,
  reading,
  onReading,
}: Props) {
  const [view, setView] = useState<View>("agents");
  const [query, setQuery] = useState("");
  if (!open) {
    return null;
  }

  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const current = names.get(selectedWorkspaceId ?? "") ?? "none";
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  // Only panes with an agent: a plain shell is not something to watch here.
  const running = panes.filter((pane) => paneAgent(pane) !== "");
  const agents = orderByTone(running, (pane) => toneOf(pane.agentStatus)).filter((pane) => {
    if (terms.length === 0) {
      return true;
    }
    const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
    const haystack = [workspaceName, pane.id, paneAgent(pane), paneListName(pane, workspaceName)]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Navigate">
      <div className="sheet__head">
        <span className="sheet__title" id="herdr-sheet-title">
          {current}
        </span>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="sheet__views" role="tablist" aria-label="View">
        {VIEWS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`herdr-sheet-view-${item}`}
            className="sheet__view"
            aria-selected={view === item}
            aria-controls={item === "text" ? "herdr-sheet-panel-text" : "herdr-sheet-panel-list"}
            onClick={() => setView(item)}
          >
            {VIEW_LABEL[item]}
            {/* The counters belong to the two lists; "text" is a panel. */}
            {item !== "text" && (
              <span className="sheet__view-count">
                {item === "agents" ? running.length : workspaces.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {view === "agents" && (
        <div className="col__filter">
          <input
            id="herdr-sheet-filter"
            className="col__input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="filter agents…"
            aria-label="Filter agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
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
      )}

      {view === "text" ? (
        <ReadingPanel reading={reading} onReading={onReading} />
      ) : (
        <div
          className="sheet__body"
          role="tabpanel"
          id="herdr-sheet-panel-list"
          aria-labelledby={`herdr-sheet-view-${view}`}
        >
          <div className="col__list">
            {view === "spaces" &&
              workspaces.map((workspace) => {
                const count = panes.filter((pane) => pane.workspaceId === workspace.id).length;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="srow srow--space"
                    data-workspace-id={workspace.id}
                    aria-current={workspace.id === selectedWorkspaceId ? "true" : undefined}
                    onClick={() => {
                      onWorkspace(workspace.id);
                      // Back to the agents: picking a space is always in order
                      // to look at what is running in it.
                      setView("agents");
                    }}
                  >
                    <span className="srow__name" title={workspace.name}>
                      {workspace.name}
                      <span className="row__id">
                        {count} {count === 1 ? "pane" : "panes"}
                      </span>
                    </span>
                  </button>
                );
              })}
            {/* This sheet is the whole sidebar on a phone, so the spaces list
                keeps the one action the desktop sidebar offers there. */}
            {view === "spaces" && (
              <button
                type="button"
                id="herdr-sheet-new-workspace"
                className="srow srow--space srow--new"
                onClick={onNewWorkspace}
              >
                <span className="srow__name">+ new workspace</span>
              </button>
            )}
            {view === "agents" &&
              agents.map((pane) => {
                const workspaceName = names.get(pane.workspaceId) ?? pane.workspaceId;
                const note = statusNote(pane.agentStatus);
                return (
                  <button
                    key={pane.id}
                    type="button"
                    className="srow"
                    data-pane-id={pane.id}
                    data-tone={toneOf(pane.agentStatus)}
                    aria-current={pane.id === selectedPaneId ? "true" : undefined}
                    title={`${paneRowName(pane, workspaceName)} — ${pane.id} (${workspaceName})${
                      note === undefined ? "" : ` · ${note}`
                    }`}
                    onClick={() => onPane(pane)}
                  >
                    <span className="srow__agent" title={paneAgent(pane) || "shell"}>
                      {paneAgent(pane) || "shell"}
                    </span>
                    <span className="srow__name">
                      {paneRowName(pane, workspaceName)}
                      <span className="row__id">{workspaceName}</span>
                    </span>
                  </button>
                );
              })}
            {view === "spaces" && workspaces.length === 0 && (
              <p className="col__empty">No workspaces reported.</p>
            )}
            {view === "agents" && agents.length === 0 && (
              <p className="col__empty">No pane matches “{query}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type PanelProps = {
  reading: Reading;
  onReading: (next: Reading) => void;
};

/**
 * Two choices and the thing they change, in one screen: the sample is rendered
 * with the same custom properties the transcript uses, so what is under the
 * buttons is the answer rather than a picture of it.
 */
function ReadingPanel({ reading, onReading }: PanelProps) {
  const setSize = (size: ReadSize): void => onReading({ ...reading, size });
  const setMeasure = (measure: ReadMeasure): void => onReading({ ...reading, measure });

  return (
    <div
      className="read"
      role="tabpanel"
      id="herdr-sheet-panel-text"
      aria-labelledby="herdr-sheet-view-text"
    >
      <div className="read__row" role="group" aria-label="Text size">
        <span className="read__label">size</span>
        <span className="read__opts">
          {READ_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className="read__opt"
              data-read-size={size}
              aria-pressed={reading.size === size}
              onClick={() => setSize(size)}
            >
              {size}
            </button>
          ))}
        </span>
      </div>

      <div className="read__row" role="group" aria-label="Line length">
        <span className="read__label">measure</span>
        <span className="read__opts">
          {READ_MEASURES.map((measure) => (
            <button
              key={measure}
              type="button"
              className="read__opt"
              data-read-measure={measure}
              aria-pressed={reading.measure === measure}
              onClick={() => setMeasure(measure)}
            >
              {measure}
            </button>
          ))}
        </span>
      </div>

      {/* The sample is decorative for a screen reader and live for the eye:
          at "narrow" it is the narrower column, at "large" the larger type. */}
      <div className="read__sample" aria-hidden="true">
        <p>
          The agent edited two files and ran the suite: 381 passed, none skipped.
        </p>
        <pre className="read__code">$ npm run test:unit</pre>
      </div>

      <p className="read__hint">
        Applies to the transcript. The keys and the composer keep their own sizes, so typing stays
        clear of the keyboard&rsquo;s zoom.
      </p>

      <div className="read__foot">
        <span className="read__note">
          {isDefaultReading(reading) ? "measured defaults" : "your reading setup"}
        </span>
        <button
          type="button"
          className="read__reset"
          disabled={isDefaultReading(reading)}
          onClick={() => onReading(READING_DEFAULT)}
        >
          reset
        </button>
      </div>
    </div>
  );
}

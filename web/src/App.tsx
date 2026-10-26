import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaneTabs } from "@/components/PaneTabs";
import { PickerSheet } from "@/components/PickerSheet";
import { Sidebar } from "@/components/Sidebar";
import { FileViewer } from "@/components/FileViewer";
import { HerdrPanel } from "@/components/HerdrPanel";
import { DispatchSheet } from "@/components/DispatchSheet";
import { NewWorkspace } from "@/components/NewWorkspace";
import { TabStage } from "@/components/TabStage";
import { ArrangeSwitch } from "@/components/session/ArrangeSwitch";
import { LensSwitch } from "@/components/session/LensSwitch";
import { SessionStage } from "@/components/session/SessionStage";
import { Masthead } from "@/components/Masthead";
import { TargetMenu, type MenuTarget } from "@/components/TargetMenu";
import { PromptBar } from "@/components/PromptBar";
import {
  closePane,
  fetchAllPanes,
  fetchFleet,
  fetchLayout,
  fetchSelfRelease,
  hostHas,
  resizePane,
  createTab,
  splitPane,
  fetchStatus,
  fetchWorkspaces,
  sendPaneKeys,
  type Fleet,
  type HerdrPane,
  type HerdrStatus,
  type HerdrWorkspace,
} from "@/lib/herdr";
import { arrangeTiles, tabsOf, type ArrangeMode, type PaneLayout } from "@/lib/layout";
import {
  mostUrgentPane,
  paneAgent,
  statusLabel,
  toneOf,
  type AgentPane,
  type PageTheme,
} from "@/lib/fleet";
import { compactFrame } from "@/lib/frame";
import { readStoredLens, resolveLens, storeLens, type Lens } from "@/lib/lens";
import { readStoredPane, resolveStoredPane, storePane } from "@/lib/selection";
import { holdCreatedPane, type CreatedPane } from "@/lib/createdPane";
import type { ComposerAction } from "@/lib/composer";
import { longPressHandlers } from "@/lib/press";
import {
  applyTheme,
  readStoredChoice,
  readStoredDisplay,
  storeChoice,
  storeDisplay,
  type DisplayMode,
  type ThemeChoice,
} from "@/lib/theme";

/** One poll drives the whole fleet: status, workspaces and every pane. */
const FLEET_POLL_MS = 3000;

/**
 * How long a pane this console has just created is believed without herdr
 * listing it: three polls, enough for a daemon that is one listing behind.
 */
const CREATED_PANE_GRACE_MS = 3 * FLEET_POLL_MS;

/** The socket path without a trailing separator, which reads as a directory. */
function trimPath(path: string): string {
  return path.replace(/\/+$/, "");
}

function paneTarget(pane: HerdrPane | AgentPane, x: number, y: number): MenuTarget {
  return {
    kind: "pane",
    id: pane.id,
    x,
    y,
    // The rename field starts from the operator's own label, if there is one.
    name: pane.label ?? "",
    // The tile header clips this; the menu is where touch users see it whole.
    agent: paneAgent(pane),
  };
}

function workspaceTarget(workspace: HerdrWorkspace, x: number, y: number): MenuTarget {
  return { kind: "workspace", id: workspace.id, x, y, name: workspace.name };
}

/** localStorage can throw in private mode; the theme then just is not kept. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function App() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice(safeStorage()));
  // The resolved theme, so panes can mirror their colours to match it.
  const [theme, setTheme] = useState<PageTheme>("dark");
  const [display, setDisplay] = useState<DisplayMode>(() => readStoredDisplay(safeStorage()));
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([]);
  const [panes, setPanes] = useState<HerdrPane[]>([]);
  // Seeded from the last session: a reload should reopen the turn that was
  // being read, not jump to whichever pane happens to be most urgent.
  const [paneId, setPaneId] = useState<string | null>(() => readStoredPane(safeStorage()));
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [picker, setPicker] = useState(false);
  const [layout, setLayout] = useState<PaneLayout | null>(null);
  // A split tab on a laptop draws every pane at once, which is the point of a
  // split and also the reason to look at one pane at a time again. This only
  // changes what is drawn: herdr's layout, and its own zoom, are untouched.
  const [stageFocus, setStageFocus] = useState(false);
  // The path whose preview is open, if any.
  const [openPath, setOpenPath] = useState<string | null>(null);
  // True while herdr cannot be reached; the view keeps its last known state.
  const [offline, setOffline] = useState(false);
  const [hostPanel, setHostPanel] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [dispatch, setDispatch] = useState(false);
  const [fleetView, setFleetView] = useState<Fleet | null>(null);
  const [narrow, setNarrow] = useState(false);
  // Which register the session is being read in on a phone. Seeded per pane by
  // the effect below; a shell ignores it and keeps the terminal.
  // A restored pane paints before the fleet poll answers, so its stored lens is
  // read now: trusting the default would flash the terminal at a transcript.
  const [lens, setLens] = useState<Lens>(() => {
    const stored = readStoredPane(safeStorage());
    return (stored === null ? null : readStoredLens(safeStorage(), stored)) ?? "terminal";
  });
  // Panes whose working directory is not on this host: herdr can drive panes on
  // another machine over SSH, and a preview there cannot work from here.
  const [remotePanes, setRemotePanes] = useState<Set<string>>(() => new Set());
  // Selecting a pane in the rail also decides the workspace, so the pane list
  // has to know which workspace to show even before a pane is chosen.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // The console's own build, read once from the console rather than the daemon:
  // the masthead names this build even when herdr is down.
  const [selfVersion, setSelfVersion] = useState("");
  // The poll runs on an interval, so it reads the current workspace from a ref
  // rather than from a closure captured when the interval was created.
  const workspaceRef = useRef<string | null>(null);
  workspaceRef.current = workspaceId;
  // A pane this console has just made, kept in the view until herdr lists it.
  const createdPaneRef = useRef<CreatedPane | null>(null);

  // Keep <html data-theme> in step with the choice and the OS preference.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    setTheme(applyTheme(choice, query.matches));
    const onChange = (): void => {
      setTheme(applyTheme(choice, query.matches));
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  const chooseDisplay = useCallback((next: DisplayMode) => {
    setDisplay(next);
    storeDisplay(safeStorage(), next);
  }, []);

  const chooseTheme = useCallback((next: ThemeChoice) => {
    setChoice(next);
    storeChoice(safeStorage(), next);
  }, []);

  // Remember what is being read, so the next load reopens it.
  useEffect(() => {
    if (paneId !== null) {
      storePane(safeStorage(), paneId);
    }
  }, [paneId]);

  const loadFleet = useCallback(async (): Promise<void> => {
    {
      const [nextStatus, nextWorkspaces, nextPanes] = await Promise.all([
        fetchStatus(),
        fetchWorkspaces().catch(() => null),
        fetchAllPanes().catch(() => null),
      ]);
      // herdr restarting is not herdr empty. A failed poll keeps the last known
      // view, so the console does not go blank while the daemon comes back; the
      // offline strip says what is going on.
      setOffline(nextStatus === null || nextWorkspaces === null || nextPanes === null);
      setStatus(nextStatus);
      if (nextWorkspaces === null || nextPanes === null) {
        return;
      }
      setWorkspaces(nextWorkspaces);
      // A pane this console has just made can be missing from the daemon's own
      // listing for a poll, and "missing" is not "closed": holding it keeps the
      // view on the pane that was asked for instead of throwing it back to
      // whichever pane was open before.
      const held = holdCreatedPane(
        createdPaneRef.current,
        nextPanes,
        Date.now(),
        CREATED_PANE_GRACE_MS,
      );
      createdPaneRef.current = held.pending;
      setPanes(held.panes);
      setWorkspaceId((current) => {
        if (current !== null && nextWorkspaces.some((workspace) => workspace.id === current)) {
          return current;
        }
        const blocked = nextWorkspaces.find(
          (workspace) => toneOf(workspace.agentStatus) === "blocked",
        );
        return blocked?.id ?? nextWorkspaces[0]?.id ?? null;
      });
      setPaneId((current) => {
        // The pane being read, or the one restored from the last session, stays
        // while herdr still reports it. A pane that was only just created counts
        // as reported: it is in `held.panes` from the moment it was asked for.
        const kept = resolveStoredPane(
          current,
          held.panes.map((pane) => pane.id),
        );
        if (kept !== null) {
          return kept;
        }
        // A pane that herdr has only just created is not in this poll yet.
        // Falling back across every workspace would throw the view somewhere
        // else, so the search stays inside the workspace being viewed.
        const here = held.panes.filter((pane) => pane.workspaceId === workspaceRef.current);
        return (mostUrgentPane(here) ?? mostUrgentPane(held.panes))?.id ?? null;
      });
    }
  }, []);

  useEffect(() => {
    void loadFleet();
    const timer = setInterval(() => void loadFleet(), FLEET_POLL_MS);
    return () => clearInterval(timer);
  }, [loadFleet]);

  // The console knows its own build without asking herdr, so the masthead still
  // says which build this is while the daemon is restarting.
  useEffect(() => {
    let cancelled = false;
    void fetchFleet().then((view) => {
      if (!cancelled) {
        setFleetView(view);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchSelfRelease().then((release) => {
      if (!cancelled && release !== null && release.version !== "") {
        setSelfVersion(release.version);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A restored pane can already be gone by the time the console opens, and
  // asking for the layout of a pane herdr does not know answers 502. Wait for
  // the fleet poll to confirm the pane before asking for anything about it.
  const paneKnown = paneId !== null && panes.some((pane) => pane.id === paneId);

  // A split can change while the page is open, so the layout is polled with the
  // fleet rather than fetched once per selection.
  useEffect(() => {
    if (!paneKnown) {
      setLayout(null);
      return;
    }
    let cancelled = false;
    async function loadLayout(): Promise<void> {
      const next = await fetchLayout(paneId as string);
      if (!cancelled && next !== null) {
        setLayout(next);
      }
    }
    void loadLayout();
    const timer = setInterval(() => void loadLayout(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paneId, paneKnown]);

  // Side by side needs width; below this the panes stack instead. A touch
  // screen gets the lens when its *short* side is phone-sized — a phone held
  // sideways (844x390, 932x430) was otherwise handed the desktop tab strip, the
  // AUTO/WRAP/EXACT/FIT bar and a ~130px terminal between them. Width alone
  // cannot say that: it folds a portrait tablet and then rebuilds the console
  // as the stage when the same tablet is turned. lib/frame.ts owns the rule and
  // the reasoning; the stylesheet's own folds at 900px wide / 500px tall on a
  // coarse pointer are shared with the desktop chrome and stay.
  useEffect(() => {
    const pointer = window.matchMedia("(pointer: coarse)");
    const apply = (): void =>
      setNarrow(compactFrame(window.innerWidth, window.innerHeight, pointer.matches));
    apply();
    // Width, height and pointer type change independently: a window dragged
    // narrow, a phone turned, a hybrid laptop losing its touchscreen.
    window.addEventListener("resize", apply);
    pointer.addEventListener("change", apply);
    return () => {
      window.removeEventListener("resize", apply);
      pointer.removeEventListener("change", apply);
    };
  }, []);

  const activePane = useMemo(
    () => panes.find((pane) => pane.id === paneId) ?? null,
    [panes, paneId],
  );
  const shownWorkspaceId = activePane?.workspaceId ?? workspaceId;
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === shownWorkspaceId) ?? null,
    [workspaces, shownWorkspaceId],
  );
  // Tabs, not panes: a tab can hold a split, and its panes become tiles.
  const tabs = useMemo(
    () => tabsOf(panes.filter((pane) => shownWorkspaceId === null || pane.workspaceId === shownWorkspaceId)),
    [panes, shownWorkspaceId],
  );
  const stageMode: ArrangeMode = narrow ? "stack" : stageFocus ? "focus" : "side";
  const tiles = useMemo(
    () => arrangeTiles(layout, stageMode, paneId),
    [layout, stageMode, paneId],
  );
  // Nothing to arrange when the tab is one pane, or when herdr already zoomed
  // it: the switch would be a second way to say the same thing.
  const arrangeable = !narrow && layout !== null && !layout.zoomed && layout.panes.length > 1;
  // A pane with an agent opens as a transcript, a plain shell opens as a
  // terminal — but herdr only names the agents it recognises, and an agent
  // launched through a wrapper, a `npm run` or a brand-new binary is reported as
  // a shell. On a phone that pane used to be locked into a 46-column xterm with
  // no way out, which is the one view that cannot be read there. So the agent
  // name now only decides the *default*: the switch is offered for every pane,
  // and `drawnLens` honours whatever the operator picked.
  const hasAgent = activePane !== null && paneAgent(activePane) !== "";
  const drawnLens: Lens = lens;

  // Seed the lens per pane. A stored choice is an instruction the operator gave
  // for this exact pane and beats the default; without one, a pane with an agent
  // opens as a transcript and a shell opens as a terminal.
  useEffect(() => {
    if (paneId === null) {
      return;
    }
    if (!paneKnown) {
      // Nothing is known about a restored pane yet; the default would be wrong.
      return;
    }
    setLens(resolveLens(readStoredLens(safeStorage(), paneId), hasAgent));
  }, [paneId, paneKnown, hasAgent]);

  const chooseLens = useCallback(
    (next: Lens) => {
      setLens(next);
      if (activePane !== null) {
        storeLens(safeStorage(), activePane.id, next);
      }
    },
    [activePane],
  );

  // The composer's app-level verbs. Anything it does not claim it let through
  // to the pane as text, which is how `/compact` and `/model` keep working.
  const handleComposerAction = useCallback(
    (action: ComposerAction) => {
      switch (action) {
        case "chat":
        case "terminal":
          chooseLens(action);
          break;
        case "files":
          if (activePane?.cwd !== undefined && activePane.cwd !== "") {
            setOpenPath(activePane.cwd);
          }
          break;
        case "workspace":
          setPicker(true);
          break;
        case "stop":
          if (activePane !== null) {
            void sendPaneKeys(activePane.id, ["Escape"]);
          }
          break;
        case "upload":
          // The composer owns its own file picker; there is nothing to route.
          break;
      }
    },
    [activePane, chooseLens],
  );
  const tilePanes = useMemo(() => {
    if (layout === null) {
      return activePane === null ? [] : [activePane];
    }
    return layout.panes
      .map((entry) => panes.find((pane) => pane.id === entry.id))
      .filter((pane) => pane !== undefined) as AgentPane[];
  }, [layout, panes, activePane]);

  // One probe per pane, not per poll: a pane's host does not change under it.
  const probeKey = tilePanes.map((pane) => `${pane.id}=${pane.cwd ?? ""}`).join("|");
  useEffect(() => {
    let cancelled = false;
    async function probe(): Promise<void> {
      const found = new Set<string>();
      for (const pane of tilePanes) {
        if (pane.cwd === undefined || pane.cwd === "") {
          continue;
        }
        if ((await hostHas(pane.cwd)) === false) {
          found.add(pane.id);
        }
      }
      if (!cancelled) {
        setRemotePanes(found);
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey]);

  const openPaneId = useCallback((id: string) => {
    setPaneId(id);
    setMenu(null);
    setPicker(false);
  }, []);

  /**
   * Take the console to a pane herdr has only just made.
   *
   * Making a tab answers with the pane's id, but the fleet poll answers from the
   * daemon's listing, which can still be a poll behind. Without this the pane is
   * dropped from the strip and the selection falls back to the pane that was
   * open before; with it the pane joins the view now and stays until herdr
   * reports it (`holdCreatedPane`).
   */
  const adoptCreatedPane = useCallback((pane: HerdrPane) => {
    createdPaneRef.current = { pane, at: Date.now() };
    setPanes((current) => (current.some((row) => row.id === pane.id) ? current : [...current, pane]));
    setPaneId(pane.id);
  }, []);

  const newTab = useCallback(async (): Promise<void> => {
    const workspace = shownWorkspaceId ?? workspaceRef.current ?? null;
    if (workspace === null) {
      return;
    }
    const created = await createTab(workspace);
    if (created === null) {
      return;
    }
    // herdr reports the new tab on the next poll, and the strip is built from the
    // pane list, so the pane joins it at once instead of the strip staying short
    // for a second.
    adoptCreatedPane({
      id: created.paneId,
      workspaceId: created.workspaceId || workspace,
      tabId: created.tabId,
      focused: false,
      agentStatus: "unknown",
      cwd: "",
    });
    const layoutOfNew = await fetchLayout(created.paneId);
    if (layoutOfNew !== null) {
      setLayout(layoutOfNew);
    }
  }, [shownWorkspaceId, adoptCreatedPane]);

  const closeActivePane = useCallback(async (target: string): Promise<void> => {
    if (!(await closePane(target))) {
      return;
    }
    setMenu(null);
    // Drop it at once: waiting for the poll would leave a tile for a pane that
    // is already gone, and the next poll would re-add nothing.
    setPanes((current) => current.filter((pane) => pane.id !== target));
    await loadFleet();
  }, [loadFleet]);

  const openWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    // Open the workspace's most urgent pane so the transcript is never blank.
    const next = mostUrgentPane(panes.filter((pane) => pane.workspaceId === id));
    setPaneId(next?.id ?? null);
    setMenu(null);
  }, [panes]);

  const paneTone = activePane ? toneOf(activePane.agentStatus) : null;

  return (
    <div className={narrow ? "shell is-narrow" : "shell"}>
      <Masthead
        onHost={() => setHostPanel(true)}
        onFleet={() => setDispatch(true)}
        status={status}
        consoleVersion={selfVersion !== "" ? selfVersion : status?.consoleVersion ?? ""}
        choice={choice}
        onChoice={chooseTheme}
        narrow={narrow}
      />

      <div className="body">
        <Sidebar
          workspaces={workspaces}
          panes={panes}
          selectedWorkspaceId={shownWorkspaceId}
          selectedPaneId={paneId}
          onWorkspace={openWorkspace}
          onPane={(pane) => openPaneId(pane.id)}
          onWorkspaceMenu={(workspace, x, y) => setMenu(workspaceTarget(workspace, x, y))}
          onPaneMenu={(pane, x, y) => setMenu(paneTarget(pane, x, y))}
          onNewWorkspace={() => setNewWorkspace(true)}
        />

        <main className={narrow && activePane !== null ? "stage stage--lens" : "stage"}>
          {offline && (
            <div className="offline" role="status">
              <span className="signal" data-tone="blocked" aria-hidden />
              herdr is not reachable — showing the last known state, and this clears itself
              when the daemon is back
              <button
                type="button"
                className="offline__action"
                onClick={() => setHostPanel(true)}
              >
                herdr status
              </button>
            </div>
          )}
          {/* Identity lives in the tab strip directly below; this line answers
              "where am I and what state", so it does not repeat the pane name. */}
          <div className="stage__head">
            <h1 className="stage__title">
              {activeWorkspace !== null ? (
                <span
                  className="stage__workspace"
                  data-workspace-id={activeWorkspace.id}
                  title={`${activeWorkspace.name} — ${activeWorkspace.id}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu(workspaceTarget(activeWorkspace, event.clientX, event.clientY));
                  }}
                  {...longPressHandlers({
                    onLongPress: (x, y) => setMenu(workspaceTarget(activeWorkspace, x, y)),
                  })}
                >
                  {activeWorkspace.name}
                </span>
              ) : (
                <span className="dim">no workspace</span>
              )}
            </h1>
            <button
              type="button"
              id="herdr-picker-open"
              className="stage__pick"
              aria-expanded={picker}
              onClick={() => setPicker(true)}
            >
              {activeWorkspace?.name ?? "workspaces"}
            </button>
            <div className="stage__spacer" />
            {arrangeable && (
              <ArrangeSwitch focus={stageFocus} onChange={setStageFocus} />
            )}
            {narrow && activePane !== null && (
              // Words, not glyphs: at 320px two icons would be guesswork, and
              // the head is already 46px tall so this costs no height. Offered
              // for every pane: herdr cannot name every agent, and the document
              // view is the only readable one at this width.
              <LensSwitch lens={drawnLens} onLens={chooseLens} />
            )}
            {activePane !== null && remotePanes.has(activePane.id) && (
              // The working directory above belongs to another machine, so the
              // paths this pane prints are not readable from here.
              <span className="stage__remote" title="this pane runs on another host">
                remote
              </span>
            )}
            {activePane?.cwd !== undefined && activePane.cwd !== "" && (
              <span className="stage__cwd" title={activePane.cwd}>
                {activePane.cwd}
              </span>
            )}
            {paneTone !== null && (
              <span className="stage__status" title={activePane?.agentStatus ?? undefined}>
                <span className="signal" data-tone={paneTone} aria-hidden />
                <span className="stage__status-word">{statusLabel(activePane?.agentStatus)}</span>
              </span>
            )}
          </div>

          <PaneTabs
            panes={tabs.map((tab) => tab.pane)}
            workspaceName={activeWorkspace?.name ?? ""}
            activeTabId={activePane?.tabId ?? null}
            onSelect={openPaneId}
            onNewTab={() => void newTab()}
            canSplit={paneId !== null}
            onMenu={(id, x, y) => {
              const pane = panes.find((candidate) => candidate.id === id);
              if (pane !== undefined) {
                setMenu(paneTarget(pane, x, y));
              }
            }}
          />

          {activePane !== null && narrow ? (
            <SessionStage
              paneId={activePane.id}
              status={activePane.agentStatus ?? null}
              lens={drawnLens}
              theme={theme}
              onLens={chooseLens}
            />
          ) : activePane !== null && tiles.length > 0 ? (
            <TabStage
              tiles={tiles}
              panes={tilePanes}
              workspaces={workspaces}
              activePaneId={paneId}
              mode={stageMode}
              theme={theme}
              display={display}
              onDisplay={chooseDisplay}
              onActivate={openPaneId}
              onMenu={(pane, x, y) => setMenu(paneTarget(pane, x, y))}
              onResize={(id, direction) => {
                // herdr decides where the edge lands, so the layout is re-read
                // rather than adjusted locally.
                void resizePane(id, direction).then(() => void fetchLayout(id).then(setLayout));
              }}
              remote={remotePanes}
              layout={layout}
              onOpenPath={setOpenPath}
              onClosePane={(id) => void closeActivePane(id)}
            />
          ) : (
            <div className="scope__idle">
              <strong>no pane selected</strong>
              <span>Pick an agent or shell from the fleet list to open its output.</span>
            </div>
          )}

          {activePane !== null && (
            <PromptBar
              key={`prompt-${activePane.id}`}
              paneId={activePane.id}
              panes={panes}
              onAction={handleComposerAction}
            />
          )}
        </main>
      </div>

      <footer className="statusline">
        <span>{workspaces.length} workspaces</span>
        <span className="cluster__sep" aria-hidden />
        <span>{panes.length} panes</span>
        <span className="cluster__sep" aria-hidden />
        <span>poll {Math.round(FLEET_POLL_MS / 1000)}s</span>
        <span className="statusline__spacer" />
        {/* The socket is named here and nowhere else: it is the same string in
            both places, and the footer has room for all of it. */}
        <span className="statusline__path" title={status?.socket ?? ""}>
          {status?.socket !== undefined && status.socket !== "" ? trimPath(status.socket) : "socket unknown"}
        </span>
      </footer>

      <PickerSheet
        open={picker}
        workspaces={workspaces}
        panes={panes}
        selectedWorkspaceId={shownWorkspaceId}
        selectedPaneId={paneId}
        onWorkspace={openWorkspace}
        onPane={(pane) => openPaneId(pane.id)}
        onNewWorkspace={() => {
          // The sheet is a navigation layer, not a place to stack dialogs: it
          // closes and hands over to the create dialog.
          setPicker(false);
          setNewWorkspace(true);
        }}
        onClose={() => setPicker(false)}
      />

      <FileViewer path={openPath} onClose={() => setOpenPath(null)} />

      <DispatchSheet open={dispatch} onClose={() => setDispatch(false)} fleet={fleetView} />
      <NewWorkspace
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        onCreated={(created) => {
          if (created !== "") {
            openWorkspace(created);
          }
          void loadFleet();
        }}
      />
      <HerdrPanel
        open={hostPanel}
        onClose={() => setHostPanel(false)}
        onDispatch={() => setDispatch(true)}
        consoleVersion={selfVersion !== "" ? selfVersion : status?.consoleVersion ?? ""}
      />

      <TargetMenu
        target={menu}
        activePaneId={paneId}
        onSelect={openPaneId}
        onClose={() => setMenu(null)}
        onRenamed={() => void loadFleet()}
        onSplit={(id, direction) => {
          setMenu(null);
          const source = panes.find((pane) => pane.id === id);
          void splitPane(id, direction).then(async (created) => {
            if (created === null) {
              return;
            }
            const layoutOfNew = await fetchLayout(created);
            // Same rule as a new tab: the pane belongs to the view the moment
            // the call answers, not the moment a listing happens to include it.
            adoptCreatedPane({
              id: created,
              workspaceId: source?.workspaceId ?? workspaceRef.current ?? "",
              tabId: layoutOfNew?.tabId ?? source?.tabId ?? "",
              focused: false,
              agentStatus: "unknown",
              cwd: "",
            });
            if (layoutOfNew !== null) {
              setLayout(layoutOfNew);
            }
          });
        }}
        onClosePane={(id) => void closeActivePane(id)}
      />
    </div>
  );
}

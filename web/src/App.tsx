import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaneTabs } from "@/components/PaneTabs";
import { PickerSheet } from "@/components/PickerSheet";
import { Sidebar } from "@/components/Sidebar";
import { FileViewer } from "@/components/FileViewer";
import { HerdrPanel } from "@/components/HerdrPanel";
import { DispatchSheet } from "@/components/DispatchSheet";
import { NewWorkspace } from "@/components/NewWorkspace";
import { TabStage } from "@/components/TabStage";
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
  type Fleet,
  type HerdrPane,
  type HerdrStatus,
  type HerdrWorkspace,
} from "@/lib/herdr";
import { arrangeTiles, tabsOf, type PaneLayout } from "@/lib/layout";
import {
  TONE_LABEL,
  mostUrgentPane,
  toneOf,
  type AgentPane,
  type PageTheme,
} from "@/lib/fleet";
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
  const [paneId, setPaneId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [picker, setPicker] = useState(false);
  const [layout, setLayout] = useState<PaneLayout | null>(null);
  // The path whose preview is open, if any.
  const [openPath, setOpenPath] = useState<string | null>(null);
  // True while herdr cannot be reached; the view keeps its last known state.
  const [offline, setOffline] = useState(false);
  const [hostPanel, setHostPanel] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [dispatch, setDispatch] = useState(false);
  const [fleetView, setFleetView] = useState<Fleet | null>(null);
  const [narrow, setNarrow] = useState(false);
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
      setPanes(nextPanes);
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
        if (current !== null && nextPanes.some((pane) => pane.id === current)) {
          return current;
        }
        // A pane that herdr has only just created is not in this poll yet.
        // Falling back across every workspace would throw the view somewhere
        // else, so the search stays inside the workspace being viewed.
        const here = nextPanes.filter((pane) => pane.workspaceId === workspaceRef.current);
        return (mostUrgentPane(here) ?? mostUrgentPane(nextPanes))?.id ?? null;
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

  // A split can change while the page is open, so the layout is polled with the
  // fleet rather than fetched once per selection.
  useEffect(() => {
    if (paneId === null) {
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
  }, [paneId]);

  // Side by side needs width; below this the panes stack instead.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const apply = (): void => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
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
  const tiles = useMemo(() => arrangeTiles(layout, narrow ? "stack" : "side"), [layout, narrow]);
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
    setPanes((current) =>
      current.some((pane) => pane.id === created.paneId)
        ? current
        : [
            ...current,
            {
              id: created.paneId,
              workspaceId: created.workspaceId || workspace,
              tabId: created.tabId,
              focused: false,
              agentStatus: "unknown",
              cwd: "",
            },
          ],
    );
    setPaneId(created.paneId);
    const layoutOfNew = await fetchLayout(created.paneId);
    if (layoutOfNew !== null) {
      setLayout(layoutOfNew);
    }
  }, [shownWorkspaceId]);

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
    <div className="shell">
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

        <main className="stage">
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
              <span className="stage__status">
                <span className="signal" data-tone={paneTone} aria-hidden />
                {TONE_LABEL[paneTone]}
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

          {activePane !== null && tiles.length > 0 ? (
            <TabStage
              tiles={tiles}
              panes={tilePanes}
              workspaces={workspaces}
              activePaneId={paneId}
              mode={narrow ? "stack" : "side"}
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
            <PromptBar key={`prompt-${activePane.id}`} paneId={activePane.id} />
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
            setPanes((current) =>
              current.some((pane) => pane.id === created)
                ? current
                : [
                    ...current,
                    {
                      id: created,
                      workspaceId: source?.workspaceId ?? workspaceRef.current ?? "",
                      tabId: layoutOfNew?.tabId ?? source?.tabId ?? "",
                      focused: false,
                      agentStatus: "unknown",
                      cwd: "",
                    },
                  ],
            );
            setPaneId(created);
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

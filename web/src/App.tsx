import { useCallback, useEffect, useMemo, useState } from "react";
import { Ledger } from "@/components/Ledger";
import { Masthead } from "@/components/Masthead";
import { PaneMenu, type MenuTarget } from "@/components/PaneMenu";
import { PaneStrip } from "@/components/PaneStrip";
import { PromptBar } from "@/components/PromptBar";
import { Scope } from "@/components/Scope";
import {
  fetchAllPanes,
  fetchStatus,
  fetchWorkspaces,
  type HerdrPane,
  type HerdrStatus,
  type HerdrWorkspace,
} from "@/lib/herdr";
import { TONE_LABEL, paneHasName, paneName, toneOf, type PageTheme } from "@/lib/fleet";
import { applyTheme, readStoredChoice, storeChoice, type ThemeChoice } from "@/lib/theme";

/** One poll drives the whole fleet: status, workspaces and every pane. */
const FLEET_POLL_MS = 3000;

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
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([]);
  const [panes, setPanes] = useState<HerdrPane[]>([]);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

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

  const chooseTheme = useCallback((next: ThemeChoice) => {
    setChoice(next);
    storeChoice(safeStorage(), next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [nextStatus, nextWorkspaces, nextPanes] = await Promise.all([
        fetchStatus(),
        fetchWorkspaces().catch(() => [] as HerdrWorkspace[]),
        fetchAllPanes().catch(() => [] as HerdrPane[]),
      ]);
      if (cancelled) {
        return;
      }
      setStatus(nextStatus);
      setWorkspaces(nextWorkspaces);
      setPanes(nextPanes);
      setPaneId((current) => {
        if (current !== null && nextPanes.some((pane) => pane.id === current)) {
          return current;
        }
        // Open on whatever most likely needs a human: blocked first, then
        // whatever herdr reports as focused.
        const blocked = nextPanes.find((pane) => toneOf(pane.agentStatus) === "blocked");
        if (blocked) {
          return blocked.id;
        }
        const focused = nextPanes.find((pane) => pane.focused);
        return focused?.id ?? nextPanes[0]?.id ?? null;
      });
    }
    void load();
    const timer = setInterval(() => void load(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const activePane = useMemo(
    () => panes.find((pane) => pane.id === paneId) ?? null,
    [panes, paneId],
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activePane?.workspaceId) ?? null,
    [workspaces, activePane],
  );
  // The strip stays scoped to the open pane's workspace so moving around one
  // workspace does not mean going back to the fleet list.
  const stripPanes = useMemo(
    () => (activePane === null ? [] : panes.filter((pane) => pane.workspaceId === activePane.workspaceId)),
    [panes, activePane],
  );

  const openPaneId = useCallback((id: string) => {
    setPaneId(id);
    setMenu(null);
  }, []);

  const paneTone = activePane ? toneOf(activePane.agentStatus) : null;

  return (
    <div className="shell">
      <Masthead status={status} choice={choice} onChoice={chooseTheme} />

      <div className="body">
        <Ledger
          panes={panes}
          workspaces={workspaces}
          selectedPaneId={paneId}
          onSelect={(pane) => openPaneId(pane.id)}
        />

        <main className="stage">
          <div className="stage__head">
            <h1 className="stage__title">
              <span className="dim">{activeWorkspace?.name ?? "no workspace"}</span>
              {activePane !== null && (
                <>
                  <span className="dim">/</span>
                  <span
                    className="stage__pane"
                    data-pane-title={activePane.id}
                    title={
                      paneHasName(activePane)
                        ? `${paneName(activePane)} — ${activePane.id}`
                        : activePane.id
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ paneId: activePane.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    {paneName(activePane)}
                  </span>
                  {paneHasName(activePane) && (
                    <span className="dim stage__pane-id">{activePane.id}</span>
                  )}
                </>
              )}
            </h1>
            <div className="stage__spacer" />
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

          <PaneStrip
            panes={stripPanes}
            activeId={paneId}
            onSelect={openPaneId}
            onMenu={(id, x, y) => setMenu({ paneId: id, x, y })}
          />

          {activePane !== null ? (
            <Scope key={activePane.id} paneId={activePane.id} theme={theme} />
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
        <span className="statusline__path" title={status?.socket ?? ""}>
          {status?.socket ?? "socket unknown"}
        </span>
      </footer>

      <PaneMenu
        target={menu}
        activePaneId={paneId}
        onSelect={openPaneId}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

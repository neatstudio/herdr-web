import { useCallback, useEffect, useMemo, useState } from "react";
import { Ledger } from "@/components/Ledger";
import { Masthead } from "@/components/Masthead";
import { PaneMenu, type MenuTarget } from "@/components/PaneMenu";
import { PaneStrip } from "@/components/PaneStrip";
import { PromptBar } from "@/components/PromptBar";
import { Scope } from "@/components/Scope";
import {
  fetchStatus,
  fetchWorkspaceDetail,
  fetchWorkspaces,
  type HerdrPane,
  type HerdrStatus,
  type HerdrWorkspace,
} from "@/lib/herdr";
import { TONE_LABEL, toneOf } from "@/lib/fleet";
import { applyTheme, readStoredChoice, storeChoice, type ThemeChoice } from "@/lib/theme";

const FLEET_POLL_MS = 4000;

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
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [panes, setPanes] = useState<HerdrPane[]>([]);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  // Keep <html data-theme> in step with the choice and the OS preference.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    applyTheme(choice, query.matches);
    const onChange = (): void => {
      applyTheme(choice, query.matches);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  const chooseTheme = useCallback((next: ThemeChoice) => {
    setChoice(next);
    storeChoice(safeStorage(), next);
  }, []);

  // Fleet poll: daemon status plus the workspace list.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [nextStatus, nextWorkspaces] = await Promise.all([
        fetchStatus(),
        fetchWorkspaces().catch(() => [] as HerdrWorkspace[]),
      ]);
      if (cancelled) {
        return;
      }
      setStatus(nextStatus);
      setWorkspaces(nextWorkspaces);
      setWorkspaceId((current) => {
        if (current !== null && nextWorkspaces.some((workspace) => workspace.id === current)) {
          return current;
        }
        // Open on whatever most likely needs a human.
        const blocked = nextWorkspaces.find(
          (workspace) => toneOf(workspace.agentStatus) === "blocked",
        );
        return blocked?.id ?? nextWorkspaces[0]?.id ?? null;
      });
    }
    void load();
    const timer = setInterval(() => void load(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // The pane list follows the selected workspace.
  useEffect(() => {
    if (workspaceId === null) {
      setPanes([]);
      setPaneId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await fetchWorkspaceDetail(workspaceId);
        if (cancelled) {
          return;
        }
        setPanes(detail.panes);
        setPaneId((current) => {
          if (current !== null && detail.panes.some((pane) => pane.id === current)) {
            return current;
          }
          return detail.panes.find((pane) => pane.focused)?.id ?? detail.panes[0]?.id ?? null;
        });
      } catch {
        if (!cancelled) {
          setPanes([]);
          setPaneId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const activePane = useMemo(
    () => panes.find((pane) => pane.id === paneId) ?? null,
    [panes, paneId],
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const openPane = useCallback((id: string) => {
    setPaneId(id);
    setMenu(null);
  }, []);

  const paneTone = activePane ? toneOf(activePane.agentStatus) : null;

  return (
    <div className="shell">
      <Masthead status={status} choice={choice} onChoice={chooseTheme} />

      <div className="body">
        <Ledger
          workspaces={workspaces}
          selectedId={workspaceId}
          onSelect={(id) => {
            // Re-selecting the open workspace must not clear its pane: the
            // pane-loading effect keys on workspaceId, so it would not run
            // again and the stage would sit empty.
            if (id === workspaceId) {
              return;
            }
            setWorkspaceId(id);
            setPaneId(null);
          }}
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
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ paneId: activePane.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    {activePane.id}
                  </span>
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
            panes={panes}
            activeId={paneId}
            onSelect={openPane}
            onMenu={(id, x, y) => setMenu({ paneId: id, x, y })}
          />

          {activePane !== null ? (
            <Scope key={activePane.id} paneId={activePane.id} />
          ) : (
            <div className="scope__idle">
              <strong>{workspaceId === null ? "no workspace selected" : "no panes here"}</strong>
              <span>
                {workspaceId === null
                  ? "Pick a workspace from the ledger to open its panes."
                  : "This workspace reports no panes."}
              </span>
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
        onSelect={openPane}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

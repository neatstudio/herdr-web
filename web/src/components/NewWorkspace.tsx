import { useEffect, useState } from "react";
import { createWorkspace, fetchTmuxSessions, type TmuxSession } from "@/lib/herdr";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called after a workspace was made, so the fleet can be re-read. */
  onCreated: (workspaceId: string) => void;
};

/**
 * Making a workspace, and taking over a tmux session that is already running.
 *
 * herdr has no tmux integration, so an existing tmux session is taken over the
 * way a terminal would: the new workspace's pane runs `tmux attach` and the
 * session appears inside it. That is the difference between a console that
 * replaces what was running and one that can pick it up.
 */
export function NewWorkspace({ open, onClose, onCreated }: Props) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [tmuxMissing, setTmuxMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setProblem("");
    void fetchTmuxSessions().then((result) => {
      if (cancelled || result === null) {
        return;
      }
      setSessions(result.sessions);
      setTmuxMissing(!result.available);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  async function create(command?: string[]): Promise<void> {
    setBusy(true);
    setProblem("");
    try {
      const made = await createWorkspace({
        label: label.trim() === "" ? undefined : label.trim(),
        cwd: cwd.trim() === "" ? undefined : cwd.trim(),
        command,
      });
      if (made === null) {
        setProblem("the workspace could not be created");
        return;
      }
      if (made.commandError !== undefined) {
        setProblem(`created, but the command did not start: ${made.commandError}`);
      }
      onCreated(made.workspaceId);
      setLabel("");
      setCwd("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-label="New workspace" aria-modal="true">
      <div className="sheet__head">
        <span className="sheet__title">new workspace</span>
        <button type="button" id="workspace-close" className="sheet__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="sheet__body">
        <label className="newws__field">
          <span>label</span>
          <input
            id="workspace-label"
            value={label}
            placeholder="optional"
            spellCheck={false}
            autoFocus
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
          />
        </label>
        <label className="newws__field">
          <span>directory</span>
          <input
            id="workspace-cwd"
            value={cwd}
            placeholder="optional — the shell's own directory is used"
            spellCheck={false}
            onChange={(event) => setCwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
          />
        </label>

        <button
          type="button"
          id="workspace-create"
          className="newws__submit"
          disabled={busy}
          onClick={() => void create()}
        >
          create
        </button>

        <div className="newws__tmux">
          <div className="newws__head">take over a tmux session</div>
          {tmuxMissing ? (
            <p className="newws__note">tmux is not installed here.</p>
          ) : sessions.length === 0 ? (
            <p className="newws__note">no tmux sessions are running.</p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.name}
                type="button"
                className="newws__session"
                data-session={session.name}
                disabled={busy}
                onClick={() => void create(["tmux", "attach", "-t", session.name])}
              >
                <span>{session.name}</span>
                <span className="newws__dim">
                  {session.windows} win{session.windows === 1 ? "" : "s"}
                  {session.attached > 0 ? " · attached" : ""}
                </span>
              </button>
            ))
          )}
        </div>

        {problem !== "" && (
          <p className="newws__note newws__note--bad" role="status">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}

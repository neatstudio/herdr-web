import { useEffect, useState } from "react";
import { createWorkspace } from "@/lib/herdr";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called after a workspace was made, so the fleet can be re-read. */
  onCreated: (workspaceId: string) => void;
};

/**
 * Making a workspace: a name, and where it starts.
 *
 * Nothing else belongs here. Sessions that happen to be running under another
 * multiplexer are a migration leftover, not a way to make a herdr workspace, and
 * they live in the host panel where legacy state belongs.
 */
export function NewWorkspace({ open, onClose, onCreated }: Props) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

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

  async function create(): Promise<void> {
    setBusy(true);
    setProblem("");
    try {
      const made = await createWorkspace({
        label: label.trim() === "" ? undefined : label.trim(),
        cwd: cwd.trim() === "" ? undefined : cwd.trim(),
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
    <div className="sheet sheet--dialog" role="dialog" aria-label="New workspace" aria-modal="true">
      <div className="sheet__panel">
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

        {problem !== "" && (
          <p className="newws__note newws__note--bad" role="status">
            {problem}
          </p>
        )}
      </div>
      </div>
    </div>
  );
}

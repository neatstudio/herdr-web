import { useEffect, useRef, useState } from "react";
import { renamePane, renameWorkspace } from "@/lib/herdr";

/**
 * What a menu acts on. Panes and workspaces share one menu because they share
 * the same two actions — rename and copy the id — and herdr draws the same
 * distinction for both.
 */
export type MenuTarget = {
  kind: "pane" | "workspace";
  id: string;
  x: number;
  y: number;
  /** The current name, so Rename starts from it; "" when there is none. */
  name?: string;
  /** The full agent slug, shown because the tile header has to clip it. */
  agent?: string;
};

type Props = {
  target: MenuTarget | null;
  activePaneId: string | null;
  onSelect: (paneId: string) => void;
  onClose: () => void;
  /** Called after a successful rename so the caller can refresh at once. */
  onRenamed?: () => void;
  /** Split the pane: how a new pane is made. */
  onSplit?: (paneId: string, direction: "right" | "down") => void;
  /** Close the pane and whatever is running in it. */
  onClosePane?: (paneId: string) => void;
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.select();
    document.body.append(area);
    document.execCommand("copy");
    area.remove();
  }
}

export function TargetMenu({
  target,
  activePaneId,
  onSelect,
  onClose,
  onRenamed,
  onSplit,
  onClosePane,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // A new target starts in menu mode, never mid-rename.
  useEffect(() => {
    setRenaming(false);
    setBusy(false);
    setDraft("");
  }, [target]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!target) {
      return;
    }
    function dismiss(event: MouseEvent): void {
      if (ref.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("click", dismiss);
    }, 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [target, onClose]);

  const kind = target?.kind ?? "pane";
  const id = target?.id ?? null;

  async function commit(label: string | null): Promise<void> {
    if (busy || id === null) {
      return;
    }
    setBusy(true);
    try {
      // A workspace has no unnamed state, so clearing is only offered for
      // panes and an empty workspace name is rejected before it is sent.
      const done =
        kind === "pane"
          ? await renamePane(id, label)
          : label !== null && (await renameWorkspace(id, label));
      if (done) {
        onRenamed?.();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  if (target === null) {
    return null;
  }

  const items: { label: string; hint: string; run: () => void }[] = [];
  if (kind === "pane" && target.id !== activePaneId) {
    items.push({ label: "Open pane", hint: "view", run: () => onSelect(target.id) });
  }
  items.push({
    label: kind === "pane" ? "Rename…" : "Rename workspace…",
    hint: target.name ?? "",
    run: () => {
      setDraft(target.name ?? "");
      setRenaming(true);
    },
  });
  if (kind === "pane" && target.name !== undefined && target.name !== "") {
    items.push({ label: "Clear name", hint: "pane id", run: () => void commit(null) });
  }
  if (kind === "pane" && onSplit !== undefined) {
    items.push(
      { label: "Split right", hint: "new pane", run: () => onSplit(target.id, "right") },
      { label: "Split down", hint: "new pane", run: () => onSplit(target.id, "down") },
    );
  }
  items.push({
    label: kind === "pane" ? "Copy pane id" : "Copy workspace id",
    hint: target.id,
    run: () => void copyText(target.id),
  });

  if (kind === "pane" && onClosePane !== undefined) {
    items.push({
      label: "Close pane",
      hint: "ends it",
      run: () => {
        // Closing ends the process in the pane, so it asks first.
        if (window.confirm(`Close ${target.id} and whatever is running in it?`)) {
          onClosePane(target.id);
        }
      },
    });
  }

  const width = renaming ? 300 : 240;
  const itemHeight = 34;
  const agentRow = !renaming && kind === "pane" && target.agent ? 34 : 0;
  const height = renaming ? 62 : items.length * itemHeight + 8 + agentRow;
  const left = Math.max(4, Math.min(target.x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(target.y, window.innerHeight - height - 4));

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={`${kind} ${target.id}`}
      style={{ left, top, minWidth: width }}
      onContextMenu={(event) => event.preventDefault()}
      // A click inside the menu must not reach the document listener that
      // dismisses it: by the time that listener runs, React may already have
      // replaced the clicked node, so a "contains" check cannot be trusted.
      onClick={(event) => event.stopPropagation()}
    >
      {!renaming && kind === "pane" && target.agent ? (
        <div className="menu__agent">
          <span>agent</span>
          <strong>{target.agent}</strong>
        </div>
      ) : null}
      {renaming ? (
        <form
          className="menu__rename"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(draft);
          }}
        >
          <input
            ref={inputRef}
            id="herdr-rename-input"
            className="menu__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={kind === "pane" ? "name this pane" : "name this workspace"}
            aria-label={kind === "pane" ? "Pane name" : "Workspace name"}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setRenaming(false);
              }
            }}
          />
          <button
            type="submit"
            className="menu__save"
            disabled={busy || (kind === "workspace" && draft.trim() === "")}
          >
            save
          </button>
        </form>
      ) : (
        items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => item.run()}
          >
            <span>{item.label}</span>
            <span>{item.hint}</span>
          </button>
        ))
      )}
    </div>
  );
}

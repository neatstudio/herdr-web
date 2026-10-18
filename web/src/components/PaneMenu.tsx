import { useEffect, useRef, useState } from "react";
import { renamePane } from "@/lib/herdr";

export type MenuTarget = { paneId: string; x: number; y: number; name?: string };

type Props = {
  target: MenuTarget | null;
  activePaneId: string | null;
  onSelect: (paneId: string) => void;
  onClose: () => void;
  /** Called after a successful rename so the caller can refresh. */
  onRenamed?: () => void;
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

/**
 * Pane actions. herdr can rename a pane, so the menu offers it; a right-click
 * is not available on a touch screen, which is why the title elements also
 * open this on a long press.
 */
export function PaneMenu({ target, activePaneId, onSelect, onClose, onRenamed }: Props) {
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
    // Dismiss on the next interaction anywhere outside the menu. Bubble phase,
    // so a click on an item is handled first.
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

  const paneId = target?.paneId ?? null;

  async function commit(label: string | null): Promise<void> {
    if (busy || paneId === null) {
      return;
    }
    setBusy(true);
    try {
      if (await renamePane(paneId, label)) {
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
  if (target.paneId !== activePaneId) {
    items.push({ label: "Open pane", hint: "view", run: () => onSelect(target.paneId) });
  }
  items.push({
    label: "Rename…",
    hint: target.name ?? "",
    run: () => {
      setDraft(target.name ?? "");
      setRenaming(true);
    },
  });
  if (target.name !== undefined && target.name !== "") {
    items.push({ label: "Clear name", hint: "pane id", run: () => void commit(null) });
  }
  items.push({
    label: "Copy pane id",
    hint: target.paneId,
    run: () => void copyText(target.paneId),
  });

  const width = renaming ? 280 : 230;
  const itemHeight = 34;
  const height = renaming ? 62 : items.length * itemHeight + 8;
  const left = Math.max(4, Math.min(target.x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(target.y, window.innerHeight - height - 4));

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={`Pane ${target.paneId}`}
      style={{ left, top, minWidth: width }}
      onContextMenu={(event) => event.preventDefault()}
      // A click inside the menu must not reach the document listener that
      // dismisses it: by the time that listener runs, React may already have
      // replaced the clicked node, so a "contains" check cannot be trusted.
      onClick={(event) => event.stopPropagation()}
    >
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
            placeholder="name this pane"
            aria-label="Pane name"
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
          <button type="submit" className="menu__save" disabled={busy}>
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
            onClick={() => {
              item.run();
            }}
          >
            <span>{item.label}</span>
            <span>{item.hint}</span>
          </button>
        ))
      )}
    </div>
  );
}

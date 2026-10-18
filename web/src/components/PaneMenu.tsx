import { useEffect, useRef } from "react";

export type MenuTarget = { paneId: string; x: number; y: number };

type Props = {
  target: MenuTarget | null;
  activePaneId: string | null;
  onSelect: (paneId: string) => void;
  onClose: () => void;
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Pane actions. There is no pane-kill or workspace-delete in the herdr API,
 * so the honest menu is: read its id, or make it the visible pane.
 */
export function PaneMenu({ target, activePaneId, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!target) {
      return;
    }
    // Dismiss on the next interaction anywhere outside the menu. Listener is
    // added on the bubble phase so a click on an item is handled first.
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

  if (!target) {
    return null;
  }

  const items: { label: string; hint: string; run: () => void }[] = [];
  if (target.paneId !== activePaneId) {
    items.push({
      label: "Open pane",
      hint: "view",
      run: () => onSelect(target.paneId),
    });
  }
  // The id is the one thing the transcript cannot show you, so the menu
  // offers exactly that and nothing it already displays.
  items.push({
    label: "Copy pane id",
    hint: target.paneId,
    run: () => void copyText(target.paneId),
  });

  const width = 220;
  const itemHeight = 34;
  const height = items.length * itemHeight + 8;
  const left = Math.max(4, Math.min(target.x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(target.y, window.innerHeight - height - 4));

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={`Pane ${target.paneId}`}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="menu__item"
          onClick={() => {
            item.run();
            onClose();
          }}
        >
          <span>{item.label}</span>
          <span>{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

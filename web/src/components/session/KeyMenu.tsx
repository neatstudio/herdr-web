import { useEffect, useRef, useState } from "react";

import { BAR_KEYS, KEY_MENU_KEYS, type KeyLatch } from "@/lib/keybar";

import { KeyBar } from "./KeyBar";

const PANEL_ID = "herdr-keymenu";

export type KeyMenuProps = {
  paneId: string;
  /** Armed modifiers, owned by the lens so typed input can spend them too. */
  latches: KeyLatch;
  onLatches: (next: KeyLatch) => void;
};

/**
 * The touch keyboard, in two layers.
 *
 * Six keys stay on screen because they are the ones a thumb reaches for while
 * a TUI is running (`BAR_KEYS`). The rest — the modifiers plus Backspace,
 * Home/End and the page keys a phone keyboard never has — sit behind the
 * `keys` button, in a grid that pushes the terminal up instead of covering it.
 *
 * Three rules decide the rest:
 *
 * 1. The menu holds several keystrokes by design — `ctrl` then `↓`, `esc` then
 *    `↑` — so tapping a key never closes it. It closes on the button, on
 *    `hide`, on Escape, or on a tap anywhere outside; a pane swap closes it.
 * 2. The panel is in flow, not an overlay: the xterm fit addon recalculates
 *    the viewport, so no keystroke is typed into text the menu hides.
 * 3. Latches live in the lens, not here, so a modifier armed from the grid is
 *    spent by the next key from the row, the grid, or the OS keyboard alike.
 */
export function KeyMenu({ paneId, latches, onLatches }: KeyMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // A pane swap starts from a clean keyboard: the menu must not cross it.
  useEffect(() => {
    setOpen(false);
  }, [paneId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    // Capture phase: a tap on the terminal must close the menu and still reach
    // xterm, so this only observes rather than intercepting anything.
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return (
    <div className="keymenu" ref={rootRef}>
      {open ? (
        <div className="keymenu__panel" id={PANEL_ID} role="group" aria-label="special keys">
          <div className="keymenu__head">
            <span className="keymenu__title">keys</span>
            <button
              type="button"
              className="keymenu__hide"
              aria-label="hide the keys menu"
              onPointerDown={(event) => {
                event.preventDefault();
                setOpen(false);
              }}
              onClick={(event) => {
                // Keyboard activation reports detail 0; a pointer tap was
                // already handled on pointerdown.
                if (event.detail === 0) {
                  setOpen(false);
                }
              }}
            >
              hide
            </button>
          </div>
          <KeyBar
            paneId={paneId}
            latches={latches}
            onLatches={onLatches}
            keys={KEY_MENU_KEYS}
            layout="grid"
          />
        </div>
      ) : null}
      <KeyBar
        paneId={paneId}
        latches={latches}
        onLatches={onLatches}
        keys={BAR_KEYS}
        moreOpen={open}
        moreControls={PANEL_ID}
        onMore={() => {
          setOpen((value) => !value);
        }}
      />
    </div>
  );
}

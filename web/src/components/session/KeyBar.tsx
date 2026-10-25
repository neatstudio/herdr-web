import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { sendPaneKeys } from "@/lib/herdr";
import {
  KEY_BAR_KEYS,
  clearLatches,
  createKeyRepeat,
  emptyLatches,
  isArmed,
  keyNameFor,
  latchesAfterPress,
  type KeyBarKey,
  type KeyLatch,
} from "@/lib/keybar";

export type KeyBarProps = {
  paneId: string;
  /** Armed modifiers, owned by the lens so typed input can spend them too. */
  latches: KeyLatch;
  onLatches: (next: KeyLatch) => void;
  /** Which keys to show; the chat lens shows only what a picker answers to. */
  keys?: readonly KeyBarKey[];
  /**
   * `row` scrolls sideways under an edge fade; `grid` wraps into rows and is
   * what the keys menu uses. The grid is only ever shown on touch widths.
   */
  layout?: "row" | "grid";
  /** Fires after a press has been handled, so a menu can react to it. */
  onPress?: (key: KeyBarKey) => void;
  /** Adds a trailing button that opens the keys menu. */
  onMore?: () => void;
  /** Whether that button reads as open. */
  moreOpen?: boolean;
  /** Id of the panel that button controls, for assistive tech. */
  moreControls?: string;
};

/**
 * The touch keyboard for a pane.
 *
 * Three rules decide everything here:
 *
 * 1. A press sends immediately on `pointerdown`, through `sendPaneKeys` — the
 *    same client the rest of the console uses. Nothing is written into xterm
 *    locally: the daemon echoes the key on the next `pane.read` snapshot, and a
 *    local echo would show the key twice.
 * 2. The three modifier buttons latch instead of sending. A latch is spent by
 *    the next key from anywhere — a key-bar tap, or a character typed into the
 *    terminal — so `ctrl` + `up` is one keystroke, not a mode. The state lives
 *    in the lens for exactly that reason.
 * 3. Only the keys a TUI expects to autorepeat (Tab, Backspace and the arrows)
 *    repeat, and they repeat the *resolved* name from the first press, so
 *    `ctrl` + `→` held down keeps arriving as `ctrl+right` after the latch is
 *    spent.
 */
export function KeyBar({
  paneId,
  latches,
  onLatches,
  keys = KEY_BAR_KEYS,
  layout = "row",
  onPress,
  onMore,
  moreOpen = false,
  moreControls,
}: KeyBarProps) {
  // The press handler reads the latches synchronously; a re-render would only
  // be visible one tap too late for a thumb.
  const latchesRef = useRef<KeyLatch>(latches);
  const repeatRef = useRef<ReturnType<typeof createKeyRepeat> | null>(null);
  const repeatName = useRef<string | null>(null);

  useEffect(() => {
    latchesRef.current = latches;
  }, [latches]);

  const commitLatches = (next: KeyLatch): void => {
    latchesRef.current = next;
    onLatches(next);
  };

  const stopRepeat = (): void => {
    repeatName.current = null;
    repeatRef.current?.stop();
  };

  useEffect(() => {
    const repeat = createKeyRepeat(() => {
      const name = repeatName.current;
      if (name !== null) {
        void sendPaneKeys(paneId, [name]);
      }
    });
    repeatRef.current = repeat;
    return () => {
      repeat.stop();
      repeatRef.current = null;
      repeatName.current = null;
    };
  }, [paneId]);

  // A pane swap starts from a clean keyboard: a latched Ctrl must not cross it.
  useEffect(() => {
    commitLatches(emptyLatches());
    stopRepeat();
  }, [paneId]);

  const press = (key: KeyBarKey): void => {
    onPress?.(key);
    if (key.modifier !== undefined) {
      commitLatches(latchesAfterPress(latchesRef.current, key));
      return;
    }
    const name = keyNameFor(key, latchesRef.current);
    commitLatches(clearLatches());
    if (name === null) {
      return;
    }
    void sendPaneKeys(paneId, [name]);
    if (key.repeat) {
      repeatName.current = name;
      repeatRef.current?.start();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: KeyBarKey): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    // Keep the soft keyboard up: focusing the button would blur xterm's input
    // and dismiss the OS keyboard in the middle of an edit.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    press(key);
  };

  return (
    <div
      className={layout === "grid" ? "keys keys--grid" : "keys"}
      role="toolbar"
      aria-label="terminal keys"
    >
      {keys.map((key) => {
        const armed = isArmed(key, latches);
        return (
          <button
            key={key.id}
            type="button"
            className={armed ? "keys__key keys__key--armed" : "keys__key"}
            aria-label={key.ariaLabel}
            aria-pressed={key.modifier !== undefined ? armed : undefined}
            onPointerDown={(event) => onPointerDown(event, key)}
            onPointerUp={stopRepeat}
            onPointerCancel={stopRepeat}
            onLostPointerCapture={stopRepeat}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              // Keyboard activation reports detail 0; pointer clicks were
              // already handled on pointerdown and must not send twice.
              if (event.detail === 0) {
                press(key);
              }
            }}
          >
            {key.label}
          </button>
        );
      })}
      {onMore === undefined ? null : (
        <button
          type="button"
          className={moreOpen ? "keys__more keys__more--open" : "keys__more"}
          aria-label="more keys"
          aria-expanded={moreOpen}
          aria-controls={moreControls}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onMore();
          }}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.detail === 0) {
              onMore();
            }
          }}
        >
          <span aria-hidden="true">keys</span>
        </button>
      )}
    </div>
  );
}

/*
 * The touch key bar's vocabulary.
 *
 * A phone has no Escape, no arrows and no Tab, and an agent TUI needs all
 * three. This module owns what the bar shows and what each key turns into on
 * the wire; it never touches the DOM, so the mapping stays testable.
 *
 * Keys travel as names, not bytes: `terminalKeyName` is the single source of
 * truth for the protocol's spelling, and the bar only decides which modifiers
 * are latched. A latch is one-shot — it applies to the next key and is gone —
 * because a sticky Ctrl on a phone is a trap: the next tap would be a control
 * character the user did not ask for.
 */

import { terminalKeyName, type KeyStroke } from "./herdr.ts";

export type KeyModifier = "ctrl" | "alt" | "shift";

export type KeyLatch = Record<KeyModifier, boolean>;

export type KeyBarKey = {
  /** Stable identity: the React key and the CSS modifier suffix. */
  id: string;
  /** What the key shows. Monospace, so these are short on purpose. */
  label: string;
  /** Spoken name for screen readers; the glyphs alone say nothing. */
  ariaLabel: string;
  /** What the key sends. A modifier key never sends anything itself. */
  stroke: KeyStroke;
  /** Set on the three modifier keys, which latch instead of sending. */
  modifier?: KeyModifier;
  /** Whether holding the key repeats: only keys a TUI expects to autorepeat. */
  repeat: boolean;
};

/** How long a held key waits before it starts repeating. */
export const KEY_REPEAT_DELAY = 400;

/** How often a held key repeats after that. */
export const KEY_REPEAT_INTERVAL = 50;

/**
 * The whole keyboard, in the order the old single-row bar laid it out: leave a
 * TUI, Tab, the three modifiers, the four arrows, then the two keys that end an
 * interaction. `BAR_KEYS` is the part of it on screen; `KEY_MENU_KEYS` is all of
 * it plus the five keys a phone keyboard never had.
 */
export const KEY_BAR_KEYS: readonly KeyBarKey[] = [
  {
    id: "esc",
    label: "esc",
    ariaLabel: "Escape",
    stroke: { key: "Escape" },
    repeat: false,
  },
  {
    id: "tab",
    label: "tab",
    ariaLabel: "Tab",
    stroke: { key: "Tab" },
    repeat: true,
  },
  {
    id: "ctrl",
    label: "ctrl",
    ariaLabel: "Control",
    stroke: { key: "Control" },
    modifier: "ctrl",
    repeat: false,
  },
  {
    id: "alt",
    label: "alt",
    ariaLabel: "Alt",
    stroke: { key: "Alt" },
    modifier: "alt",
    repeat: false,
  },
  {
    id: "shift",
    label: "shift",
    ariaLabel: "Shift",
    stroke: { key: "Shift" },
    modifier: "shift",
    repeat: false,
  },
  {
    id: "up",
    label: "↑",
    ariaLabel: "Arrow up",
    stroke: { key: "ArrowUp" },
    repeat: true,
  },
  {
    id: "down",
    label: "↓",
    ariaLabel: "Arrow down",
    stroke: { key: "ArrowDown" },
    repeat: true,
  },
  {
    id: "left",
    label: "←",
    ariaLabel: "Arrow left",
    stroke: { key: "ArrowLeft" },
    repeat: true,
  },
  {
    id: "right",
    label: "→",
    ariaLabel: "Arrow right",
    stroke: { key: "ArrowRight" },
    repeat: true,
  },
  {
    id: "ctrl-c",
    label: "^C",
    ariaLabel: "Control C",
    stroke: { key: "c", ctrlKey: true },
    repeat: false,
  },
  {
    id: "enter",
    label: "↵",
    ariaLabel: "Enter",
    stroke: { key: "Enter" },
    repeat: false,
  },
];

/**
 * Keys the menu adds to the bar's vocabulary.
 *
 * A phone keyboard has no Backspace, no Home/End and no page keys, and an
 * editor or a pager needs all five. They were never part of the always-visible
 * row because they are not the keys a thumb reaches for mid-run; the menu is
 * exactly where a rare key belongs.
 */
const EXTRA_KEYS: readonly KeyBarKey[] = [
  {
    id: "backspace",
    label: "⌫",
    ariaLabel: "Backspace",
    stroke: { key: "Backspace" },
    repeat: true,
  },
  {
    id: "home",
    label: "home",
    ariaLabel: "Home",
    stroke: { key: "Home" },
    repeat: false,
  },
  {
    id: "end",
    label: "end",
    ariaLabel: "End",
    stroke: { key: "End" },
    repeat: false,
  },
  {
    id: "pageup",
    label: "PgUp",
    ariaLabel: "Page up",
    stroke: { key: "PageUp" },
    repeat: false,
  },
  {
    id: "pagedown",
    label: "PgDn",
    ariaLabel: "Page down",
    stroke: { key: "PageDown" },
    repeat: false,
  },
];

const ALL_KEYS: readonly KeyBarKey[] = [...KEY_BAR_KEYS, ...EXTRA_KEYS];

const KEY_BY_ID = new Map(ALL_KEYS.map((key) => [key.id, key]));

function pick(ids: readonly string[]): readonly KeyBarKey[] {
  return ids.map((id) => {
    const key = KEY_BY_ID.get(id);
    if (key === undefined) {
      throw new Error(`unknown key ${id}`);
    }
    return key;
  });
}

/**
 * The always-visible row, left to right: leave a TUI, Tab, Ctrl (every arrow
 * chord needs it), interrupt, the key that recalls the last prompt, confirm.
 *
 * Six 36px keys plus the menu button fit a 320px phone without scrolling,
 * which is why the rest of the vocabulary moved behind the button.
 */
export const BAR_KEYS: readonly KeyBarKey[] = pick([
  "esc",
  "tab",
  "ctrl",
  "ctrl-c",
  "up",
  "enter",
]);

/** How many keys the menu lays out per row; its CSS grid mirrors this. */
export const KEY_MENU_COLUMNS = 4;

/**
 * The menu's grid, four per row: fix the line, then the modifiers, then the
 * arrows, then navigation. Grouping beats frequency here: a key is found by
 * where it sits, and the four blocks are the four things one does to a TUI.
 */
export const KEY_MENU_KEYS: readonly KeyBarKey[] = pick([
  "esc",
  "tab",
  "backspace",
  "enter",
  "ctrl",
  "alt",
  "shift",
  "ctrl-c",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/**
 * The part of the bar a terminal picker needs: leave, the arrows, confirm.
 *
 * The terminal lens shows the whole keyboard because a TUI takes everything it
 * can get. The chat lens shows only this subset: a picker is the one thing
 * prose cannot express, and there is nothing to type with the rest of the bar
 * when the caret lives in the composer below it.
 */
export const PICKER_BAR_KEYS: readonly KeyBarKey[] = KEY_BAR_KEYS.filter((key) =>
  ["esc", "up", "down", "left", "right", "enter"].includes(key.id),
);

export function emptyLatches(): KeyLatch {
  return { ctrl: false, alt: false, shift: false };
}

export function toggleLatch(latches: KeyLatch, modifier: KeyModifier): KeyLatch {
  return { ...latches, [modifier]: !latches[modifier] };
}

export function clearLatches(): KeyLatch {
  return emptyLatches();
}

/** Whether a modifier key's button should read as latched (a filled button). */
export function isArmed(key: KeyBarKey, latches: KeyLatch): boolean {
  return key.modifier !== undefined && latches[key.modifier];
}

/**
 * The stroke a key sends with the current latches applied.
 *
 * A key with a modifier of its own (`^C` carries Ctrl) keeps it: latching
 * Ctrl and tapping `^C` still means Ctrl+C, never a bare "c".
 */
export function strokeFor(key: KeyBarKey, latches: KeyLatch): KeyStroke {
  if (key.modifier !== undefined) {
    return { ...key.stroke };
  }
  return {
    ...key.stroke,
    ctrlKey: key.stroke.ctrlKey === true || latches.ctrl,
    altKey: key.stroke.altKey === true || latches.alt,
    shiftKey: key.stroke.shiftKey === true || latches.shift,
  };
}

/** herdr's name for the key, or null for a modifier button (which sends none). */
export function keyNameFor(key: KeyBarKey, latches: KeyLatch): string | null {
  if (key.modifier !== undefined) {
    return null;
  }
  return terminalKeyName(strokeFor(key, latches));
}

/** The latches after this key is pressed: modifiers toggle, anything else spends them. */
export function latchesAfterPress(latches: KeyLatch, key: KeyBarKey): KeyLatch {
  if (key.modifier !== undefined) {
    return toggleLatch(latches, key.modifier);
  }
  return clearLatches();
}

export type KeyTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemTimers: KeyTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export type KeyRepeat = {
  /** Begin a press: the first repeat comes after the delay, never before. */
  start: () => void;
  /** End a press: no further ticks, and a pending first tick is cancelled. */
  stop: () => void;
  readonly active: boolean;
};

/**
 * Press-and-hold repeat for one key bar button.
 *
 * Timers are injected so the policy is testable without a wall clock: a test
 * that sleeps is a test that flakes. `start` resets a running repeat, so a
 * second pointerdown can never double the tick rate.
 */
export function createKeyRepeat(onTick: () => void, timers: KeyTimers = systemTimers): KeyRepeat {
  let first: unknown = null;
  let next: unknown = null;
  let active = false;

  const stop = (): void => {
    if (first !== null) {
      timers.clearTimeout(first);
      first = null;
    }
    if (next !== null) {
      timers.clearTimeout(next);
      next = null;
    }
    active = false;
  };

  const schedule = (): void => {
    next = timers.setTimeout(tick, KEY_REPEAT_INTERVAL);
  };

  const tick = (): void => {
    next = null;
    if (!active) {
      return;
    }
    onTick();
    if (active) {
      schedule();
    }
  };

  const start = (): void => {
    stop();
    active = true;
    first = timers.setTimeout(() => {
      first = null;
      if (!active) {
        return;
      }
      onTick();
      if (active) {
        schedule();
      }
    }, KEY_REPEAT_DELAY);
  };

  return {
    start,
    stop,
    get active() {
      return active;
    },
  };
}

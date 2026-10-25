/*
 * The physical keyboard a terminal picker needs while the chat lens is on
 * screen.
 *
 * The chat lens renders prose, not a terminal. When an agent stops to ask
 * "which one?" it draws a box the reader can see but cannot answer: nothing on
 * the page listens for arrows, so they move a caret in the composer or do
 * nothing at all. This module decides which key press belongs to the pane and
 * what herdr calls it. It never touches the DOM, so the mapping stays testable.
 *
 * The set is deliberately tiny — arrows, Enter, Escape — because everything
 * else keeps its normal meaning on the page: letters still type, Tab still
 * reaches the composer, and the page shortcuts still fire.
 */

import { terminalKeyName } from "./herdr.ts";

/** The keys a terminal menu answers to, and the only ones taken from the page. */
export const PICKER_EVENT_KEYS: readonly string[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
];

/** Only what this module needs from `document.activeElement`, so tests need no DOM. */
export type FocusLike = { tagName?: string; isContentEditable?: boolean } | null;

/** Only what this module needs from a keydown, so tests need no DOM. */
export type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

/** Whether the caret is somewhere a key press must be left alone. */
export function isTypingTarget(active: FocusLike): boolean {
  if (active === null) {
    return false;
  }
  if (active.isContentEditable === true) {
    return true;
  }
  const tag = (active.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Whether nothing on the page owns Enter: the body, or no focus at all.
 *
 * Enter is doubly spoken for — it confirms the picker, and it puts the caret
 * in the composer from anywhere on the page. The picker wins only when the
 * page itself has focus; a focused button or link keeps its own Enter.
 */
function focusIsNeutral(active: FocusLike): boolean {
  if (active === null) {
    return true;
  }
  if (active.isContentEditable === true) {
    return false;
  }
  const tag = (active.tagName ?? "").toUpperCase();
  return tag === "" || tag === "BODY";
}

/**
 * The herdr key name for a key press the picker should answer, or `null` when
 * the press belongs to the page.
 *
 * Modifiers disqualify a press outright: nothing in a picker is `ctrl`- or
 * `shift`-modified, so those presses stay with the browser and the composer.
 */
export function pickerKeyName(event: KeyLike, active: FocusLike): string | null {
  if (
    event.ctrlKey === true ||
    event.altKey === true ||
    event.metaKey === true ||
    event.shiftKey === true
  ) {
    return null;
  }
  if (isTypingTarget(active)) {
    return null;
  }
  if (!PICKER_EVENT_KEYS.includes(event.key)) {
    return null;
  }
  if (event.key === "Enter" && !focusIsNeutral(active)) {
    return null;
  }
  return terminalKeyName({ key: event.key });
}

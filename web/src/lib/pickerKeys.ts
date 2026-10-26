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

import { stripAnsi } from "./ansi.ts";
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

/*
 * The second opinion on whether a menu is waiting.
 *
 * herdr reports `blocked` for the agents it knows how to read. Everything else
 * — a third-party agent, a wrapper script, a TUI herdr has never heard of — can
 * sit with a menu drawn across the last lines of the pane and a status of
 * `working` or `unknown`. On a phone the transcript is then a document with a
 * question in it and no keyboard that answers it, so the menu has to be read
 * off the screen itself.
 *
 * The test is deliberately stingy: a numbered option row and a hint line that
 * names how to cancel or confirm, both near the bottom of the snapshot. Prose
 * that merely lists "1. … 2. …" is not a menu, and a menu the agent has already
 * answered has scrolled out of the tail.
 */

/** How far up the snapshot a menu may reach. */
const MENU_TAIL_LINES = 12;
/** The hint has to be nearer the bottom than this, or the menu is history. */
const HINT_TAIL_LINES = 6;

/** Box drawing, gutter and list-cursor characters a menu puts before a row. */
const MENU_LEAD = /^[\s│┃|╎:❯›>»]+/;

/** How many option rows a single line carries (`1.`, `1)`, `[1]`, `(1)`). */
function optionsOn(line: string): number {
  return (line.match(/(?:\[\d+\]|\(\d+\)|\d+[.)])\s+\S/g) ?? []).length;
}

const CONFIRM_HINTS = [
  /\besc(?:ape)?\b[^\n]{0,32}\b(?:cancel|exit|back|dismiss|close|quit)\b/i,
  /\b(?:tab|↑\/↓|up\/down|arrows?)\b[^\n]{0,24}\b(?:select|move|switch|amend|navigate|choose|change)\b/i,
  /\b(?:enter|return)\b[^\n]{0,24}\b(?:confirm|select|submit|choose|accept)\b/i,
];

/**
 * Whether the tail of a pane snapshot is a menu waiting for a key press.
 *
 * `text` is the raw ANSI snapshot `pane.read` returned; colour does not have to
 * be stripped by the caller.
 */
export function showsPicker(text: string): boolean {
  if (text === "") {
    return false;
  }
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => line.replace(MENU_LEAD, "").trimEnd())
    .filter((line) => line.trim() !== "");
  const menu = lines.slice(-MENU_TAIL_LINES);
  const options = menu.reduce((count, line) => count + optionsOn(line), 0);
  if (options < 2) {
    return false;
  }
  return lines
    .slice(-HINT_TAIL_LINES)
    .some((line) => CONFIRM_HINTS.some((hint) => hint.test(line)));
}

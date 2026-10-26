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

/** Box drawing and cursor characters trailing a label. */
const MENU_TRAIL = /[\s│┃|╎]+$/;

/** How many option rows a single line carries (`1.`, `1)`, `[1]`, `(1)`). */
function optionsOn(line: string): number {
  return (line.match(/(?:\[\d+\]|\(\d+\)|\d+[.)])\s+\S/g) ?? []).length;
}

const CONFIRM_HINTS = [
  /\besc(?:ape)?\b[^\n]{0,32}\b(?:cancel|exit|back|dismiss|close|quit)\b/i,
  /\b(?:tab|↑\/↓|up\/down|arrows?)\b[^\n]{0,24}\b(?:select|move|switch|amend|navigate|choose|change)\b/i,
  /\b(?:enter|return)\b[^\n]{0,24}\b(?:confirm|select|submit|choose|accept)\b/i,
];

/** One answer a menu offers: the digit the agent listens for and its label. */
export type PickerOption = { key: string; label: string };

/** A marker plus the space after it; the label runs to the next marker or EOL. */
const OPTION_MARK = /(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)])\s+/g;
/** Column-aligned inline menus separate their answers with a run of spaces. */
const COLUMN_GAP = /\s{2,}/;
/** Longest label a chip will draw; anything longer is a paragraph, not an answer. */
const LABEL_MAX = 26;
/** How much of a clipped label survives at each end. */
const LABEL_HEAD = 11;
const LABEL_TAIL = 14;

/**
 * The last lines of a snapshot, stripped and trimmed, when they look like a menu.
 *
 * `null` means "not a menu" — the same conservative verdict `showsPicker`
 * returns, shared so the two can never disagree.
 */
function menuTail(text: string): string[] | null {
  if (text === "") {
    return null;
  }
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => line.replace(MENU_LEAD, "").trimEnd())
    .filter((line) => line.trim() !== "");
  const options = lines
    .slice(-MENU_TAIL_LINES)
    .reduce((count, line) => count + optionsOn(line), 0);
  if (options < 2) {
    return null;
  }
  const hint = lines
    .slice(-HINT_TAIL_LINES)
    .some((line) => CONFIRM_HINTS.some((test) => test.test(line)));
  return hint ? lines : null;
}

/**
 * Whether the tail of a pane snapshot is a menu waiting for a key press.
 *
 * `text` is the raw ANSI snapshot `pane.read` returned; colour does not have to
 * be stripped by the caller.
 */
export function showsPicker(text: string): boolean {
  return menuTail(text) !== null;
}

/**
 * A label short enough to be a chip.
 *
 * Clipped in the middle, not at the end: the answers to a menu are often paths
 * or names that share a prefix, so the right edge is the part that tells them
 * apart. A label this long always contains an ellipsis rather than a prefix.
 */
function clipLabel(label: string): string {
  if (label.length <= LABEL_MAX) {
    return label;
  }
  return `${label.slice(0, LABEL_HEAD)}…${label.slice(-LABEL_TAIL)}`;
}

/**
 * The answers a menu offers, as digits a thumb can press.
 *
 * A menu drawn in a transcript is answerable with six keys and three taps; a
 * chip with the answer's own digit is one tap. Only menus that already passed
 * `showsPicker` are parsed, so a chip row can never appear where a bar would
 * not. Labels stop at the column gap an inline menu uses, and at
 * `LABEL_MAX` — a chip is an answer, not a line of prose.
 */
export function parsePickerOptions(text: string): PickerOption[] | null {
  const lines = menuTail(text);
  if (lines === null) {
    return null;
  }
  const options: PickerOption[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    // A marker only opens an answer at the start of a row or after the wide
    // gap a column-aligned row uses. A `2.` inside a sentence is text.
    const marks = [...line.matchAll(OPTION_MARK)].filter(
      (mark) => mark.index === 0 || /\s{2,}$/.test(line.slice(0, mark.index)),
    );
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      const key = mark[1] ?? mark[2] ?? mark[3];
      const start = (mark.index ?? 0) + mark[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index ?? line.length : line.length;
      const label = clipLabel(
        line.slice(start, end).split(COLUMN_GAP)[0].replace(MENU_TRAIL, "").trim(),
      );
      if (label === "" || seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push({ key, label });
    }
  }
  return options.length >= 2 ? options.slice(0, 9) : null;
}

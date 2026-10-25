/*
 * The pure half of the composer: query detection, completion, ranking and
 * per-pane drafts. No DOM, no wall clock, no network — the component owns the
 * textarea and the fetches, this module owns what the text means.
 *
 * Two sigils open a menu while the operator types:
 *   `/` at the start of a line runs an app-level action (or, when the app did
 *       not pass `onAction`, the text is simply sent as it always was);
 *   `@` inside a word mentions a pane, a workspace or a known path.
 * A match only ever changes the text when the operator accepts it; a query
 * with no match leaves the line untouched, because swallowing the operator's
 * text is worse than doing nothing.
 */

import { tailPath } from "./fleet.ts";
import { quotePath } from "./herdr.ts";

/** App-level actions the `/` palette can run. Pane commands are not here. */
export type ComposerAction =
  | "chat"
  | "terminal"
  | "files"
  | "upload"
  | "workspace"
  | "stop";

export type ComposerItem = {
  /** What the item inserts. An app action's value is also its palette key. */
  value: string;
  /** The readable name shown first in the row. */
  label: string;
  /** One word for the narrow left gutter: view, panel, pane, file… */
  kind: string;
  /** A short right-aligned note: the pane id, the path, what the action does. */
  hint?: string;
  /** Extra strings a query matches, e.g. the id behind a readable label. */
  keywords?: readonly string[];
  /** Set on app actions only; mention items insert text instead. */
  action?: ComposerAction;
};

/** The part of the text a sigil query covers, from sigil to token end. */
export type TokenMatch = {
  /** Index of the sigil. */
  start: number;
  /** Index just past the token the replacement should replace. */
  end: number;
  /** What the operator has typed after the sigil, up to the caret. */
  query: string;
};

/** One replacement of a token range with `value`. */
export type Completion = TokenMatch & { value: string };

/** The text and caret that result from accepting a completion. */
export type CompletionResult = { text: string; caret: number };

/** A place to keep drafts: `localStorage`, or a test double. */
export type DraftStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const clampCaret = (text: string, caret: number): number =>
  Math.max(0, Math.min(Math.round(caret), text.length));

const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

/** Pane, workspace and file rows for the `@` menu, in that order. */
export type MentionPane = {
  id: string;
  /** A readable name: the rename, the agent, the terminal title. */
  name?: string;
  agent?: string;
  cwd?: string;
};

export type MentionWorkspace = {
  id: string;
  name?: string;
};

export type MentionSources = {
  panes?: readonly MentionPane[];
  workspaces?: readonly MentionWorkspace[];
  /** Absolute paths already known to the composer (uploads, paths in the text). */
  files?: readonly string[];
};

/**
 * The draft key for one pane. Per pane, not per workspace: two panes in the
 * same workspace are two conversations.
 */
export function draftKey(paneId: string): string {
  return `herdr:draft:${paneId}`;
}

/**
 * The `/command` token under the caret, or null. Only a sigil that starts a
 * line (leading whitespace is fine) counts, and only while the caret is still
 * in the command word — once an argument is typed the menu is done.
 */
export function slashQuery(text: string, caret: number): TokenMatch | null {
  const at = clampCaret(text, caret);
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, at);
  const match = /^[ \t]*\/([^\s]*)$/.exec(before);
  if (match === null) return null;
  const start = lineStart + before.indexOf("/");
  let end = at;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return { start, end, query: match[1] };
}

/** Characters that may sit before a mention sigil without making it an address. */
const MENTION_OPENERS = " \t\n\r([{\"'`,;:=";

/**
 * The `@mention` token under the caret, or null. The sigil must open a word:
 * `foo@bar` is an address, not a mention, so the menu stays out of the way.
 */
export function mentionQuery(text: string, caret: number): TokenMatch | null {
  const at = clampCaret(text, caret);
  if (at === 0) return null;
  // Walk back to the start of the whitespace-delimited word holding the caret.
  let runStart = at;
  while (runStart > 0 && !isSpace(text[runStart - 1])) runStart -= 1;
  const sigil = text.lastIndexOf("@", at - 1);
  if (sigil < runStart) return null;
  if (sigil > 0 && !MENTION_OPENERS.includes(text[sigil - 1])) return null;
  let end = at;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return { start: sigil, end, query: text.slice(sigil + 1, at) };
}

/** Replace one token range, leaving the rest of the text and the caret sane. */
export function applyCompletion(
  text: string,
  caret: number,
  completion: Completion,
): CompletionResult {
  // The replaced range never starts after the caret: a completion replaces the
  // token the caret is in, and text beyond it is not the menu's to delete.
  const at = clampCaret(text, caret);
  const start = Math.max(0, Math.min(completion.start, at));
  const end = Math.max(start, Math.min(completion.end, text.length));
  const value = completion.value;
  const next = text.slice(0, start) + value + text.slice(end);
  const nextCaret = Math.min(start + value.length, next.length);
  return { text: next, caret: nextCaret };
}

/** Build the `@` menu rows. Order is the fallback ranking: panes, then workspaces, then files. */
export function mentionItems(sources: MentionSources): ComposerItem[] {
  const items: ComposerItem[] = [];
  for (const pane of sources.panes ?? []) {
    const label = (pane.name ?? "").trim();
    const keywords = [pane.id, pane.agent ?? "", pane.cwd ?? ""].filter((word) => word !== "");
    items.push({
      value: `@${pane.id}`,
      label: label === "" ? pane.id : label,
      kind: "pane",
      hint: pane.id,
      keywords,
    });
  }
  for (const workspace of sources.workspaces ?? []) {
    const label = (workspace.name ?? "").trim();
    items.push({
      value: `@${workspace.id}`,
      label: label === "" ? workspace.id : label,
      kind: "workspace",
      hint: workspace.id,
      keywords: workspace.name === undefined || workspace.name === label ? [] : [workspace.name],
    });
  }
  const seen = new Set<string>();
  for (const file of sources.files ?? []) {
    const path = file.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    items.push({ value: quotePath(path), label: tailPath(path), kind: "file", hint: path, keywords: [path] });
  }
  return items;
}

/* --------------------------------------------------------------- ranking */

/** True when `at` starts a word inside `hay` (`@tmp/x`, `src/composer.ts`). */
function isWordStart(hay: string, at: number): boolean {
  if (at === 0) return true;
  return " /._-:@([{".includes(hay[at - 1]);
}

function subsequenceScore(hay: string, needle: string): number {
  let cursor = -1;
  for (const char of needle) {
    cursor = hay.indexOf(char, cursor + 1);
    if (cursor === -1) return 0;
  }
  return 300 - Math.min(99, hay.length);
}

function scoreOne(needle: string, field: string): number {
  const hay = field.toLowerCase();
  if (hay === "" || needle === "") return 0;
  if (hay === needle) return 1000;
  if (hay.startsWith(needle)) return 900 - Math.min(99, hay.length - needle.length);
  const at = hay.indexOf(needle);
  if (at > 0) return (isWordStart(hay, at) ? 700 : 500) - Math.min(99, at);
  return subsequenceScore(hay, needle);
}

/**
 * Items matching `query`, best first, original order as the tiebreak. An empty
 * query returns everything in order; no match returns nothing, and the caller
 * then leaves the text alone.
 */
export function scoreMatches<T extends ComposerItem>(query: string, items: readonly T[]): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let score = 0;
    for (const field of [item.label, item.value, ...(item.keywords ?? [])]) {
      score = Math.max(score, scoreOne(needle, field));
      if (score === 1000) break;
    }
    if (score > 0) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

/* --------------------------------------------------------------- drafts */

/** The stored draft for a pane, or "" — storage failures keep the operator typing. */
export function readDraft(store: DraftStore | null, paneId: string): string {
  if (store === null) return "";
  try {
    return store.getItem(draftKey(paneId)) ?? "";
  } catch {
    return "";
  }
}

/** Keep the draft. Empty text removes the key instead of storing "". */
export function writeDraft(store: DraftStore | null, paneId: string, text: string): void {
  if (store === null) return;
  try {
    if (text === "") {
      store.removeItem(draftKey(paneId));
      return;
    }
    store.setItem(draftKey(paneId), text);
  } catch {
    // Private mode or a full quota: the draft is a convenience, not a contract.
  }
}

/** Drop the draft for a pane, after its line reached the pane. */
export function clearDraft(store: DraftStore | null, paneId: string): void {
  if (store === null) return;
  try {
    store.removeItem(draftKey(paneId));
  } catch {
    // Nothing to do: a stale draft is a smaller problem than a lost one.
  }
}

/* ----------------------------------------------------------- key handling */

/**
 * True when an Enter belongs to an IME and not to the draft.
 *
 * The first Enter commits a candidate: sending there posts half a word. WebKit
 * adds a second trap — the Enter that *ends* composition can arrive after
 * `compositionend`, flagged only by the legacy key code 229.
 */
export function imeEnter(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/* ------------------------------------------------------------- box sizing */

/** How many lines the composer may grow to before it scrolls instead. */
export const COMPOSER_MAX_ROWS = 8;

/**
 * The tallest the box may grow relative to the viewport. A composer that
 * swallows the transcript is worse than one that scrolls: on a phone with the
 * keyboard up the visual viewport is a third of the screen.
 */
export const COMPOSER_VIEWPORT_SHARE = 0.4;

/**
 * Rows the box shows before the operator has typed anything. A one-line slit
 * reads as a field and invites a one-line question; the work arriving in a
 * pane is rarely one line, and a phone has no room to grow the box *while*
 * typing. Two lines is the smallest box that looks like a draft.
 */
export const COMPOSER_MIN_ROWS = 2;

/** What one measurement of the textarea says about the box it needs. */
export type ComposerMetrics = {
  /** `scrollHeight` measured with the height left to the content; includes padding. */
  content: number;
  /** One line box (`line-height`), in px. */
  line: number;
  /** Vertical padding, in px. `scrollHeight` counts it, so the cap must too. */
  padding: number;
  /** Visual viewport height, in px; the on-screen keyboard shrinks it. */
  viewport: number;
  /** Rows before the box scrolls instead of growing. */
  maxRows: number;
  /** Rows the box keeps even when empty. Defaults to 1. */
  minRows?: number;
};

/** The height the box gets and whether the rest of the text scrolls. */
export type ComposerFit = { height: number; scrolls: boolean };

/**
 * Size the composer to its text: `minRows` lines when empty, eight lines at
 * most, then the box stops growing and the text scrolls instead.
 *
 * Two roundings matter more than they look.
 *
 * Upwards, never short: `scrollHeight` is an integer while `line-height` is not
 * (16px × 1.4 = 22.4px), so a box set to the measured height can still be a
 * fraction short, and a textarea one pixel short of its content grows a native
 * scrollbar over what looks like an empty box.
 *
 * Down to whole lines, at the cap: a box scrolled to the last line sits at
 * `content - height`, so unless that difference is a whole number of line boxes
 * the box stops mid-glyph — the half-line slice at the top of a long draft is
 * the same defect as the stray scrollbar, seen from the other end. `line` is
 * fractional and CSS accepts it, so the cap keeps the fraction instead of
 * rounding it away.
 */
export function fitComposer(metrics: ComposerMetrics): ComposerFit {
  const minRows = Math.max(1, Math.min(metrics.minRows ?? 1, metrics.maxRows));
  const floorRows = metrics.line * minRows + metrics.padding;
  const byRows = metrics.line * metrics.maxRows + metrics.padding;
  const byViewport = metrics.viewport * COMPOSER_VIEWPORT_SHARE;
  const room = Math.max(floorRows, Math.min(byRows, byViewport));
  // The floor is always allowed, even in a viewport too short for it: an empty
  // box that scrolls is a box the operator cannot read.
  const rows = Math.max(minRows, Math.floor((room - metrics.padding) / metrics.line + 1e-6));
  const cap = metrics.padding + rows * metrics.line;
  const wanted = Math.max(metrics.content, floorRows);
  const scrolls = wanted > cap + 0.5;
  // At the cap the height stays a whole number of lines: no half line at either
  // edge. Below it the box is its own content, rounded up. A viewport too short
  // to hold even two lines gets one whole line and scrolls the rest.
  const height = !scrolls ? Math.ceil(wanted) : rows > minRows ? cap : Math.ceil(floorRows);
  return { height, scrolls };
}

/* -------------------------------------------------------------- actions */

/**
 * The app actions the `/` palette offers, in the order they are shown when the
 * query is empty. Labels are the filter text an operator would think of.
 */
export const APP_ACTIONS: readonly ComposerItem[] = [
  { action: "chat", value: "/chat", label: "chat view", kind: "view", hint: "read this pane as a transcript" },
  { action: "terminal", value: "/terminal", label: "terminal view", kind: "view", hint: "the pane's own screen" },
  { action: "files", value: "/files", label: "files", kind: "panel", hint: "browse the host" },
  { action: "upload", value: "/upload", label: "upload a file", kind: "file", hint: "camera, library or file" },
  { action: "workspace", value: "/workspace", label: "workspace", kind: "fleet", hint: "switch workspace" },
  { action: "stop", value: "/stop", label: "stop", kind: "pane", hint: "interrupt what is running" },
];

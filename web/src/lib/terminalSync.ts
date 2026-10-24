/*
 * Snapshot sync for herdr's `pane.read`.
 *
 * A herdr pane has no byte stream. `pane.read` re-serialises the whole screen
 * as ANSI on every poll (~8 Hz), so writing the text into xterm would append
 * the entire screen over and over. This module turns each snapshot into the
 * smallest set of bytes that makes xterm show it, and remembers what it
 * believes xterm shows so the next poll can diff against that.
 *
 * The contract (§6) algorithm, implemented literally when the differ is used
 * without geometry:
 *
 *   1. split on `\n`, drop the `\r` endings and a trailing `\x1b[0m`;
 *   2. keep lines that are identical to what is already committed;
 *   3. for the changed tail: cursor up, then `\r ESC[2K <line>` per line;
 *   4. if the snapshot no longer starts with the committed head, append the
 *      whole snapshot after `\r\n` (a fresh frame) instead of rewriting rows
 *      that have scrolled above the viewport;
 *   5. an unchanged snapshot returns `""`;
 *   6. the trailing partial line (no `\n`) is written as bytes of its own.
 *
 * Two optional, backwards-compatible extras exist because a phone is not the
 * pane's own screen:
 *
 *   - `cols` reflows each snapshot line into rows no wider than `cols` visible
 *     cells before diffing. A 201-column pi screen rendered at 46 columns would
 *     otherwise soft-wrap inside xterm, and this differ's row arithmetic would
 *     be off by every wrapped row. With `cols === 0` (the default) no reflow
 *     happens and the line/row mapping is the contract's 1:1 one.
 *   - `rows` keeps only the last `rows` rows as addressable state. xterm's
 *     cursor cannot leave the screen — it cannot address rows that scrolled
 *     into the scrollback — so only a viewport-sized window may be rewritten.
 *     With `rows > 0`, a snapshot that scrolled is handled by appending the
 *     rows that entered from the bottom (real terminal scroll, history kept)
 *     and a repaint is handled in place. With `rows === 0` (the default) every
 *     row stays addressable and the contract's fresh-frame fallback applies.
 *
 * The class is DOM-free: it produces the bytes, the component writes them.
 */

const CSI = "\u001b[";
const ERASE_LINE = `${CSI}2K`;
const ERASE_BELOW = `${CSI}J`;
const RESET = `${CSI}0m`;

/** Every escape sequence a serialised screen can legitimately contain. */
const ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/y;
const SGR = /^\u001b\[([0-9;]*)m$/;

/** A tab advances to the next multiple of eight, as in a real terminal. */
const TAB = 8;

/**
 * A zero-width SGR is remembered so a row split in the middle of a styled span
 * can reopen the style it was cut in. Longer histories are dropped: a
 * serialised screen resets often enough that a handful of sequences is all a
 * span ever needs.
 */
const STYLE_MAX = 256;

/**
 * Reflowing a line is pure, and a poll changes one or two lines out of a
 * thousand, so the last screen's rows are worth keeping. The cache is bounded:
 * past this many distinct lines it is dropped wholesale, which costs one screen
 * of work and never grows with session history.
 */
const REFLOW_CACHE_LIMIT = 2048;

type Token = { raw: string; width: number };

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo init.
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, CJK symbols
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x1f000 && code <= 0x1f02f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

/**
 * Cells one code point occupies. The answer is allowed to be too large — that
 * wraps a row a little early — but never too small, which would let xterm wrap
 * on its own and break the row arithmetic.
 */
function charWidth(code: number): number {
  if (code < 0x20 || code === 0x7f) {
    return 0;
  }
  if (isCombining(code)) {
    return 0;
  }
  return isWide(code) ? 2 : 1;
}

/** Printable text between escapes, one token per code point, tabs expanded. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let used = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.codePointAt(i) ?? 0;
    if (code === 0x1b) {
      ESCAPE.lastIndex = i;
      const match = ESCAPE.exec(line);
      if (match === null) {
        i += 1; // A lone ESC cannot be rendered: drop it.
        continue;
      }
      const raw = match[0];
      if (SGR.test(raw)) {
        tokens.push({ raw, width: 0 });
      }
      // Every other escape is dropped on purpose. The snapshot is a screen,
      // not a stream: an `\x1b[2J` or an alt-screen switch would clear the
      // grid this differ is keeping in sync. Measured against a live pane, a
      // snapshot only ever carries SGR.
      i = ESCAPE.lastIndex;
      continue;
    }
    if (code === 0x09) {
      const width = TAB - (used % TAB);
      tokens.push({ raw: " ".repeat(width), width });
      used += width;
      i += 1;
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      i += 1; // Line endings are rows here; a bare CR is not content.
      continue;
    }
    const width = charWidth(code);
    if (width === 0) {
      i += 1;
      continue;
    }
    const raw = String.fromCodePoint(code);
    tokens.push({ raw, width });
    used += width;
    i += raw.length;
  }
  return tokens;
}

function nextStyle(style: string, sgr: string): string {
  const params = SGR.exec(sgr)?.[1] ?? "";
  const reset = params === "" || params.split(";").every((part) => part === "" || part === "0");
  if (reset) {
    return "";
  }
  const next = style + sgr;
  return next.length > STYLE_MAX ? next.slice(-STYLE_MAX) : next;
}

/** One line of snapshot text → one or more rows of at most `cols` cells. */
function reflow(line: string, cols: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  let style = "";
  for (const token of tokenize(line)) {
    if (token.width === 0) {
      if (token.raw.endsWith("m")) {
        style = nextStyle(style, token.raw);
      }
      row += token.raw;
      continue;
    }
    if (used > 0 && used + token.width > cols) {
      rows.push(`${row}${RESET}`);
      row = style;
      used = 0;
    }
    row += token.raw;
    used += token.width;
  }
  rows.push(`${row}${RESET}`);
  return rows;
}

/** Strip the padding every serialised line carries, and a redundant reset. */
function trimLine(line: string): string {
  let out = line.replace(/\r/g, "");
  for (;;) {
    const before = out;
    out = out.replace(/(?:\u001b\[0?m)+$/, "");
    out = out.replace(/[ \t]+$/, "");
    if (out === before) {
      return out;
    }
  }
}

function sameRows(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** `\r\n` + rows: bytes that append below the cursor without leaving it. */
function appendRows(rows: string[], from: number): string {
  let out = "";
  for (let i = from; i < rows.length; i += 1) {
    out += `\r\n${ERASE_LINE}${rows[i]}`;
  }
  return out;
}

export type TerminalSyncOptions = {
  /** Longest trailing partial line to keep, in characters. Default 4096. */
  maxRemainder?: number;
  /** Reflow each snapshot line to this many cells; 0 (default) keeps lines. */
  cols?: number;
  /** Rows addressable above the cursor; 0 (default) means no window. */
  rows?: number;
};

export type TerminalSyncState = {
  /** Rows the differ believes are on screen above the cursor, oldest first. */
  committed: string[];
  /** The row under the cursor, exactly as written, without a line ending. */
  remainder: string;
};

export class TerminalSync {
  private readonly maxRemainder: number;
  private cols: number;
  private limit: number;
  private committed: string[] = [];
  private remainder = "";
  private started = false;
  private lastText = "";
  private cache = new Map<string, string[]>();

  constructor(opts: TerminalSyncOptions = {}) {
    this.maxRemainder = Math.max(0, Math.floor(opts.maxRemainder ?? 4096));
    this.cols = Math.max(0, Math.floor(opts.cols ?? 0));
    this.limit = Math.max(0, Math.floor(opts.rows ?? 0));
  }

  /** Visible width the rows are wrapped to, 0 when lines are kept whole. */
  get columns(): number {
    return this.cols;
  }

  /** Addressable rows above the cursor, 0 when the window is unbounded. */
  get rowLimit(): number {
    return this.limit;
  }

  /**
   * The terminal changed size. A different width changes every row, so the
   * caller must clear the screen and push the current snapshot again; a
   * different height only changes how much history stays addressable.
   */
  setGeometry(cols: number, rows: number): void {
    const nextCols = Math.max(0, Math.floor(cols));
    const nextRows = Math.max(0, Math.floor(rows));
    const reflow = nextCols !== this.cols;
    this.cols = nextCols;
    this.limit = nextRows;
    if (reflow) {
      this.cache.clear();
      this.reset();
      return;
    }
    this.trimWindow();
  }

  reset(): void {
    this.committed = [];
    this.remainder = "";
    this.started = false;
    this.lastText = "";
  }

  state(): TerminalSyncState {
    return { committed: [...this.committed], remainder: this.remainder };
  }

  /** New snapshot → the exact bytes to write into xterm ("" when unchanged). */
  push(snapshot: string): string {
    if (typeof snapshot !== "string" || snapshot === "") {
      return "";
    }
    if (this.started && snapshot === this.lastText) {
      return ""; // The poll produced the same screen: nothing to write.
    }
    this.lastText = snapshot;
    const all = this.frame(snapshot);
    const next = this.limit > 0 && all.length > this.limit ? all.slice(all.length - this.limit) : all;
    if (!this.started) {
      this.started = true;
      this.setRows(next);
      // The first frame is the whole snapshot so the scrollback holds the
      // session history; only the window stays addressable afterwards.
      return all.join("\r\n");
    }
    const old = this.rows();
    if (sameRows(old, next)) {
      return "";
    }
    if (this.limit > 0 && old.length === next.length) {
      const shift = scrollShift(old, next);
      if (shift > 0) {
        this.setRows(next);
        return appendRows(next, next.length - shift);
      }
    }
    if (this.limit === 0 && !startsWith(old, next)) {
      // Contract §6.4: the head is gone, so nothing on screen may be edited.
      this.setRows(next);
      return `\r\n${next.map((row) => `${ERASE_LINE}${row}`).join("\r\n")}`;
    }
    this.setRows(next);
    return rewrite(old, next);
  }

  private rows(): string[] {
    return [...this.committed, this.remainder];
  }

  private setRows(rows: string[]): void {
    const window = this.limit > 0 && rows.length > this.limit ? rows.slice(rows.length - this.limit) : rows;
    this.committed = window.slice(0, Math.max(0, window.length - 1));
    this.remainder = window[window.length - 1] ?? "";
  }

  private trimWindow(): void {
    if (this.started) {
      this.setRows(this.rows());
    }
  }

  private frame(snapshot: string): string[] {
    const lines = snapshot.split("\n");
    const last = lines.pop() ?? "";
    const rows: string[] = [];
    for (const line of lines) {
      rows.push(...this.rowsOf(trimLine(line)));
    }
    rows.push(...this.rowsOf(trimLine(last)));
    const index = rows.length - 1;
    if (rows[index] !== undefined) {
      rows[index] = this.capTail(rows[index]);
    }
    return rows;
  }

  /** Keep the end of an over-long partial line, never starting inside an escape. */
  private capTail(row: string): string {
    if (this.maxRemainder === 0 || row.length <= this.maxRemainder) {
      return row;
    }
    let tail = row.slice(row.length - this.maxRemainder);
    if (tail.startsWith("\u001b")) {
      const end = tail.indexOf("m");
      tail = end === -1 ? tail : tail.slice(end + 1);
    }
    return tail;
  }

  private rowsOf(line: string): string[] {
    if (this.cols === 0) {
      return [line];
    }
    const cached = this.cache.get(line);
    if (cached !== undefined) {
      return cached;
    }
    const rows = reflow(line, this.cols);
    if (this.cache.size >= REFLOW_CACHE_LIMIT) {
      this.cache.clear();
    }
    this.cache.set(line, rows);
    return rows;
  }
}

/** Whether every old row is still the first row at its index in the new frame. */
function startsWith(old: string[], next: string[]): boolean {
  if (old.length > next.length) {
    return false;
  }
  for (let i = 0; i < old.length - 1; i += 1) {
    if (old[i] !== next[i]) {
      return false;
    }
  }
  return true;
}

/**
 * How many rows the content scrolled off the top, or 0.
 *
 * A window that scrolled by `k` rows shows the old window's rows `k..` at the
 * top and `k` rows of new content at the bottom, so the whole old suffix has
 * to match the new prefix before anything is appended.
 */
function scrollShift(old: string[], next: string[]): number {
  const length = old.length;
  for (let shift = 1; shift < length; shift += 1) {
    if (old[shift] !== next[0]) {
      continue;
    }
    let i = shift;
    let j = 0;
    while (i < length && old[i] === next[j]) {
      i += 1;
      j += 1;
    }
    if (i === length) {
      return shift;
    }
  }
  return 0;
}

/**
 * Bytes that rewrite the changed suffix of the window in place.
 *
 * The cursor sits on the last row; walk up to the first changed row, erase and
 * write every row from there down. `\x1b[J` drops rows that the new frame no
 * longer has, without moving the cursor off the last content row.
 */
function rewrite(old: string[], next: string[]): string {
  const a = old.length;
  const b = next.length;
  const shared = Math.min(a, b);
  let first = 0;
  while (first < shared && old[first] === next[first]) {
    first += 1;
  }
  if (first === b) {
    // The new frame is a prefix of what is on screen: keep the shared rows,
    // step back onto the last one and drop everything below it.
    const up = a - b;
    let out = up > 0 ? `${CSI}${up}A` : "";
    out += `\r${ERASE_LINE}${next[b - 1]}`;
    return `${out}${ERASE_BELOW}`;
  }
  let out = "";
  if (first < a) {
    const up = a - 1 - first;
    if (up > 0) {
      out += `${CSI}${up}A`;
    }
    out += "\r";
  } else {
    // Every row on screen is unchanged and the frame grew: write below it.
    out += "\r\n";
  }
  out += `${ERASE_LINE}${next[first]}`;
  for (let i = first + 1; i < b; i += 1) {
    out += `\r\n${ERASE_LINE}${next[i]}`;
  }
  if (b < a) {
    out += ERASE_BELOW;
  }
  return out;
}

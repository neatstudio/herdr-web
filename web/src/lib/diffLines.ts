/*
 * Diff boxes, as the terminals paint them.
 *
 * `pane.read` has no structured tool input, so an edit arrives as the ASCII
 * box the TUI drew: a `+--- ~ Edit: path [+6/-2] ---+` opener and then rows
 * like `|-185│ …` / `|+186│ …` / `| 181│ …`. `conversation.ts` already strips
 * the box gutters and borders, which leaves one detail line per source line
 * carrying its own sigil:
 *
 *     "181│      if err := …"     unchanged
 *     "-185│ → → s.ledger…"       removed
 *     "+186│ → → taskID := …"     added
 *     "  +│ → → s.ledger…"        added, no number of its own
 *     "…"                         a run of lines the TUI elided
 *
 * Painting every one of those in the same grey is the one place the chat lens
 * loses to the terminal it replaced: a six-line edit reads as a wall. So this
 * module classifies the lines (nothing is dropped) and the renderer colours
 * them, the way Ovis paints its own `chat-diff`.
 *
 * Two shapes are supported because two kinds of agent print them: the boxed
 * form above, and a plain unified diff (`@@` hunks, bare `+`/`-` lines). The
 * bare form is only trusted when the same run contains a box, because prose
 * contains dashes and a bulleted list is not a diff.
 *
 * DOM-free and clock-free, like the rest of `lib/`.
 */

/** What one detail line means. */
export type DiffLineKind = "add" | "del" | "context" | "gap" | "hunk" | "plain";

/** One classified line: the placeholder text is kept exactly as printed. */
export type DiffLine = {
  kind: DiffLineKind;
  /** The source line number the TUI printed, when it printed one. */
  number: string | null;
  text: string;
};

/** How many lines each side of the diff gained. */
export type DiffStat = { add: number; del: number };

/** A boxed row: `-185│ body`, `+186│ body`, `  +│ body`. */
const BOXED = /^ {0,3}([+\- ])(\d{0,6})│ ?(.*)$/;

/** A boxed row with no sigil at all: the number starts the line. */
const NUMBERED = /^ {0,3}(\d{1,6})│ ?(.*)$/;

/** A row the TUI drew as `12 -  old line`: number, sigil, gutter of spaces. */
const NUMBER_SIGIL = /^ {0,3}(\d{1,6}) ([+\-]) {1,3}(.*)$/;

/** A hunk head, boxed or plain. */
const HUNK = /^\s*(?:[|]\s*)?@@/;

/** The TUI's own elision marker. */
const GAP = /^(?:…|\.\.\.)$/;

/** A row whose arrow glyphs stand for the tabs the terminal drew. */
function untab(body: string): string {
  return body.replace(/\u2192/g, "\t").replace(/\t +/g, "\t");
}

/**
 * Classify one detail line.
 *
 * `boxed` says the run contains at least one `│` row, which is what makes a
 * bare `+`/`-` trustworthy as a diff sigil instead of prose punctuation.
 */
export function classifyLine(line: string, boxed: boolean): DiffLine {
  const text = line.replace(/\s+$/, "");
  if (GAP.test(text.trim())) {
    return { kind: "gap", number: null, text: "" };
  }
  if (HUNK.test(text)) {
    return { kind: "hunk", number: null, text: text.trim() };
  }
  const boxedRow = BOXED.exec(text);
  if (boxedRow !== null) {
    const [, sigil, number, body] = boxedRow;
    const kind: DiffLineKind =
      sigil === "+" ? "add" : sigil === "-" ? "del" : "context";
    return { kind, number: number === "" ? null : number, text: untab(body) };
  }
  const numbered = NUMBERED.exec(text);
  if (numbered !== null) {
    return { kind: "context", number: numbered[1], text: untab(numbered[2]) };
  }
  const sigilRow = NUMBER_SIGIL.exec(text);
  if (sigilRow !== null) {
    const [, number, sigil, body] = sigilRow;
    return { kind: sigil === "+" ? "add" : "del", number, text: untab(body) };
  }
  if (boxed) {
    if (/^\s*\+(?!\+\+)/.test(text)) {
      return { kind: "add", number: null, text: untab(text.replace(/^\s*\+/, "")) };
    }
    if (/^\s*-(?!--)/.test(text)) {
      return { kind: "del", number: null, text: untab(text.replace(/^\s*-/, "")) };
    }
  }
  return { kind: "plain", number: null, text };
}

/** True when a run of detail lines is a diff at all. */
export function looksLikeDiff(lines: readonly string[]): boolean {
  const boxed = lines.some((line) => line.includes("│"));
  return lines.some((line) => {
    const { kind } = classifyLine(line, boxed);
    return kind === "add" || kind === "del" || kind === "hunk";
  });
}

/** Classify a whole detail body. */
export function diffLines(lines: readonly string[]): DiffLine[] {
  const boxed = lines.some((line) => line.includes("│"));
  return lines.map((line) => classifyLine(line, boxed));
}

/** How much a diff added and removed, for the `+6 −2` strip. */
export function diffStat(lines: readonly DiffLine[]): DiffStat {
  let add = 0;
  let del = 0;
  for (const line of lines) {
    if (line.kind === "add") {
      add += 1;
    } else if (line.kind === "del") {
      del += 1;
    }
  }
  return { add, del };
}

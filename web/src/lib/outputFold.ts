import { FENCE_RE } from "./markdown.ts";

/**
 * Turn a wall of tiny fenced blocks into a list of rows.
 *
 * A terminal agent does not emit one code block; it emits a code block every
 * time it mentions a command, a path or a value. The Claude Code pane measured
 * for this (`w6:p3`, one 80-line screen) had **17 fence lines = 8 blocks** in a
 * single answer, and after `reflowProse` unwrapped the paragraph around them the
 * turn was 1 543px tall on a 390px phone. Nothing in it was long: the blocks
 * held two lines each — `http://100.89.0.116:5000`, `this console`,
 * `100.89.0.3:5000 (m8s)`. The height was all chrome: a 26px head with a
 * language label and a copy button, plus the block's own padding, paid eight
 * times for eight lines of text.
 *
 * The rule here is deliberately narrow, because hiding an agent's answer is
 * worse than a tall page:
 *
 * - Only a *short* block collapses — 4 content lines or fewer. A real patch, a
 *   log, a config file keeps the shape `Markdown` gives it.
 * - Only *repetition* collapses. Fewer than three short blocks in one answer
 *   renders exactly as it does today, so a single command stays a command. The
 *   third one is the point at which the page has become a list of panels.
 * - Nothing is thrown away. A collapsed row carries the block's language, its
 *   line count and its first line, so the reader can tell whether they want it
 *   before opening it, and opening it re-renders the block through `fenceSource`
 *   — the body byte for byte, the language in the head.
 * - A block with no content collapses to nothing at all. Those are the TUI's
 *   own empties (an agent that opens and closes a fence around a blank row);
 *   they cost a head and a panel and say nothing.
 *
 * The one thing this does not do is re-order. Prose stays where the agent put
 * it, between the rows, so the transcript still reads top to bottom.
 */

/** A block this short is a value the agent mentioned, not a listing. */
export const SHORT_FENCE_LINES = 4;

/** Fewer short blocks than this and the answer is not a list of panels. */
export const FOLD_AT_SHORT_FENCES = 3;

/** The longest preview a collapsed row shows; the CSS truncates as well. */
const PEEK_CHARS = 96;

export type ProsePiece = {
  kind: "prose";
  /** Exact source, so the pieces of a segment concatenate back to it. */
  text: string;
};

export type FencePiece = {
  kind: "fence";
  /** Exact source, fences included: the round-trip anchor for the pieces. */
  text: string;
  /** The info string, read off the opening fence or — this TUI's habit — the closing one. */
  language: string;
  /** Content between the fences. */
  body: string;
  /** Content lines, blank ones excluded. */
  lines: number;
  /** Short enough to be a mention rather than a listing. */
  short: boolean;
  /** The first content line, for the collapsed row. */
  peek: string;
};

export type SilencePiece = {
  kind: "silence";
  /** A fence with nothing in it; rendered as nothing. */
  text: string;
};

export type OutputPiece = ProsePiece | FencePiece | SilencePiece;

export type OutputPlan = {
  pieces: OutputPiece[];
  /** Short blocks in this text; the caller sums it over the whole answer. */
  shortFences: number;
  /** True when the answer repeats the shape enough to be worth folding. */
  foldable: boolean;
};

function peekLine(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.trim().replace(/\s+/g, " ");
    if (text !== "") {
      return text.length > PEEK_CHARS ? `${text.slice(0, PEEK_CHARS - 1)}…` : text;
    }
  }
  return "";
}

function contentLines(body: string): number {
  return body.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Split prose into the fenced blocks and the text between them, and say whether
 * the result repeats enough to fold.
 */
export function planOutput(text: string): OutputPlan {
  const lines = text.split("\n");
  // Offsets into `text`, so every piece is an exact slice and nothing is
  // rebuilt from a line join: a fence that is opened and never closed, a
  // trailing newline, a `\r` — all of it stays where the agent put it.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const end = (index: number): number => (index < lines.length ? starts[index] : text.length);
  const slice = (from: number, to: number): string => text.slice(starts[from], end(to));

  const pieces: OutputPiece[] = [];
  let shortFences = 0;
  let proseFrom = 0;
  let index = 0;
  while (index < lines.length) {
    const open = FENCE_RE.exec(lines[index]);
    if (open === null) {
      index += 1;
      continue;
    }
    let close = -1;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (FENCE_RE.test(lines[next])) {
        close = next;
        break;
      }
    }
    if (close === -1) {
      // An opening fence with no close is text the agent never finished
      // writing; leave it to the prose renderer.
      index += 1;
      continue;
    }
    if (index > proseFrom) {
      pieces.push({ kind: "prose", text: slice(proseFrom, index) });
    }
    const body = lines.slice(index + 1, close).join("\n");
    const count = contentLines(body);
    const closing = FENCE_RE.exec(lines[close]);
    const language = (open[2] !== "" ? open[2] : (closing?.[2] ?? "")).trim();
    const source = slice(index, close + 1);
    if (count === 0) {
      pieces.push({ kind: "silence", text: source });
    } else {
      const short = count <= SHORT_FENCE_LINES;
      if (short) {
        shortFences += 1;
      }
      pieces.push({
        kind: "fence",
        text: source,
        language,
        body,
        lines: count,
        short,
        peek: peekLine(body),
      });
    }
    index = close + 1;
    proseFrom = index;
  }
  if (proseFrom < lines.length) {
    pieces.push({ kind: "prose", text: slice(proseFrom, lines.length) });
  }
  return {
    pieces,
    shortFences,
    foldable: shortFences >= FOLD_AT_SHORT_FENCES,
  };
}

/**
 * The fenced source to hand `Markdown`, rebuilt from the body and the language.
 *
 * A terminal agent writes its fences the way its own renderer expects: an
 * opening line that carries nothing, and then the language on the *closing*
 * line (` ``` ` … ` ```text `). `Markdown` closes a fence only on a bare marker
 * line, so a verbatim replay leaves that closing marker inside the block — the
 * reader opens a row and sees ` ```text ` as if the agent had printed it. The
 * plan already knows which line was the close and what language it named, so
 * the body can be re-fenced canonically: same body, same language, no stray
 * marker, and the copy button copies the text and not the TUI's scaffolding.
 */
export function fenceSource(piece: FencePiece): string {
  const body = piece.body === "" ? "" : piece.body.endsWith("\n") ? piece.body : `${piece.body}\n`;
  return `\`\`\`${piece.language}\n${body}\`\`\`\n`;
}

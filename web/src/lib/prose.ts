import { FENCE_RE } from "./markdown.ts";

/**
 * Put the prose an agent wrapped for a terminal back together before it is laid
 * out for a phone.
 *
 * A TUI writes into a fixed column count, so the agent's paragraph arrives as
 * several lines: the devin pane measured here wraps at 200 columns and cuts
 * mid-word, so `…的既有代码，避免…` ends a row and `改业务代码。` starts the next
 * one. The chat lens reads those as two rows and `Markdown` re-joins them the
 * way Markdown joins any two lines of a paragraph — with a space — which lands
 * *inside* a Chinese word: `不修 改业务代码`, `功 能测试`, `路 径审查`. Three of
 * those in one answer is enough to make the reading feel broken.
 *
 * The same source also loses the other direction: devin prints a paragraph on
 * its own row with no blank row after it, so ten paragraphs of a review run
 * together into one 3 000 px wall on a 390px screen. A row that ends a Chinese
 * sentence *and* stopped well short of the wrap column did not run out of room
 * — the agent ended a paragraph there, and the reader should see a break.
 *
 * Both repairs are shape-based: no agent name, no product, only "where did this
 * row stop". Fenced blocks, list/heading/table rows and drawn tables are left
 * exactly as they were — Markdown needs those line breaks to recognise them.
 */

/**
 * Sentence ends that are unambiguous inside CJK text. A full-width colon is on
 * the list because it ends a lead-in — `原因有三个：` is followed by the list it
 * announced, not by the rest of the same sentence.
 */
const TERMINATORS = "。！？…：";

/** Full-width punctuation, where Chinese typesetting puts no space beside Latin. */
const CJK_PUNCTUATION =
  /[\u3001-\u303f\u2018-\u201f\u2026\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/;

/** A row cut in the middle of a token; the halves were never two words. */
const SPLIT_TOKEN_END = /[/\-_@]$/;

/** Closing brackets/quotes that may follow a terminator. */
const CLOSERS = "”’」』）)]】》";

/** Rows that Markdown must still see at the start of a line. */
const BLOCK_START = /^(?:[-*+•·]|\d+[.)、]|[（(]\d+[)）]|#{1,6}\s|>|\||\u2500|\u2502|\u250c|\u2514|\u251c|\u253c)/;

/**
 * Spaces beside a full-width mark are not word gaps: the model writes
 * `go vet ./... 、前端` and `调用 RemoveAll 。应在`, and on a phone that reads as
 * a stumble, not as Chinese. Only the space *beside the punctuation* goes —
 * `没有 .env.test` keeps its space, because Chinese technical writing puts one
 * between a CJK word and an inline code span on purpose.
 *
 * Fenced code and drawn blocks are untouched: there a space can be content.
 */
const BEFORE_WIDE =
  /([^\s])[ \t]+([\u3001-\u303f\u2018-\u201f\u2026\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65])/g;

/**
 * Marks that never take a space on the far side either. A full-width mark is a
 * whole column of its own, so `。 我检查了` and `： go vet` read as a broken
 * column rather than as a pause. Only the marks that end a clause or open one
 * are listed: a full-width `～` in `10 ～ 20` *is* a word gap and stays.
 *
 * There has to be a glyph after the run: a row that simply ends `好了 。  ` is
 * a Markdown hard break (two trailing spaces), and that is a structure rather
 * than a word gap.
 */
const AFTER_WIDE = /([。，、；：！？…）】」』》〉”’（【「『《〈“‘])[ \t]+(?=\S)/g;

/**
 * The gap a block marker needs. `4. “合并并拉取本地”` is an ordered list item
 * only while the space after `4.` is there, and `“` is a full-width mark, so
 * tidying that gap folds the item into the paragraph above it and the list
 * loses its number. The marker's own run of spaces is never part of the tidy.
 */
const BLOCK_LEAD = /^(\s*(?:#{1,6}|[-*+]|\d{1,9}[.)、])[ \t]+)/;

function tighten(line: string): string {
  const lead = BLOCK_LEAD.exec(line);
  const head = lead === null ? "" : lead[1];
  const rest = line.slice(head.length);
  return head + rest.replace(BEFORE_WIDE, "$1$2").replace(AFTER_WIDE, "$1");
}

/** Any drawn line: box drawing means a diagram or a table, never prose. */
const DRAWN = /[\u2500-\u257f]/;

/** A line that is only a rule: `---`, `===`, `~~~`, `***`. */
const RULE = /^[-=_~*]{3,}$/;

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * Columns a row occupies in the terminal, which is what a wrap is measured in:
 * a CJK glyph is two columns, `[...text].length` says one and hides the wrap.
 */
export function proseWidth(text: string): number {
  let columns = 0;
  for (const glyph of text) {
    columns += isWide(glyph.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return columns;
}

function lastGlyph(text: string): number {
  const glyphs = [...text];
  return glyphs.length === 0 ? 0 : (glyphs[glyphs.length - 1].codePointAt(0) ?? 0);
}

function firstGlyph(text: string): number {
  const glyph = [...text][0];
  return glyph === undefined ? 0 : (glyph.codePointAt(0) ?? 0);
}

function endsSentence(line: string): boolean {
  const trimmed = line.replace(/[ \t]+$/, "");
  let index = trimmed.length;
  while (index > 0) {
    const glyph = String.fromCodePoint(trimmed.codePointAt(index - 1) ?? 0);
    if (CLOSERS.includes(glyph)) {
      index -= 1;
      continue;
    }
    return TERMINATORS.includes(glyph);
  }
  return false;
}

/**
 * How the two halves of a wrapped row were separated before the terminal cut
 * them: Chinese joins itself with nothing, Latin words need the space back.
 * Only used where a wrap is proven (the previous row stopped mid-sentence), so
 * there is no guessing about which words belonged together.
 */
function separator(previous: string, next: string): string {
  const left = lastGlyph(previous);
  const right = firstGlyph(next);
  const leftGlyph = String.fromCodePoint(left);
  const rightGlyph = String.fromCodePoint(right);
  // Two CJK glyphs sit next to each other without a space, and so does anything
  // beside full-width punctuation — `./...、前端`, `通过：go vet`. A Latin token
  // next to a CJK one keeps the space the language wants: `调用 API` → no, the
  // space belongs on the Latin side: `调用` + ` API`.
  if (isWide(left) && isWide(right)) {
    return "";
  }
  if (CJK_PUNCTUATION.test(leftGlyph) || CJK_PUNCTUATION.test(rightGlyph)) {
    return "";
  }
  // `… (file:///` + `Users/gouki/…` is one URL, cut where the terminal ran out
  // of room; a space there would corrupt the path.
  if (SPLIT_TOKEN_END.test(previous)) {
    return "";
  }
  return " ";
}

/**
 * A short row with no terminal punctuation that is not code, not a path and not
 * the tail of an English sentence: devin writes these for its `###` headings,
 * and the terminal renders them as plain rows, so they must not be glued to the
 * paragraph above.
 */
function looksLikeHeading(line: string, wrap: number): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || proseWidth(trimmed) > Math.min(28, Math.floor(wrap / 2))) {
    return false;
  }
  if (endsSentence(trimmed) || BLOCK_START.test(trimmed) || DRAWN.test(trimmed) || RULE.test(trimmed)) {
    return false;
  }
  // A heading is words. Anything carrying digits, slashes, dots or other ASCII
  // punctuation is a code fragment, a path, or a usage counter.
  return !/[A-Za-z0-9]/.test(trimmed) && !/[!-/:-@[-`{-~]/.test(trimmed);
}

export function reflowProse(text: string): string {
  const lines = text.split("\n");
  let wrap = 72;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      continue;
    }
    wrap = Math.max(wrap, proseWidth(line));
  }
  // A row that ended more than this many columns short of the wrap column did
  // not run out of room. 10 columns is half a dozen CJK glyphs, wide enough
  // that a wrap only just short of the edge is still read as a wrap.
  const short = wrap - 10;

  const out: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const open = FENCE_RE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (open !== null && open[1] === fence) {
        fence = null;
      }
      continue;
    }
    if (open !== null) {
      fence = open[1];
      out.push(line);
      continue;
    }

    const previous = out.length > 0 ? out[out.length - 1] : null;
    const joins =
      previous !== null &&
      line.trim() !== "" &&
      previous.trim() !== "" &&
      !BLOCK_START.test(line.trimStart()) &&
      !RULE.test(line.trim()) &&
      !RULE.test(previous.trim()) &&
      !DRAWN.test(line) &&
      !DRAWN.test(previous);

    if (!joins || previous === null) {
      out.push(line);
      continue;
    }

    if (endsSentence(previous) && proseWidth(previous) <= short) {
      // The agent ended a paragraph here; keep the gap it meant to leave.
      out.push("");
      out.push(line);
      continue;
    }

    if (looksLikeHeading(line, wrap)) {
      // The row above filled the wrap column, so this short row cannot be its
      // tail. It is a heading that the terminal left without a blank row.
      out.push("");
      out.push(line);
      continue;
    }

    out[out.length - 1] = previous + separator(previous, line) + line.trimStart();
  }

  // Joining rows can leave the model's own spaces next to full-width marks, and
  // so can a row that was never joined at all, so this pass is on every prose
  // row — the two that must keep their bytes (fences, drawn blocks) are skipped
  // by the same test that kept them out of the loop above.
  let inFence: string | null = null;
  return out
    .map((line) => {
      const open = FENCE_RE.exec(line);
      if (inFence !== null) {
        if (open !== null && open[1] === inFence) {
          inFence = null;
        }
        return line;
      }
      if (open !== null) {
        inFence = open[1];
        return line;
      }
      return DRAWN.test(line) ? line : tighten(line);
    })
    .join("\n");
}

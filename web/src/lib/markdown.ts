/**
 * Inline markdown and list structure for the transcript's prose.
 *
 * The rendering itself lives in `components/session/Markdown.tsx`; the parsing
 * rules live here so they are unit-testable without a DOM. The text is written
 * by an agent and a mis-parse is a visible lie — `memory_test.go` must never
 * turn into italics — so the boundary rules are worth asserting directly.
 */

export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export type ListItem = { readonly depth: number; readonly text: string };

export type ListBlock = {
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
  readonly end: number;
};

/* ------------------------------------------------------------------ block */

export const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
export const HEADING_RE = /^(#{1,6})\s+(.*)$/;
export const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
export const QUOTE_RE = /^\s*>\s?(.*)$/;

/* ----------------------------------------------------------------- inline */

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)\s]+\))/g;

/** CommonMark: `_` only emphasises at a word boundary; `*` may open mid-word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

export function inlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      spans.push({ kind: "text", text: text.slice(cursor, at) });
    }
    const token = match[0];
    const end = at + token.length;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
    if (link !== null) {
      spans.push({ kind: "link", text: link[1], href: link[2] });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("_") && (isWordChar(text[at - 1]) || isWordChar(text[end]))) {
      // A snake_case word, not emphasis: the underscores belong to the text.
      spans.push({ kind: "text", text: token });
    } else {
      spans.push({ kind: "em", text: token.slice(1, -1) });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    spans.push({ kind: "text", text: text.slice(cursor) });
  }
  return spans;
}

/* -------------------------------------------------------------------- list */

export function parseList(lines: readonly string[], start: number): ListBlock | null {
  const first = LIST_RE.exec(lines[start] ?? "");
  if (first === null) {
    return null;
  }
  const ordered = /\d/.test(first[2] ?? "");
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const list = LIST_RE.exec(lines[index]);
    if (list === null) {
      break;
    }
    const depth = Math.floor(list[1].length / 2);
    const parts = [list[3]];
    index += 1;
    // A wrapped continuation line belongs to the item before it; join it into
    // the same text so the renderer emits one <li>, never an <li> inside one.
    while (index < lines.length) {
      const next = lines[index];
      if (
        next.trim() === "" ||
        LIST_RE.test(next) ||
        FENCE_RE.test(next) ||
        QUOTE_RE.test(next)
      ) {
        break;
      }
      parts.push(next.trim());
      index += 1;
    }
    items.push({ depth, text: parts.join(" ") });
  }
  return { ordered, items, end: index };
}

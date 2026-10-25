/* The terminal find bar's two pieces of judgement that are not xterm's.

   Everything else about a search — which rows, how to scroll, how to highlight
   — belongs to `@xterm/addon-search` and the terminal it is loaded into. What
   is left is the counter's arithmetic (xterm reports a zero-based index and a
   total, a reader wants `3/17`) and the highlight palette: xterm's decorations
   take `#RRGGBB` only, so a colour cannot be a `var()` and has to be named
   here. Both are plain functions precisely so they can be tested without a
   browser. */

export type FindHit = { index: number; count: number };

/** No match yet: what the bar shows before the first keystroke and after a miss. */
export const FIND_MISS: FindHit = { index: -1, count: 0 };

/**
 * The bar's counter.
 *
 * xterm's `resultIndex` is zero-based and is `-1` when a search has matches but
 * none is active (pressing Esc in the bar clears the selection without clearing
 * the count). A reader never sees `-1/17`: the first match is assumed, which is
 * what the next Enter would land on anyway.
 */
export function findLabel(hit: FindHit): string {
  const count = Math.max(0, Math.trunc(Number.isFinite(hit.count) ? hit.count : 0));
  if (count === 0) {
    return "0/0";
  }
  const raw = Math.trunc(Number.isFinite(hit.index) ? hit.index : -1);
  const index = raw < 0 ? 1 : Math.min(raw + 1, count);
  return `${index}/${count}`;
}

export type FindTheme = "dark" | "light";

export type FindInk = {
  /** Every match other than the active one. */
  match: string;
  /** The match Enter just landed on; the border makes it unmistakable. */
  active: string;
  /** Border and overview-ruler colour, an accent so the active match reads. */
  accent: string;
};

/**
 * The highlight for a theme.
 *
 * These are deliberately *solid* approximations of the palette rather than the
 * accent itself: a match is painted behind glyphs xterm will not recolour, so
 * the active match gets a quiet warm fill plus an accent border instead of a
 * filled accent block that would swallow the text.
 */
export function findInk(theme: FindTheme): FindInk {
  if (theme === "light") {
    return { match: "#efe6d2", active: "#ffd4bf", accent: "#a83d14" };
  }
  return { match: "#26262c", active: "#3a2b22", accent: "#ff7a45" };
}

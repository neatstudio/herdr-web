/*
 * ANSI SGR to HTML for the transcript.
 *
 * The herdr daemon returns pane text with real escape sequences. A zsh prompt
 * alone emits 256-colour codes (`ESC[38;5;6m`), and coding agents emit bold,
 * reverse and truecolor too, so this covers the SGR subset terminals actually
 * use rather than a token few codes.
 *
 * Only colours and a few attributes are honoured: this is a read-only feed,
 * not a terminal emulator. Anything not understood is dropped, never passed
 * through to the DOM.
 */

/** The canvas the transcript is drawn onto; paper and carbon are the page's. */
export type CanvasMode = "content" | "paper" | "carbon";

type Style = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
};

function resetStyle(): Style {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
  };
}

/** The 16 base colours live in CSS so each theme can tune them. */
function baseColour(index: number): string {
  return `var(--ansi-${index})`;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** xterm-256 index to an absolute colour, or "" when out of range. */
export function colour256(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return "";
  }
  if (index < 16) {
    return baseColour(index);
  }
  if (index < 232) {
    const offset = index - 16;
    const red = CUBE_LEVELS[Math.floor(offset / 36) % 6];
    const green = CUBE_LEVELS[Math.floor(offset / 6) % 6];
    const blue = CUBE_LEVELS[offset % 6];
    return `rgb(${red},${green},${blue})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

function trueColor(r: number, g: number, b: number): string {
  return `rgb(${clampByte(r)},${clampByte(g)},${clampByte(b)})`;
}

/**
 * Mirror an absolute colour onto the page's canvas by inverting its HSL
 * lightness and keeping hue and saturation. A full-screen app bakes its own
 * dark canvas into truecolor output; drawn literally on a light page that is a
 * dark block with light text inside it. Flipping lightness keeps the relative
 * structure (raised panels, dimmed text) instead of flattening it.
 *
 * Holding H and S fixed leaves the chroma span untouched, so inverting L is
 * exactly a shift of every channel by 1 - 2L; the clamp only absorbs float
 * drift. Palette references are left alone: each theme already tunes those 16
 * entries for its own paper, so inverting them would fight the theme.
 */
function adaptColour(colour: string, mode: CanvasMode): string {
  if (mode === "content") {
    return colour;
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
  if (rgb === null) {
    return colour;
  }
  const r = Number(rgb[1]) / 255;
  const g = Number(rgb[2]) / 255;
  const b = Number(rgb[3]) / 255;
  const shift = 1 - (Math.max(r, g, b) + Math.min(r, g, b));
  return `rgb(${clampByte((r + shift) * 255)},${clampByte((g + shift) * 255)},${clampByte(
    (b + shift) * 255,
  )})`;
}

/**
 * Apply one SGR parameter list, starting at `start`. Returns how many
 * additional parameters were consumed (38 and 48 take a colour spec after
 * them, so the caller must skip those).
 */
export function applySgr(style: Style, params: number[], start: number): number {
  const code = params[start];
  if (code === 0) {
    Object.assign(style, resetStyle());
    return 0;
  }
  switch (code) {
    case 1:
      style.bold = true;
      return 0;
    case 2:
      style.dim = true;
      return 0;
    case 3:
      style.italic = true;
      return 0;
    case 4:
      style.underline = true;
      return 0;
    case 7:
      style.reverse = true;
      return 0;
    case 22:
      style.bold = false;
      style.dim = false;
      return 0;
    case 23:
      style.italic = false;
      return 0;
    case 24:
      style.underline = false;
      return 0;
    case 27:
      style.reverse = false;
      return 0;
    case 39:
      style.fg = null;
      return 0;
    case 49:
      style.bg = null;
      return 0;
    default:
      break;
  }

  const setFg = code === 38;
  const setBg = code === 48;
  if (setFg || setBg) {
    const mode = params[start + 1];
    if (mode === 5) {
      const colour = colour256(params[start + 2] ?? -1);
      if (colour !== "") {
        if (setFg) {
          style.fg = colour;
        } else {
          style.bg = colour;
        }
      }
      return 2;
    }
    if (mode === 2) {
      if (params.length >= start + 5) {
        const colour = trueColor(params[start + 2], params[start + 3], params[start + 4]);
        if (setFg) {
          style.fg = colour;
        } else {
          style.bg = colour;
        }
      }
      return 4;
    }
    return 0;
  }

  if (code >= 30 && code <= 37) {
    style.fg = baseColour(code - 30);
    return 0;
  }
  if (code >= 40 && code <= 47) {
    style.bg = baseColour(code - 40);
    return 0;
  }
  if (code >= 90 && code <= 97) {
    style.fg = baseColour(code - 90 + 8);
    return 0;
  }
  if (code >= 100 && code <= 107) {
    style.bg = baseColour(code - 100 + 8);
    return 0;
  }
  // Blink, fonts, hyperlinks, kitty extensions: ignored on purpose.
  return 0;
}

function rgbParts(colour: string): { r: number; g: number; b: number } | null {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
  return match === null ? null : { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function lumaOf(rgb: { r: number; g: number; b: number }): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/** Move a colour to a target luma, keeping its hue (scale down or blend up). */
function withLuma(rgb: { r: number; g: number; b: number }, target: number): string {
  const luma = lumaOf(rgb);
  if (target < luma) {
    const scale = luma === 0 ? 0 : target / luma;
    return `rgb(${clampByte(rgb.r * scale)},${clampByte(rgb.g * scale)},${clampByte(rgb.b * scale)})`;
  }
  const blend = luma === 1 ? 0 : (target - luma) / (1 - luma);
  return `rgb(${clampByte(rgb.r + (255 - rgb.r) * blend)},${clampByte(rgb.g + (255 - rgb.g) * blend)},${clampByte(
    rgb.b + (255 - rgb.b) * blend,
  )})`;
}

/**
 * A foreground that stays readable on its actual backdrop.
 *
 * Mirroring lightness is right for a canvas, but wrong for a saturated colour:
 * #03ff88 (a common agent green) becomes #00fc85 on paper, which is still a
 * bright mint on a near-white page. Mirror first, then pull the result into a
 * readable luma band against the background it will sit on (or the page when
 * it has no background of its own).
 */
function readableInk(
  colour: string,
  background: string | null,
  mode: CanvasMode,
  lightPage: boolean,
): string {
  const mirrored = adaptColour(colour, mode);
  const rgb = rgbParts(mirrored);
  if (rgb === null) {
    return mirrored;
  }
  const bg = background === null ? null : rgbParts(background);
  const light = bg !== null ? lumaOf(bg) > 0.5 : mode === "paper" || (mode === "content" && lightPage);
  const luma = lumaOf(rgb);
  if (light && luma > 0.45) {
    return withLuma(rgb, 0.22);
  }
  if (!light && luma < 0.35) {
    return withLuma(rgb, 0.55);
  }
  return mirrored;
}

function styleToCss(style: Style, mode: CanvasMode, lightPage: boolean): string {
  const declarations: string[] = [];
  let fg = style.fg;
  let bg = style.bg;
  if (style.reverse) {
    const swappedFg = bg ?? "var(--ink)";
    const swappedBg = fg ?? "var(--paper)";
    fg = swappedFg;
    bg = swappedBg;
  }
  bg = bg === null ? null : adaptColour(bg, mode);
  fg = fg === null ? null : readableInk(fg, bg, mode, lightPage);
  if (fg !== null) {
    declarations.push(`color:${fg}`);
  } else if (bg !== null) {
    // A background with no foreground of its own: full-screen apps paint
    // their canvas this way and rely on the terminal's own default text
    // colour. Inheriting the page's ink would print dark-on-dark in the
    // light theme, so pick an ink that contrasts with this background.
    // Measuring the adapted background is what makes that hold in paper and
    // carbon mode too.
    declarations.push(`color:${inkOn(bg)}`);
  }
  if (bg !== null) {
    declarations.push(`background-color:${bg}`);
  }
  if (style.bold) {
    declarations.push("font-weight:700");
  }
  if (style.dim) {
    declarations.push("opacity:.65");
  }
  if (style.italic) {
    declarations.push("font-style:italic");
  }
  if (style.underline) {
    declarations.push("text-decoration:underline");
  }
  return declarations.join(";");
}

/** Base ANSI palette entries 7 and 15 are the light ones in both themes. */
const LIGHT_BASE_COLOURS = new Set([7, 15]);

/*
 * Ink chosen against a background the content declared. These two tokens are
 * absolute, not palette entries: each theme tints the ANSI palette for its own
 * paper, so reusing a palette entry here would pick the opposite of what is
 * needed (the light theme's "bright white" is near black on purpose).
 */
const INK_ON_DARK = "var(--ansi-ink-on-dark)";
const INK_ON_LIGHT = "var(--ansi-ink-on-light)";

/**
 * An ink that stays readable on `background`. Absolute colours are measured;
 * palette references fall back to the known light/dark split of the 16 base
 * entries.
 */
export function inkOn(background: string): string {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(background);
  if (rgb !== null) {
    // Rec. 601 luma: good enough to choose black or white ink.
    const luma =
      (0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3])) / 255;
    return luma > 0.55 ? INK_ON_LIGHT : INK_ON_DARK;
  }
  const palette = /^var\(--ansi-(\d+)\)$/.exec(background);
  if (palette !== null) {
    return LIGHT_BASE_COLOURS.has(Number(palette[1])) ? INK_ON_LIGHT : INK_ON_DARK;
  }
  return INK_ON_DARK;
}

// eslint-disable-next-line no-control-regex
const ESC = "\u001b";
// "-" is accepted so a malformed channel is parsed and clamped instead of
// leaking a raw escape sequence into the output.
const SGR_RE = new RegExp(`${ESC}\\[([0-9;-]*)m`, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?-]*[A-Za-z]`, "g");

type Segment = { text: string; style: Style };

/**
 * Split one line into styled runs. Non-SGR control sequences are dropped
 * first, so cursor moves and erases never reach the output.
 */
function parseLine(line: string): Segment[] {
  const text = line.replace(/\r/g, "");
  if (text === "") {
    return [];
  }
  const clean = text.replace(CSI_RE, (match) => (match.endsWith("m") ? match : ""));
  const segments: Segment[] = [];
  const style = resetStyle();
  let cursor = 0;
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(clean)) !== null) {
    const chunk = clean.slice(cursor, match.index);
    if (chunk !== "") {
      segments.push({ text: chunk, style: { ...style } });
    }
    cursor = match.index + match[0].length;
    const params = match[1]
      .split(";")
      .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
      .filter((value) => Number.isFinite(value));
    for (let index = 0; index < params.length; index += 1) {
      index += applySgr(style, params, index);
    }
  }
  const tail = clean.slice(cursor);
  if (tail !== "") {
    segments.push({ text: tail, style: { ...style } });
  }
  return segments;
}

/**
 * Drop the terminal's padding. A terminal fills the rest of every row with
 * spaces so the background reaches the right edge; those spaces are canvas,
 * not content, and only survive when they are actually painting something.
 */
function trimPadding(segments: Segment[]): Segment[] {
  const out = segments.slice();
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const segment = out[index];
    if (segment.style.bg !== null) {
      // Backgrounded padding is the canvas reaching the row edge: keep it.
      break;
    }
    if (segment.text.trim() === "") {
      out.splice(index, 1);
      continue;
    }
    segment.text = segment.text.replace(/\s+$/, "");
    break;
  }
  return out;
}

/**
 * A path in the output is made clickable, so a chart or a log an agent wrote can
 * be opened from the line that names it. Only the text is touched: the style of
 * the segment is carried over to each piece.
 */
function linkPaths(text: string): string {
  const matches = findPaths(text);
  if (matches.length === 0) {
    return escapeHtml(text);
  }
  let html = "";
  let cursor = 0;
  for (const match of matches) {
    html += escapeHtml(text.slice(cursor, match.start));
    html += `<a class="path" data-path="${escapeHtml(match.path)}" href="#">${escapeHtml(match.path)}</a>`;
    cursor = match.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function render(segments: Segment[], mode: CanvasMode, lightPage: boolean): string {
  let html = "";
  for (const segment of segments) {
    // Belt and braces: no escape byte may reach the DOM, even from a sequence
    // the parser did not recognise.
    const safe = segment.text.replace(/\u001b/g, "");
    if (safe === "") {
      continue;
    }
    const css = styleToCss(segment.style, mode, lightPage);
    const escaped = linkPaths(safe);
    html += css === "" ? escaped : `<span style="${css}">${escaped}</span>`;
  }
  return html;
}

/**
 * The colour to paint behind a whole pane, adapted for the page theme. A
 * wrapped transcript needs this: without it every visual row would show the
 * page through the gaps and the canvas would break into stripes.
 */
export function canvasBackdrop(canvas: string | null, mode: CanvasMode): string | null {
  return canvas === null ? null : adaptColour(canvas, mode);
}

/**
 * The background a whole line paints, when one colour covers most of it.
 *
 * A diff line often has a full-line band. Inline backgrounds only cover the
 * glyphs, so the line box's leading shows the page through them and a wrapped
 * line becomes a stack of stripes. Painting the dominant band on the line
 * element fills the row and its wrapped continuations; mixed lines return null
 * and keep their per-segment backgrounds.
 */
export function lineBackground(line: string, mode: CanvasMode = "content"): string | null {
  const segments = trimPadding(parseLine(line));
  let total = 0;
  const counts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.text.length === 0) {
      continue;
    }
    total += segment.text.length;
    const background = segment.style.reverse ? segment.style.fg : segment.style.bg;
    if (background !== null) {
      counts.set(background, (counts.get(background) ?? 0) + segment.text.length);
    }
  }
  if (total === 0) {
    return null;
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [colour, count] of counts) {
    if (count > bestCount) {
      best = colour;
      bestCount = count;
    }
  }
  if (best === null || bestCount / total < 0.6) {
    return null;
  }
  return adaptColour(best, mode);
}

/**
 * Lines to keep: one screen of ~200 unchanged lines always hits, plus headroom
 * for a pane switch and the three modes. Bounded because a long-running console
 * keeps emitting distinct lines, and nothing else would ever evict them.
 */
export const ANSI_CACHE_CAPACITY = 2048;

/* Rendering is pure, so an entry keyed by line and mode can never go stale. */
const ansiCache = new Map<string, string>();
let ansiHits = 0;
let ansiMisses = 0;

/** Empty the cache and zero the counters, so a hit rate can be measured. */
export function clearAnsiCache(): void {
  ansiCache.clear();
  ansiHits = 0;
  ansiMisses = 0;
}

export function ansiCacheStats(): { size: number; hits: number; misses: number } {
  return { size: ansiCache.size, hits: ansiHits, misses: ansiMisses };
}

/** One line of pane text to HTML. */
export function ansiLineToHtml(line: string, mode: CanvasMode = "content", lightPage = true): string {
  // Mode and page are part of the key: paper and carbon mirror absolute
  // colours, and a light page pulls a bright foreground down. NUL cannot
  // appear in either.
  const key = `${mode}\u0000${lightPage ? "l" : "d"}\u0000${line}`;
  const cached = ansiCache.get(key);
  if (cached !== undefined) {
    ansiHits += 1;
    // Re-insert the hit so eviction drops the entry that has gone longest
    // without use, not a line that repaints on every poll.
    ansiCache.delete(key);
    ansiCache.set(key, cached);
    return cached;
  }
  const html = render(trimPadding(parseLine(line)), mode, lightPage);
  ansiMisses += 1;
  if (ansiCache.size >= ANSI_CACHE_CAPACITY) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = ansiCache.keys().next();
    if (oldest.done === false) {
      ansiCache.delete(oldest.value);
    }
  }
  ansiCache.set(key, html);
  return html;
}

/**
 * The most painted background in a pane, and how much of the pane it covers.
 * The two callers need different bars: mirroring a dark canvas on paper is
 * useful even when only half the lines carry it, while filling the whole pane
 * with a colour needs it to be the pane's own background rather than a band of
 * highlighted output.
 */
export type CanvasTone = { colour: string | null; share: number };

import { findPaths } from "./paths.ts";

export function canvasTone(lines: string[]): CanvasTone {
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const segment of parseLine(line)) {
      if (segment.style.bg === null) {
        continue;
      }
      counts.set(segment.style.bg, (counts.get(segment.style.bg) ?? 0) + segment.text.length);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [colour, count] of counts) {
    if (count > bestCount) {
      best = colour;
      bestCount = count;
    }
  }
  // A single coloured word is not a background at all.
  if (best === null || bestCount < 120 || lines.length === 0) {
    return { colour: null, share: 0 };
  }
  const covering = lines.filter((line) =>
    parseLine(line).some((segment) => segment.style.bg === best && segment.text.length > 0),
  ).length;
  return { colour: best, share: covering / lines.length };
}

/** Strip every escape sequence, for accessible text and clipboard use. */
export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(/\r/g, "");
}

/**
 * True for a line that is only a horizontal rule or a box border.
 *
 * A TUI draws these as one long unbreakable token. Wrapping 120 dashes at the
 * viewport turns a separator into three lines of noise, so the transcript
 * clips these lines instead of reflowing them; exact mode still scrolls them
 * because it preserves terminal geometry.
 */
export function isHorizontalRule(line: string): boolean {
  const text = stripAnsi(line).trim();
  return text.length >= 8 && /^[-─━═⎯_=╭╮╰╯┌┐└┘├┤┬┴┼]+$/.test(text);
}

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

function styleToCss(style: Style, mode: CanvasMode): string {
  const declarations: string[] = [];
  let fg = style.fg;
  let bg = style.bg;
  if (style.reverse) {
    const swappedFg = bg ?? "var(--ink)";
    const swappedBg = fg ?? "var(--paper)";
    fg = swappedFg;
    bg = swappedBg;
  }
  fg = fg === null ? null : adaptColour(fg, mode);
  bg = bg === null ? null : adaptColour(bg, mode);
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

function render(segments: Segment[], mode: CanvasMode): string {
  let html = "";
  for (const segment of segments) {
    // Belt and braces: no escape byte may reach the DOM, even from a sequence
    // the parser did not recognise.
    const safe = segment.text.replace(/\u001b/g, "");
    if (safe === "") {
      continue;
    }
    const css = styleToCss(segment.style, mode);
    const escaped = escapeHtml(safe);
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

/** One line of pane text to HTML. */
export function ansiLineToHtml(line: string, mode: CanvasMode = "content"): string {
  return render(trimPadding(parseLine(line)), mode);
}

/**
 * The canvas colour a full-screen application paints for itself, if it paints
 * one. Such an app assumes its own background spans the whole viewport; when
 * a line is shorter than the pane, the gap would otherwise show the page and
 * break the canvas into stripes.
 *
 * Returns null for ordinary output, so a plain shell keeps the page's own
 * background and the light theme stays light. The paper and carbon modes
 * always return null: there the page itself is the canvas, and painting the
 * content's own would put a second, contradictory block behind it.
 */
export function dominantBackground(
  lines: string[],
  mode: CanvasMode = "content",
): string | null {
  if (mode !== "content") {
    return null;
  }
  const counts = new Map<string, number>();
  const linesWithBackground = new Set<string>();
  for (const line of lines) {
    for (const segment of parseLine(line)) {
      if (segment.style.bg === null) {
        continue;
      }
      counts.set(segment.style.bg, (counts.get(segment.style.bg) ?? 0) + segment.text.length);
      linesWithBackground.add(segment.style.bg);
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
  // A couple of highlighted words are not a canvas; a filled screen is.
  if (best === null || bestCount < 120 || linesWithBackground.size === 0) {
    return null;
  }
  const coveringLines = lines.filter((line) =>
    parseLine(line).some((segment) => segment.style.bg === best && segment.text.length > 0),
  ).length;
  return coveringLines >= 2 ? best : null;
}

/** Strip every escape sequence, for accessible text and clipboard use. */
export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(/\r/g, "");
}

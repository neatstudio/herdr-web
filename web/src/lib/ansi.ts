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

function styleToCss(style: Style): string {
  const declarations: string[] = [];
  let fg = style.fg;
  let bg = style.bg;
  if (style.reverse) {
    const swappedFg = bg ?? "var(--ink)";
    const swappedBg = fg ?? "var(--paper)";
    fg = swappedFg;
    bg = swappedBg;
  }
  if (fg !== null) {
    declarations.push(`color:${fg}`);
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

function wrap(text: string, style: Style): string {
  // Belt and braces: no escape byte may reach the DOM, even from a sequence
  // the parser did not recognise.
  const safe = text.replace(/\u001b/g, "");
  if (safe === "") {
    return "";
  }
  const css = styleToCss(style);
  const escaped = escapeHtml(safe);
  return css === "" ? escaped : `<span style="${css}">${escaped}</span>`;
}

// eslint-disable-next-line no-control-regex
const ESC = "\u001b";
// "-" is accepted so a malformed channel is parsed and clamped instead of
// leaking a raw escape sequence into the output.
const SGR_RE = new RegExp(`${ESC}\\[([0-9;-]*)m`, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?-]*[A-Za-z]`, "g");

/**
 * One line of pane text to HTML. A terminal pads lines to its width and ends
 * them with CRLF, so carriage returns and the trailing padding are dropped:
 * they are not content, and keeping them wrapped the feed into blank rows.
 */
export function ansiLineToHtml(line: string): string {
  const text = line.replace(/\r/g, "").replace(/\s+$/, "");
  if (text === "") {
    return "";
  }
  // Drop non-SGR CSI sequences (cursor moves, erases) before parsing.
  const clean = text.replace(CSI_RE, (match) => (match.endsWith("m") ? match : ""));
  const style = resetStyle();
  let html = "";
  let cursor = 0;
  let plain = "";
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(clean)) !== null) {
    plain += clean.slice(cursor, match.index);
    html += wrap(plain, style);
    plain = "";
    cursor = match.index + match[0].length;
    const params = match[1]
      .split(";")
      .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
      .filter((value) => Number.isFinite(value));
    for (let index = 0; index < params.length; index += 1) {
      index += applySgr(style, params, index);
    }
  }
  plain += clean.slice(cursor);
  html += wrap(plain, style);
  return html;
}

/** Strip every escape sequence, for accessible text and clipboard use. */
export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(/\r/g, "");
}

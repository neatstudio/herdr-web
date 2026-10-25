/*
 * The transcript model behind the chat lens.
 *
 * herdr only exposes `pane.read`: a screen snapshot of a terminal full of
 * escape sequences. There is no transcript API and no per-agent parser, so
 * this file rebuilds the document from what the TUI actually painted: a run of
 * background-filled lines is a user turn, italic small print is reasoning, an
 * ASCII box or a glyph row is tool work, everything else is the answer.
 *
 * Rules are deliberately shape-based rather than brand-based. The same
 * pipeline has to survive a household of agents (`pi`, `omp`, `opencode`,
 * `zerostack`, sometimes `claude` and `codex`) and panes that emit no ANSI at
 * all. Anything that cannot be recognised is prose, because prose is never the
 * wrong answer.
 *
 * DOM-free and clock-free: the model is a pure function of the snapshot text.
 */

import { applySgr } from "./ansi.ts";
import { formatDuration, parseDuration, type WorkKind } from "./chatFormat.ts";

/** One line of folded work: a tool call, a job, a spinner. */
export type WorkRow = {
  kind: WorkKind;
  title: string;
  detail: string[];
};

/** One exchange: what the operator said, what the agent thought and did, and what it answered. */
export type ChatTurn = {
  id: string;
  user: string | null;
  thoughts: string[];
  work: WorkRow[];
  answer: string;
  recap: string | null;
};

/** The whole transcript for one pane snapshot. */
export type Conversation = {
  turns: ChatTurn[];
  lines: number;
};

/* ------------------------------------------------------------------ spans */

type SgrStyle = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
};

type Span = { text: string; style: SgrStyle };

type Line = { plain: string; spans: Span[] };

const ESC = "\u001b";

function csiPattern(): RegExp {
  return new RegExp(`${ESC}\\[[0-9;?-]*[A-Za-z]`, "g");
}

function sgrPattern(): RegExp {
  return new RegExp(`${ESC}\\[([0-9;-]*)m`, "g");
}

function emptyStyle(): SgrStyle {
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

/** Split one raw pane line into styled spans, dropping every non-SGR sequence. */
function parseSpans(raw: string): Span[] {
  const text = raw.replace(/\r/g, "").replace(/\uFE0F/g, "");
  if (text === "") {
    return [];
  }
  const csi = csiPattern();
  const clean = text.replace(csi, (match) => (match.endsWith("m") ? match : ""));
  const spans: Span[] = [];
  const style = emptyStyle();
  const sgr = sgrPattern();
  let cursor = 0;
  let match: RegExpExecArray | null = sgr.exec(clean);
  while (match !== null) {
    const chunk = clean.slice(cursor, match.index);
    if (chunk !== "") {
      spans.push({ text: chunk, style: { ...style } });
    }
    cursor = match.index + match[0].length;
    const params = match[1]
      .split(";")
      .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
      .filter((value) => Number.isFinite(value));
    for (let index = 0; index < params.length; index += 1) {
      index += applySgr(style, params, index);
    }
    match = sgr.exec(clean);
  }
  const tail = clean.slice(cursor);
  if (tail !== "") {
    spans.push({ text: tail, style: { ...style } });
  }
  return spans;
}

function readLine(raw: string): Line {
  const spans = parseSpans(raw);
  let plain = "";
  for (const span of spans) {
    plain += span.text;
  }
  return { plain: plain.replace(/\s+$/, ""), spans };
}

function hasInk(line: Line): boolean {
  return line.spans.some((span) => span.text.trim() !== "");
}

function isEmptyLine(line: Line): boolean {
  return !hasInk(line);
}

function textOf(line: Line): string {
  return line.plain.trim();
}

function hasBackground(line: Line): boolean {
  return line.spans.some((span) => span.style.bg !== null);
}

/**
 * A *band* row: the fill starts before the text does, and it covers most of
 * the row.
 *
 * `hasBackground` is not enough to recognise a user message. An answer that
 * mentions a `path` or a `command` carries the inline chip's background on a
 * handful of glyphs, and devin writes its answers as plain prose. So a
 * paragraph with one chip in it looked exactly like a filled user band: on
 * `w6:p7` every answer paragraph was promoted to a user turn, which put the
 * agent's own words in the operator's bubble and left the real messages
 * ("❭ /usage", "❭ 继续") behind as chrome.
 *
 * A real band is filled for the whole row — the input box pads it out to the
 * pane width. Requiring the first visible glyph to sit on the fill, and the
 * fill to cover most of the row, separates the two without comparing colours
 * (the colours are identical; see `BOX_EDGE_RE`).
 */
function isBandRow(line: Line): boolean {
  let filled = 0;
  let total = 0;
  let leading = false;
  let leadingSeen = false;
  for (const span of line.spans) {
    const chars = span.text.length;
    total += chars;
    if (span.style.bg !== null) {
      filled += chars;
    }
    if (!leadingSeen && span.text.search(/\S/) !== -1) {
      leadingSeen = true;
      leading = span.style.bg !== null;
    }
  }
  return leadingSeen && leading && filled * 2 >= total;
}

function italicShare(line: Line): number {
  let total = 0;
  let italic = 0;
  for (const span of line.spans) {
    const chars = span.text.replace(/\s/g, "").length;
    if (chars === 0) {
      continue;
    }
    total += chars;
    if (span.style.italic) {
      italic += chars;
    }
  }
  return total === 0 ? 0 : italic / total;
}

function hasDefaultInk(line: Line): boolean {
  return line.spans.some((span) => span.text.trim() !== "" && span.style.fg === null);
}

/*
 * Reasoning is italic small print. Some agents colour it, some grey it, some
 * mix several colours in one paragraph, so the test cannot be "grey": it is
 * "no default-coloured visible text, and italic enough to not be a stray
 * em-dash".
 */
function isReasoningLine(line: Line): boolean {
  if (italicShare(line) < 0.15) {
    return false;
  }
  return !hasDefaultInk(line);
}

/* ----------------------------------------------------------------- chrome */

const COMPOSER_FOOTER_RE = /(?: > ){3,}/;
const CHROME_PATTERNS: readonly RegExp[] = [
  /^[|\u2502].*-{8,}/, // `| 2m ... -------------1M-` progress bars
  /^\[Wall:\s/i,
  /^\|\s*\[Backgrounded:/i,
  /^…\s/,
  /^╰─/,
  /^\s*❭\s/,
  /^\s*(?:daily|weekly|monthly|hourly)\s+[■▰▮▪=#]/i,
  /^\s*this session\s*$/i,
  /^\s*activity\s+\d+\s+turns?\b/i,
  /^\s*tokens\s+[\d.]+k?\s+in\b/i,
  /^\s*model\s+\S/i,
  /^\s*\d+%\s+(?:used|of)\b/i,
  /^\s*bypass\s*$/i,
];

function isStatusBar(text: string): boolean {
  // `| 2m > model > cwd > branch > cost >` is furniture, not prose.
  if (text.includes(" > ") && text.split(" > ").length >= 4) {
    return true;
  }
  return /^[|\u2502].*-{8,}/.test(text);
}

function isComposerFooter(text: string): boolean {
  if (COMPOSER_FOOTER_RE.test(text)) {
    return true;
  }
  if (isStatusBar(text)) {
    return true;
  }
  return /^>\s/.test(text) && /\s>\s/.test(text);
}

function isChromeText(text: string): boolean {
  if (text === "") {
    return false;
  }
  if (isComposerFooter(text)) {
    return true;
  }
  for (const pattern of CHROME_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return /\[Ctrl\+O/.test(text);
}

/**
 * Some agents echo the submitted line behind a `❭` marker. Below the input box
 * that echo is furniture, but a *filled* `❭` row is the first row of a user
 * message the input box wrapped, and the marker is the only thing that says so
 * (devin writes answers as prose, so the fill alone would not distinguish it).
 */
const PROMPT_ECHO_RE = /^\s*❭\s+/;

function stripPromptEcho(text: string): string {
  return text.replace(PROMPT_ECHO_RE, "");
}

function isPromptEcho(line: Line): boolean {
  return PROMPT_ECHO_RE.test(textOf(line)) && isBandRow(line);
}

function isChrome(line: Line): boolean {
  if (isPromptEcho(line)) {
    return false;
  }
  return isChromeText(textOf(line));
}

function isPadding(text: string): boolean {
  return /^[─━═╌\s]{3,}$/.test(text);
}

/* ------------------------------------------------------------------ recap */

const RECAP_RE = /^(?:※\s*)?recap:\s*(.*)$/i;

function recapText(text: string): string | null {
  const match = RECAP_RE.exec(text);
  if (match === null) {
    return null;
  }
  return match[1].trim();
}

/* -------------------------------------------------------------- user band */

function joinUserLines(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    if (index === 0) {
      lines.push(current);
      continue;
    }
    const previous = parts[index - 1];
    // A numbered item starts a line whether it uses `1.`, `1)` or the CJK
    // `1、` devin writes; agents wrap one submitted message into both.
    const startsBlock = /^(?:[-*•>]\s|\d+[.)、])/.test(current);
    const previousShort = previous.length < 32;
    const previousEndsSentence = /[。！？.!?:：;；]$/.test(previous);
    if (startsBlock || previousShort || previousEndsSentence) {
      lines.push(current);
      continue;
    }
    const cjk = /[\u4e00-\u9fff]$/.test(previous) || /^[\u4e00-\u9fff]/.test(current);
    lines[lines.length - 1] = `${lines[lines.length - 1]}${cjk ? "" : " "}${current}`;
  }
  return lines.join("\n");
}

/**
 * A user turn is the run of background-filled rows the agent's input box left
 * on screen. Padding rows at either end are dropped; a run that is too long to
 * be one message is not a message at all and is left to prose.
 *
 * Every row has to be a filled band (`isBandRow`). That is what keeps an
 * answer paragraph carrying an inline code chip from opening a turn, and it
 * also stops such a prose row from being folded into the message before it:
 * the chip's fill covers a few glyphs, a band's fill covers the row.
 */
function readUserBand(lines: Line[], start: number, groups: Map<number, BoxGroup>): { text: string; end: number } | null {
  const parts: string[] = [];
  let index = start;
  while (index < lines.length) {
    if (groups.has(index)) {
      break;
    }
    const line = lines[index];
    // Every row of a band is filled edge to edge. A row that only carries a
    // chip (an inline code mention in prose) is not a continuation line, so it
    // ends the run instead of joining it.
    if (!isBandRow(line)) {
      break;
    }
    if (isEmptyLine(line)) {
      index += 1;
      continue;
    }
    if (isChrome(line)) {
      break;
    }
    const text = stripPromptEcho(textOf(line));
    if (BOX_EDGE_RE.test(text)) {
      break;
    }
    if (italicShare(line) >= 0.5) {
      break;
    }
    parts.push(text);
    index += 1;
  }
  if (parts.length === 0 || parts.length > 24) {
    return null;
  }
  return { text: joinUserLines(parts), end: index };
}

/* ------------------------------------------------------------------ boxes */

const BOX_OPENER_RE = /^\+-{3,}/;
/**
 * A box row starts at its left border. Agents draw that border with `|`, `│`,
 * `╎` or `┆`; a diff inside the box then reads `|+12│`, `| 34│` or `|-5│`.
 * Herdr's `pane.read` returns a fixed window of scrollback, so the top of a
 * snapshot regularly starts *inside* a box: the opener (and its title) are
 * above the window and never arrive. Those rows are still box body — never
 * user text — no matter how the window was cut.
 *
 * This glyph rule is the *only* discriminant available, and it must stay a
 * glyph rule because the background colour cannot tell the two apart: omp
 * paints box bodies and user-message bands with the identical
 * `48;2;15;18;22`, and so does pi (measured in omp's `w6:p3` and pi's
 * `w2T:p1` captures, hundreds of body rows and a handful of user rows, same
 * RGB in both). Colour-based detection would therefore either swallow user
 * turns into work or promote box interiors to user text. The border glyph is
 * what actually means "inside a box"; keep the first-visible-character test.
 */
const BOX_EDGE_RE = /^[|│╎┆]/;
const BOX_RULE_RE = /^\+-{3,}/;
const BOX_TITLED_RE = /^\+-{3,}\s+(.+?)\s+-{3,}\+?$/;
const BOX_TITLED_LOOSE_RE = /^\+-{3,}\s+(.+?)\+?$/;
const BOX_BARE_RE = /^\+-+\+?$/;
const BOX_DASH_RE = /^-{3,}$/;

type BoxDivider = { title: string | null };

function acceptTitle(raw: string): BoxDivider | null {
  let title = raw.trim();
  if (title === "") {
    return null;
  }
  // `[+3]` / `[+12/-4]` is a diff stat, not table structure.
  title = title.replace(/\s*\[\+\d+(?:\s*\/\s*-\d+)?\]\s*$/, "").trim();
  if (title === "") {
    return null;
  }
  // A `+` left in the middle means this is an ASCII table row, not a box
  // header. The leading `+f`/`+a` marker some agents print is not that.
  if (title.replace(/^[+~$]\w*\s+/, "").includes("+")) {
    return null;
  }
  return { title };
}

function dividerInfo(text: string): BoxDivider | null {
  if (BOX_OPENER_RE.test(text)) {
    const titled = BOX_TITLED_RE.exec(text);
    if (titled !== null) {
      const accepted = acceptTitle(titled[1]);
      if (accepted !== null) {
        return accepted;
      }
    }
    const loose = BOX_TITLED_LOOSE_RE.exec(text);
    if (loose !== null) {
      const accepted = acceptTitle(loose[1]);
      if (accepted !== null) {
        return accepted;
      }
    }
    if (BOX_BARE_RE.test(text) || BOX_DASH_RE.test(text)) {
      return { title: null };
    }
    return null;
  }
  if (BOX_DASH_RE.test(text)) {
    return { title: null };
  }
  return null;
}

function isBoxBody(text: string): boolean {
  return BOX_EDGE_RE.test(text);
}

function stripBoxBody(text: string): string {
  let body = text;
  if (body.startsWith("|") || body.startsWith("│")) {
    body = body.slice(1);
  }
  if (body.startsWith(" ")) {
    body = body.slice(1);
  }
  if (/\s\|$/.test(body)) {
    body = body.slice(0, -1);
  }
  return body.replace(/\s+$/, "");
}

function isBoxChrome(body: string): boolean {
  if (body === "") {
    return false;
  }
  if (/\[Backgrounded:/i.test(body)) {
    return true;
  }
  if (/\[Ctrl\+O/.test(body)) {
    return true;
  }
  return /^…\s*\(?\d+\s+(?:earlier|more|lines?)/i.test(body);
}

function isOutputTitle(title: string): boolean {
  return /^(?:output|stdout|stderr|result|results|error output|stderr output)\b/i.test(title.trim());
}

/** Cap on the body lines an orphan box may contribute to one work row. */
const ORPHAN_DETAIL_LIMIT = 120;

/**
 * Read a run of background-filled rows that belong to a box whose opener was
 * cut off by the top of the window. Only rows whose first visible character is
 * a box border count, which is also what keeps a real user band (same
 * background colour, no border glyph) out of this path.
 */
function readOrphanBoxRun(
  lines: Line[],
  start: number,
  groups: Map<number, BoxGroup>,
): { body: string[]; end: number } | null {
  const body: string[] = [];
  let sawEdge = false;
  let index = start;
  while (index < lines.length) {
    if (groups.has(index)) {
      break;
    }
    const line = lines[index];
    if (!hasBackground(line)) {
      break;
    }
    const text = textOf(line);
    if (text === "") {
      index += 1;
      continue;
    }
    if (BOX_RULE_RE.test(text)) {
      index += 1;
      continue;
    }
    if (!BOX_EDGE_RE.test(text)) {
      break;
    }
    sawEdge = true;
    const stripped = stripBoxBody(text);
    if (stripped !== "" && !isBoxChrome(stripped)) {
      body.push(stripped);
    }
    index += 1;
  }
  if (!sawEdge) {
    return null;
  }
  return { body, end: index };
}

type BoxSection = { title: string | null; body: string[] };
type BoxGroup = { start: number; end: number; rows: WorkRow[] };

/**
 * Read one ASCII box starting at `start`. Returns null when the shape is prose
 * (an ASCII table, a horizontal rule, a quoted block) rather than a tool call.
 */
function parseBoxAt(lines: Line[], start: number): BoxGroup | null {
  const opener = dividerInfo(textOf(lines[start]));
  if (opener === null) {
    return null;
  }
  const sections: BoxSection[] = [{ title: opener.title, body: [] }];
  let index = start + 1;
  while (index < lines.length) {
    const text = textOf(lines[index]);
    if (isBoxBody(text)) {
      const body = stripBoxBody(text);
      if (body !== "" && !isBoxChrome(body)) {
        sections[sections.length - 1].body.push(body);
      }
      index += 1;
      continue;
    }
    if (text === "" || isPadding(text)) {
      let probe = index + 1;
      while (probe < lines.length && (textOf(lines[probe]) === "" || isPadding(textOf(lines[probe])))) {
        probe += 1;
      }
      if (probe >= lines.length) {
        break;
      }
      const next = textOf(lines[probe]);
      const nextIsBody = isBoxBody(next) || dividerInfo(next) !== null;
      const hasBody = sections.some((section) => section.body.length > 0);
      if (!nextIsBody || !hasBody) {
        break;
      }
      sections[sections.length - 1].body.push("");
      index += 1;
      continue;
    }
    const divider = dividerInfo(text);
    if (divider === null) {
      break;
    }
    if (divider.title === null) {
      index += 1;
      break;
    }
    if (isOutputTitle(divider.title)) {
      sections.push({ title: "output", body: [] });
      index += 1;
      continue;
    }
    break;
  }

  if (sections[0].title === null) {
    const firstBody = sections[0].body[0] ?? "";
    const titledSection = sections.some((section) => section.title !== null);
    if (!firstBody.startsWith("$") && !titledSection) {
      return null;
    }
  }
  const hasAnyBody = sections.some((section) => section.body.length > 0);
  if (!hasAnyBody) {
    return null;
  }
  return { start, end: index, rows: rowsFromSections(sections) };
}

const LANG_TAGS = new Set([
  "go",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "md",
  "rs",
  "java",
  "kt",
  "sh",
  "css",
  "html",
  "json",
  "yaml",
  "yml",
  "c",
  "cc",
  "cpp",
  "rb",
  "php",
  "swift",
  "toml",
  "sql",
]);

function stripLangTag(text: string): string {
  const tokens = text.split(/\s+/);
  if (tokens.length < 2 || tokens[0].includes("/")) {
    return text;
  }
  if (!LANG_TAGS.has(tokens[0].toLowerCase())) {
    return text;
  }
  return tokens.slice(1).join(" ");
}

function capitalise(word: string): string {
  if (word === "") {
    return word;
  }
  return word[0].toUpperCase() + word.slice(1);
}

/** Normalise a box title into one quiet row title. */
function cleanBoxTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^[+~$]\w*\s+/, "");
  const marker = /^(?:\[[^\]]*\]|[⏺✓✔✗⨯✘●])\s*/.exec(title);
  if (marker !== null) {
    title = title.slice(marker[0].length);
  }
  title = title.replace(/\s*·\s*\d+\s+lines?\s*$/i, "");
  title = title.replace(/\s*\[\+\d+(?:\s*\/\s*-\d+)?\]\s*$/, "");
  title = title.replace(/\s*\[-\d+\]\s*$/, "");
  const verbed = /^(write|edit|patch|create|read|view|apply|delete|move|rename|update|append)\s*:\s*(.+)$/i.exec(title);
  if (verbed !== null) {
    title = `${capitalise(verbed[1].toLowerCase())} ${stripLangTag(verbed[2].trim())}`;
  }
  return title.replace(/\s+/g, " ").trim();
}

function tidyDetail(body: string[]): string[] {
  const detail = body.slice();
  while (detail.length > 0 && detail[detail.length - 1] === "") {
    detail.pop();
  }
  while (detail.length > 0 && detail[0] === "") {
    detail.shift();
  }
  return detail;
}

function rowsFromSections(sections: BoxSection[]): WorkRow[] {
  const primary = sections[0];
  let title: string;
  let kind: WorkKind;
  const detail: string[] = [];
  if (primary.title === null) {
    // An untitled box is a command: the `$` line is the title, the rest is its
    // output. Joining them would turn the whole box into one long title.
    const body = primary.body.filter((text) => text !== "");
    const command = (body[0] ?? "").replace(/^\$\s*/, "").trim();
    title = command === "" ? "Command" : command;
    kind = "command";
    detail.push(...body.slice(1));
  } else {
    const cleaned = cleanBoxTitle(primary.title);
    kind = classifyRow(cleaned);
    title = cleaned === "" ? "Tool" : cleaned;
    detail.push(...primary.body);
  }
  for (const section of sections.slice(1)) {
    if (section.body.length === 0) {
      continue;
    }
    if (section.title === null || isOutputTitle(section.title)) {
      detail.push(...section.body);
    } else {
      detail.push(section.title, ...section.body);
    }
  }
  return [{ kind, title, detail: tidyDetail(detail) }];
}

function boxGroups(lines: Line[]): Map<number, BoxGroup> {
  const groups = new Map<number, BoxGroup>();
  let index = 0;
  while (index < lines.length) {
    if (!BOX_OPENER_RE.test(textOf(lines[index]))) {
      index += 1;
      continue;
    }
    const group = parseBoxAt(lines, index);
    if (group === null) {
      index += 1;
      continue;
    }
    groups.set(index, group);
    index = group.end;
  }
  return groups;
}

/* ------------------------------------------------------------- tool rows */

const GLYPH_CHARS = "⏺✓✔✗⨯✘●";
const ROW_BADGE_RE = new RegExp(
  `^(\\[(?:x|X| |\\*|!!|ok|done|failed|error|running|waiting|pending)\\]|[${GLYPH_CHARS}])\\s+(.*)$`,
);
const FAILED_BADGES = new Set(["!!", "✗", "⨯", "✘"]);

const EDIT_RE =
  /\b(?:patched|patches|patch|wrote|write|writes|written|edit|edits|edited|modified|modifies|created|create|deleted|delete|removed|remove|renamed|renames|moved|move|applied|apply)\b/i;
const READ_RE =
  /\b(?:read|reads|viewed|view|opened|open|inspected|inspect|listed|list|searched|search|grepped|grep|globbed|glob|scanned|scan)\b/i;
const COMMAND_RE =
  /(?:^|\s)(?:\$|python3?|node|npm|npx|pnpm|yarn|bun|deno|go|git|cargo|rustc|make|bash|sh|zsh|docker|podman|kubectl|curl|wget|sed|awk|tsc|vite|vitest|jest|pytest|mkdir|rmdir|chmod|chown|tar|zip|ssh|scp)\b|&&|\|\||Running in shell|<<'/i;

/** Which of the four folded kinds a tool row belongs to. */
function classifyRow(title: string): WorkKind {
  if (title.trim() === "") {
    return "other";
  }
  if (EDIT_RE.test(title)) {
    return "edit";
  }
  if (READ_RE.test(title)) {
    return "read";
  }
  if (COMMAND_RE.test(title)) {
    return "command";
  }
  return "other";
}

function isPathRef(title: string): boolean {
  // `server/run.go:1-90` on its own is a file read, not an action.
  return /^(?:\.{0,2})?(?:\/[\w.+@-]+)*(?:[\w.+@-]+)?\/[\w.+@-]+:\d+(?:\s*-\s*\d+)?$/.test(title) ||
    /^[\w.+@-]+(?:\.[\w]+)?:\d+(?:\s*-\s*\d+)?$/.test(title) && title.includes("/");
}

function isTodoRow(title: string): boolean {
  return /\btodo\b/i.test(title);
}

function isPathOnlyTitle(title: string): boolean {
  // A bare cwd after a bullet is shell furniture, not a step.
  if (/^(?:~|\.{1,2})?(?:\/[\w.+@-]+)+\/?$/.test(title)) {
    return true;
  }
  return /^[A-Za-z]:\\/.test(title);
}

function rowTitleFor(kind: WorkKind, title: string): string {
  if ((kind === "edit" || kind === "read") && !EDIT_RE.test(title) && !READ_RE.test(title)) {
    return stripLangTag(title);
  }
  return title;
}

function tidyDurationSuffix(text: string): string {
  const match = /(?:\s+[-–·]\s+)(\d[0-9hms.]*(?:\s+\d+[hms])*)$/.exec(text);
  if (match === null) {
    return text;
  }
  const seconds = parseDuration(match[1].replace(/\s+/g, " ").trim());
  if (seconds === null) {
    return text;
  }
  return `${text.slice(0, match.index).trimEnd()} · ${formatDuration(seconds)}`;
}

function tidyJobTitle(text: string): string {
  const title = text
    .replace(/^'--\s*\*?\s*/, "")
    .replace(/^\*\s+/, "")
    .trim();
  return tidyDurationSuffix(title);
}

function continuationText(line: Line): string | null {
  const text = line.plain;
  const tree = /^\s*[│└├]\s?(.*)$/.exec(text);
  if (tree !== null) {
    return tree[1].trim();
  }
  if (/^\s{2,}\S/.test(text)) {
    return text.trim();
  }
  return null;
}

function isRowMarker(text: string): boolean {
  if (ROW_BADGE_RE.test(text)) {
    return true;
  }
  if (/^Esc\s+/.test(text)) {
    return true;
  }
  if (/^\*\s+Background job\b/i.test(text)) {
    return true;
  }
  return /^'--\s/.test(text);
}

function detailAfter(lines: Line[], start: number, groups: Map<number, BoxGroup>): { detail: string[]; end: number } {
  const detail: string[] = [];
  let index = start;
  while (index < lines.length && detail.length < 40) {
    if (groups.has(index)) {
      break;
    }
    const line = lines[index];
    const text = textOf(line);
    if (text === "") {
      let probe = index + 1;
      while (probe < lines.length && textOf(lines[probe]) === "") {
        probe += 1;
      }
      if (probe >= lines.length) {
        break;
      }
      const next = continuationText(lines[probe]);
      if (next === null) {
        break;
      }
      detail.push("");
      index += 1;
      continue;
    }
    if (isChrome(line) || hasBackground(line) || isReasoningLine(line)) {
      break;
    }
    if (isRowMarker(text) || recapText(text) !== null) {
      break;
    }
    const candidate = continuationText(line);
    if (candidate === null) {
      break;
    }
    detail.push(candidate);
    index += 1;
  }
  while (detail.length > 0 && detail[detail.length - 1] === "") {
    detail.pop();
  }
  return { detail, end: index };
}

type MarkerRow = { row: WorkRow; end: number };

/** Read a glyph/bracket tool row (with its indented continuation lines). */
function readRow(lines: Line[], start: number, groups: Map<number, BoxGroup>): MarkerRow | null {
  const text = textOf(lines[start]);
  if (text === "") {
    return null;
  }
  const spinner = /^Esc\s+(.+)$/.exec(text);
  if (spinner !== null) {
    const label = spinner[1].trim();
    if (/^to\b/i.test(label) || label === "") {
      return null;
    }
    const continuation = detailAfter(lines, start + 1, groups);
    return { row: { kind: "other", title: label, detail: continuation.detail }, end: continuation.end };
  }
  if (/^\*\s+Background job\b/i.test(text) || /^'--\s/.test(text)) {
    const continuation = detailAfter(lines, start + 1, groups);
    return { row: { kind: "other", title: tidyJobTitle(text), detail: continuation.detail }, end: continuation.end };
  }
  const badge = ROW_BADGE_RE.exec(text);
  if (badge === null) {
    return null;
  }
  const body = badge[2].trim();
  if (body === "" || isPathOnlyTitle(body)) {
    return null;
  }
  const kind = isTodoRow(body) ? "other" : isPathRef(body) ? "read" : classifyRow(body);
  const title = rowTitleFor(kind, body).replace(/\s+Running in shell \w+$/i, "");
  const failed = FAILED_BADGES.has(badge[1]) || FAILED_BADGES.has(badge[1].slice(1, -1));
  const continuation = detailAfter(lines, start + 1, groups);
  return {
    row: { kind, title: failed ? `${title} · failed` : title, detail: continuation.detail },
    end: continuation.end,
  };
}

/* ----------------------------------------------------------------- blocks */

type Block =
  | { kind: "user"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "work"; rows: WorkRow[] }
  | { kind: "answer"; text: string }
  | { kind: "recap"; text: string };

/**
 * Orphan box body becomes a work row rather than prose: it is tool output the
 * agent printed, so it belongs under work. When the previous block is already
 * work, the body extends that row's detail (the opener may simply have been
 * filtered out); otherwise it stands alone as an `other` row.
 */
function appendOrphanBox(blocks: Block[], body: string[]): void {
  if (body.length === 0) {
    return;
  }
  const lines = body.slice(0, ORPHAN_DETAIL_LIMIT);
  const previous = blocks[blocks.length - 1];
  if (previous !== undefined && previous.kind === "work" && previous.rows.length > 0) {
    const row = previous.rows[previous.rows.length - 1];
    const room = ORPHAN_DETAIL_LIMIT - row.detail.length;
    if (room > 0) {
      row.detail.push(...lines.slice(0, room));
      return;
    }
  }
  blocks.push({ kind: "work", rows: [{ kind: "other", title: "Earlier output", detail: lines }] });
}

function buildBlocks(lines: Line[], groups: Map<number, BoxGroup>): Block[] {
  const blocks: Block[] = [];
  let answer: string[] = [];
  let thought: string[] = [];

  const flushAnswer = (): void => {
    if (answer.length > 0) {
      blocks.push({ kind: "answer", text: answer.join("\n") });
      answer = [];
    }
  };
  const flushThought = (): void => {
    if (thought.length > 0) {
      blocks.push({ kind: "thought", text: thought.join("\n") });
      thought = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const group = groups.get(index);
    if (group !== undefined) {
      flushAnswer();
      flushThought();
      blocks.push({ kind: "work", rows: group.rows });
      index = group.end;
      continue;
    }
    const line = lines[index];
    const text = textOf(line);
    if (text === "") {
      flushThought();
      if (answer.length > 0) {
        answer.push("");
      }
      index += 1;
      continue;
    }
    if (isChrome(line)) {
      index += 1;
      continue;
    }
    if (hasBackground(line)) {
      // A box rule (`+---+`) with no consumed opener is a border left over by a
      // window cut or a box this reader rejected; it is never a user message.
      if (BOX_RULE_RE.test(text)) {
        index += 1;
        continue;
      }
      if (BOX_EDGE_RE.test(text)) {
        const orphan = readOrphanBoxRun(lines, index, groups);
        if (orphan !== null) {
          flushAnswer();
          flushThought();
          appendOrphanBox(blocks, orphan.body);
          index = orphan.end;
          continue;
        }
      }
      const band = readUserBand(lines, index, groups);
      if (band !== null) {
        flushAnswer();
        flushThought();
        blocks.push({ kind: "user", text: band.text });
        index = band.end;
        continue;
      }
    }
    const recap = recapText(text);
    if (recap !== null) {
      flushAnswer();
      flushThought();
      blocks.push({ kind: "recap", text: recap });
      index += 1;
      continue;
    }
    if (isReasoningLine(line)) {
      flushAnswer();
      thought.push(text);
      index += 1;
      continue;
    }
    flushThought();
    const row = readRow(lines, index, groups);
    if (row !== null) {
      flushAnswer();
      blocks.push({ kind: "work", rows: [row.row] });
      index = row.end;
      continue;
    }
    answer.push(text);
    index += 1;
  }
  flushAnswer();
  flushThought();
  return blocks;
}

/* ------------------------------------------------------------------ turns */

function joinBlocks(parts: string[]): string {
  return parts
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendAnswer(state: ChatTurn, text: string): void {
  state.answer = state.answer === "" ? text.trim() : joinBlocks([state.answer, text]);
}

function foldTurns(blocks: Block[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  const fresh = (user: string | null): ChatTurn => ({
    id: `turn-${turns.length}`,
    user,
    thoughts: [],
    work: [],
    answer: "",
    recap: null,
  });
  const ensure = (): ChatTurn => {
    if (current === null) {
      current = fresh(null);
      turns.push(current);
    }
    return current;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "user": {
        current = fresh(block.text);
        turns.push(current);
        break;
      }
      case "thought": {
        ensure().thoughts.push(block.text.trim());
        break;
      }
      case "work": {
        ensure().work.push(...block.rows);
        break;
      }
      case "answer": {
        appendAnswer(ensure(), block.text);
        break;
      }
      case "recap": {
        ensure().recap = block.text;
        break;
      }
    }
  }

  const first = turns[0];
  if (turns.length > 1 && first !== undefined && first.user === null) {
    const hasContent =
      first.answer !== "" || first.thoughts.length > 0 || first.work.length > 0 || first.recap !== null;
    if (!hasContent) {
      turns.shift();
    }
  }
  for (let index = 0; index < turns.length; index += 1) {
    turns[index].id = `turn-${index}`;
  }
  return turns;
}

/* ------------------------------------------------------------ entry point */

function plainConversation(text: string): Conversation {
  const cleaned = text
    .split("\n")
    .map((line) => parseSpans(line).map((span) => span.text).join(""))
    .join("\n")
    .trim();
  const turns: ChatTurn[] = [];
  if (cleaned !== "") {
    turns.push({ id: "turn-0", user: null, thoughts: [], work: [], answer: cleaned, recap: null });
  }
  return { turns, lines: text === "" ? 0 : text.split("\n").length };
}

/**
 * Turn one `pane.read` snapshot into the quiet chat document.
 *
 * Never throws: a snapshot it cannot read degrades to the stripped text as a
 * single answer, because losing structure is better than losing the words.
 */
/**
 * The word beside the dot on the live turn.
 *
 * herdr reports the agent's state; the transcript shows it. Only one word needs
 * translating: a blocked agent is not working, it is waiting for the operator,
 * and calling that "running" reads as a stall that will never end.
 */
export function statusWord(status: string | null): string {
  if (status === null || status === "") {
    return "unknown";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return status === "working" ? "running" : status;
}

export function deriveConversation(text: string): Conversation {
  if (text === "") {
    return { turns: [], lines: 0 };
  }
  const rawLines = text.split("\n");
  const lines = rawLines.map(readLine);
  const lineCount = rawLines.length - (text.endsWith("\n") ? 1 : 0);
  try {
    const groups = boxGroups(lines);
    const blocks = buildBlocks(lines, groups);
    return { turns: foldTurns(blocks), lines: lineCount };
  } catch {
    return plainConversation(text);
  }
}



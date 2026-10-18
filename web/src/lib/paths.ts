/*
 * The file paths an agent mentions, and what is behind them.
 *
 * The transcript is plain text — Scope.tsx runs it through stripAnsi first —
 * so a path arrives as prose: "wrote /tmp/chart.png (12 KB)". Finding it is
 * only about boundaries, because the path itself is short and unambiguous;
 * every rule here exists to keep prose such as `and/or` or `2/3` out.
 *
 * Reading goes through the bridge, which owns the filesystem: the browser
 * never touches a path itself, and it cannot resolve `~`, which is the
 * shell's shorthand on the machine running the pane.
 */

export type PathMatch = { start: number; end: number; path: string };

/*
 * What a path may contain. `/` is here because a path is a sequence of
 * segments — without it `/a/b` would stop at `/a`. `(` and `)` are here for
 * names such as `report(final)`; the closing paren is only kept when the path
 * opened it. `,`, `;`, quotes and brackets are deliberately absent: they are
 * the punctuation around a path, never part of one.
 */
const SEGMENT = "[A-Za-z0-9._@+%:=\\-()/]";

/*
 * A path starts at `~` or `/` and never directly after a word character or
 * another slash. That single lookbehind is what rejects `and/or`, `2/3`, a
 * relative path and the middle of a URL. `path:/tmp/x` is still a path, so a
 * colon is not a boundary. `//` is refused outright, which is what keeps the
 * `https://x/y` scheme separator from starting a match.
 */
const PATH_RE = new RegExp(`(?<![A-Za-z0-9._~\\/])(?:~\\/|\\/(?!\\/))${SEGMENT}+`, "g");

/*
 * Shortest match worth reporting. `/x` is two characters: too little to tell
 * a file from prose, and the spec of a path is at least one character after
 * the leading slash plus something to recognise. `/a/b` clears it, `~/x` too.
 */
const MIN_PATH_LENGTH = 3;

/* Trailing punctuation belongs to the sentence, not to the file name. A
   trailing slash is a directory marker, so it goes as well. */
const TRAILING = new Set([".", ",", ";", ":", ")", "]", "}", '"', "'", "/"]);

/** Index of the outermost `(` that never closes, or -1 when all of them do. */
function unmatchedOpen(text: string): number {
  let depth = 0;
  let first = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      if (depth === 0) {
        first = index;
      }
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        first = -1;
      }
    }
  }
  return depth > 0 ? first : -1;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const value of text) {
    if (value === char) {
      count += 1;
    }
  }
  return count;
}

/**
 * Cut the prose off the end of a candidate. Trimming happens after the whole
 * run was matched because the answer depends on it: `)` is part of the name
 * only when the candidate also contains the `(` that opened it.
 */
function trimTrailing(candidate: string): string {
  let text = candidate;
  // An opening paren with no partner starts a remark, not a name:
  // `chart.png(12 KB)` is a chart, not a file called `chart.png(12`.
  const open = unmatchedOpen(text);
  if (open !== -1) {
    text = text.slice(0, open);
  }
  while (text.length > 0 && TRAILING.has(text[text.length - 1])) {
    if (text[text.length - 1] === ")" && countChar(text, "(") >= countChar(text, ")")) {
      break;
    }
    text = text.slice(0, -1);
  }
  return text;
}

/** Absolute and ~-rooted paths in one line of plain text, in order. */
export function findPaths(text: string): PathMatch[] {
  const matches: PathMatch[] = [];
  // The regex is shared and stateful; a caller must never see a stale cursor.
  PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_RE.exec(text)) !== null) {
    const path = trimTrailing(match[0]);
    if (path.length < MIN_PATH_LENGTH) {
      continue;
    }
    matches.push({ start: match.index, end: match.index + path.length, path });
  }
  return matches;
}

/**
 * Replace a leading `~` with a home directory when one is known. The browser
 * cannot know the herdr host's home, so without `home` the path comes back
 * unchanged and the caller refuses it rather than inventing a directory that
 * only exists on the server.
 */
export function expandHome(path: string, home?: string): string {
  if (home === undefined || home === "") {
    return path;
  }
  const base = home.replace(/\/+$/, "");
  if (path === "~") {
    return base;
  }
  return path.startsWith("~/") ? `${base}${path.slice(1)}` : path;
}

function isTildePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

export type FileMeta =
  | { kind: "image"; path: string; name: string; bytes: number }
  | { kind: "text"; path: string; name: string; bytes: number; text: string; truncated: boolean }
  | { kind: "other"; path: string; name: string; bytes: number }
  | { kind: "missing"; path: string }
  | { kind: "error"; path: string; message: string };

const FILE_ENDPOINT = "/api/v1/herdr/file";
const RAW_ENDPOINT = "/api/v1/herdr/file/raw";

/** The bytes of an image, for an `img` element. */
export function rawFileUrl(path: string): string {
  return `${RAW_ENDPOINT}?path=${encodeURIComponent(path)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The last segment of a path, for a title while the bridge has not answered. */
function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name === "" ? path : name;
}

/** The bridge's response, narrowed to the union the panel renders. */
function parseFileMeta(payload: unknown, requested: string): FileMeta {
  const record = asRecord(payload);
  if (record === null) {
    return { kind: "error", path: requested, message: "unexpected response from the bridge" };
  }
  const path = asString(record.path, requested);
  const name = asString(record.name, baseName(path));
  const bytes = asNumber(record.bytes);
  if (record.kind === "image") {
    return { kind: "image", path, name, bytes };
  }
  if (record.kind === "text") {
    return {
      kind: "text",
      path,
      name,
      bytes,
      text: typeof record.text === "string" ? record.text : "",
      truncated: record.truncated === true,
    };
  }
  if (record.kind === "other") {
    return { kind: "other", path, name, bytes };
  }
  // A 200 the contract does not describe is broken, not a binary file.
  return { kind: "error", path: requested, message: "unexpected response from the bridge" };
}

/**
 * Read a file's metadata through the bridge. A missing file is a normal
 * answer here: herdr can run panes on another machine over SSH, so a path
 * from the transcript legitimately exists only over there.
 */
export async function fetchFileMeta(path: string): Promise<FileMeta> {
  const full = expandHome(path);
  // The endpoint takes an absolute path and the browser cannot know the home
  // directory of the machine running the pane, so `~` is refused, not guessed.
  if (isTildePath(full)) {
    return {
      kind: "error",
      path: full,
      message: "~ cannot be expanded: the browser does not know the server's home directory",
    };
  }
  let response: Response;
  try {
    response = await fetch(`${FILE_ENDPOINT}?path=${encodeURIComponent(full)}`, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    return {
      kind: "error",
      path: full,
      message: error instanceof Error && error.message !== "" ? error.message : "network error",
    };
  }
  if (response.status === 404) {
    return { kind: "missing", path: full };
  }
  if (!response.ok) {
    return { kind: "error", path: full, message: `HTTP ${response.status}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "error", path: full, message: "unexpected response from the bridge" };
  }
  return parseFileMeta(payload, full);
}

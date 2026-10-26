/*
 * Agent status vocabulary. The daemon reports free-form status strings, so
 * they are mapped once, here, and the rest of the UI only ever sees a Tone.
 */

export type Tone = "blocked" | "working" | "done" | "idle";

/** Order groups appear in the ledger: what needs a human comes first. */
export const TONE_ORDER: Tone[] = ["blocked", "working", "idle", "done"];

export const TONE_LABEL: Record<Tone, string> = {
  blocked: "needs input",
  working: "working",
  idle: "idle",
  done: "finished",
};

/** One-glyph form for the horizontal ledger on narrow screens. */
export const TONE_CODE: Record<Tone, string> = {
  blocked: "!",
  working: "~",
  idle: "·",
  done: "✓",
};

export function toneOf(status: string | undefined | null): Tone {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "blocked" || value === "needs input" || value === "waiting") {
    return "blocked";
  }
  if (value === "working" || value === "running" || value === "busy") {
    return "working";
  }
  if (value === "done" || value === "finished" || value === "complete") {
    return "done";
  }
  return "idle";
}

/**
 * The words `toneOf` maps on purpose. Everything else the daemon might send is
 * a status the UI has never seen, and is printed as sent rather than folded
 * into a tone: "error" and "paused" are not "idle", and a header that calls
 * them idle is telling the operator something untrue.
 */
const KNOWN_STATUS: Record<string, true> = {
  "": true,
  idle: true,
  blocked: true,
  "needs input": true,
  waiting: true,
  working: true,
  running: true,
  busy: true,
  done: true,
  finished: true,
  complete: true,
};

/** The status as one lowercased word run, the form the maps are keyed on. */
function statusWords(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isKnownStatus(status: string | null | undefined): boolean {
  return KNOWN_STATUS[statusWords(status)] === true;
}

/**
 * Clip a status to `max` characters. A status is a phrase, so the cut lands on
 * a word boundary rather than in the middle of one, as long as that does not
 * throw most of the budget away.
 */
function clip(word: string, max: number): string {
  if (word.length <= max) {
    return word;
  }
  const cut = word.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space >= Math.floor(max / 2) ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

/**
 * The status printed in prose, beside the stage title. Known words get their
 * canonical label; anything else is passed through so an unrecognised status
 * still reads as itself. Clipped, because it shares a flex row with the title
 * and the working directory.
 */
export function statusLabel(status: string | null | undefined): string {
  const word = statusWords(status);
  return isKnownStatus(word) ? TONE_LABEL[toneOf(word)] : clip(word, 24);
}

/** The same status, short enough to sit in a tile header. */
export function statusChip(status: string | null | undefined): string {
  const word = statusWords(status);
  return isKnownStatus(word) ? toneOf(word) : clip(word, 12);
}

/**
 * The raw status, but only when it is one the UI does not understand. Lists
 * that show status as a colour alone use this for the tooltip, so a status the
 * colour cannot express is still reachable.
 */
export function statusNote(status: string | null | undefined): string | undefined {
  const word = statusWords(status);
  return word === "" || isKnownStatus(word) ? undefined : word;
}

export type Grouped<T> = { tone: Tone; items: T[] };

/** Bucket items by tone, preserving TONE_ORDER and dropping empty groups. */
export function groupByTone<T>(items: T[], statusOf: (item: T) => string | undefined): Grouped<T>[] {
  const buckets = new Map<Tone, T[]>();
  for (const item of items) {
    const tone = toneOf(statusOf(item));
    const bucket = buckets.get(tone);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(tone, [item]);
    }
  }
  return TONE_ORDER.filter((tone) => (buckets.get(tone)?.length ?? 0) > 0).map((tone) => ({
    tone,
    items: buckets.get(tone) ?? [],
  }));
}

/** Split pane output into lines, dropping the trailing empty line. */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Last path segment, for compact socket and cwd readouts. */
export function tailPath(value: string, segments = 1): string {
  const parts = value.split("/").filter((part) => part !== "");
  if (parts.length === 0) {
    return value;
  }
  return parts.slice(Math.max(0, parts.length - segments)).join("/");
}

/**
 * What an inactive split tile may say about its pane.
 *
 * Only the active tile reads pane output — a grid of splits would otherwise
 * pull every transcript on every poll — so a tile body has to be built from the
 * fleet snapshot alone. Two facts are worth repeating there because the header
 * cannot carry them: the directory the pane runs in (tail only; the tail is
 * what tells two checkouts of the same repo apart) and a status word the daemon
 * sent but this console does not know, which the header chip clips to twelve
 * characters. Everything else in the header stays unrepeated.
 */
export function idleTileFacts(pane: AgentPane): { cwd: string; note?: string } {
  const cwd = pane.cwd === undefined || pane.cwd === "" ? "" : tailPath(pane.cwd, 2);
  const note = statusNote(pane.agentStatus);
  return note === undefined ? { cwd } : { cwd, note };
}

type NameablePane = {
  id: string;
  label?: string;
  title?: string;
  terminalTitle?: string;
  displayAgent?: string;
  agent?: string;
};

const clean = (value: string | undefined): string => (value ?? "").trim();

/**
 * What to call a pane. herdr keeps four independent names, and the operator's
 * own rename outranks everything: it is deliberate, while a terminal title is
 * whatever the running program decided and an agent name is merely a guess at
 * what the pane is for. The pane id is the last resort because it is always
 * present and never ambiguous.
 */
export function paneName(pane: NameablePane): string {
  return (
    clean(pane.label) ||
    clean(pane.title) ||
    clean(pane.terminalTitle) ||
    clean(pane.displayAgent) ||
    clean(pane.agent) ||
    pane.id
  );
}

/**
 * The pane's own name, without falling back to the agent. The fleet list has a
 * separate column for the agent, so repeating it there would say nothing; an
 * unnamed pane is better identified by its id.
 */
export function paneOwnName(pane: NameablePane): string {
  return clean(pane.label) || clean(pane.title) || clean(pane.terminalTitle) || pane.id;
}

/** True when the pane still shows nothing but its id. */
export function paneHasName(pane: NameablePane): boolean {
  return paneName(pane) !== pane.id;
}

/** The part after the colon: short enough for a tab strip. */
export function shortPaneId(paneId: string): string {
  return paneId.split(":").pop() ?? paneId;
}

export type AgentPane = NameablePane & {
  agent?: string;
  displayAgent?: string;
  workspaceId: string;
  agentStatus?: string;
  cwd?: string;
  /** herdr's own focus, which is the operator's last intent for the pane. */
  focused?: boolean;
};

/**
 * The agent working in a pane, or "" for a plain shell. herdr detects the
 * agent itself; a workspace is only the directory and tab a pane lives in,
 * which is why the fleet is grouped and labelled by pane, not by workspace.
 */
export function paneAgent(pane: AgentPane): string {
  return clean(pane.displayAgent) || clean(pane.agent);
}

/** True when the pane carries a name of its own, rather than only its id. */
export function paneOwnHasName(pane: NameablePane): boolean {
  return (
    clean(pane.label) !== "" || clean(pane.title) !== "" || clean(pane.terminalTitle) !== ""
  );
}

/**
 * What to call a pane in the fleet list. The agent has its own column there, so
 * this never falls back to it; instead the working directory identifies the
 * pane, and the pane id is the last resort. A directory that merely repeats the
 * workspace name adds nothing and is skipped.
 */
export function paneListName(
  pane: NameablePane & { cwd?: string },
  workspaceName: string,
): string {
  if (paneOwnHasName(pane)) {
    return clean(pane.label) || clean(pane.title) || clean(pane.terminalTitle);
  }
  const directory = tailPath(clean(pane.cwd));
  if (directory !== "" && directory !== workspaceName) {
    return directory;
  }
  return pane.id;
}

/**
 * True when the name column already prints the agent, so a chip beside it would
 * say the same word twice. herdr sets a pane's terminal title to the program it
 * runs, so an agent pane nobody renamed carries "codex" as both its agent and
 * its name, and rows read "codex codex w1:p2"; the type is already said once.
 */
export function paneNameRepeatsAgent(pane: AgentPane, workspaceName: string): boolean {
  const agent = paneAgent(pane);
  if (agent === "") {
    return false;
  }
  return paneListName(pane, workspaceName).toLowerCase() === agent.toLowerCase();
}

/**
 * The name a row prints beside its agent chip. When the name would only repeat
 * the chip, the pane id is of more use: it is what the operator types at the
 * prompt, and it is what the tile header falls back to as well.
 */
export function paneRowName(pane: AgentPane, workspaceName: string): string {
  return paneNameRepeatsAgent(pane, workspaceName)
    ? shortPaneId(pane.id)
    : paneListName(pane, workspaceName);
}

/** A pane with its workspace's name attached, for a flat fleet listing. */
export type FleetPane = {
  pane: AgentPane;
  workspaceName: string;
};

/**
 * Group every pane in the daemon by what it needs from a human, with the
 * workspace kept as context on each row rather than as the grouping key: a
 * seven-pane workspace has one workspace status but seven panes that are
 * doing different things.
 */
export function groupFleet(
  panes: AgentPane[],
  workspaces: { id: string; name: string }[],
): Grouped<FleetPane>[] {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const rows: FleetPane[] = panes.map((pane) => ({
    pane,
    workspaceName: names.get(pane.workspaceId) ?? pane.workspaceId,
  }));
  // Stable, scannable order: a group that reshuffles between polls is what
  // makes a list feel messy even when nothing changed.
  rows.sort((left, right) => {
    const byWorkspace = left.workspaceName.localeCompare(right.workspaceName);
    if (byWorkspace !== 0) {
      return byWorkspace;
    }
    const byAgent = paneAgent(left.pane).localeCompare(paneAgent(right.pane));
    if (byAgent !== 0) {
      return byAgent;
    }
    return paneListName(left.pane, left.workspaceName).localeCompare(
      paneListName(right.pane, right.workspaceName),
    );
  });
  return groupByTone(rows, (row) => row.pane.agentStatus);
}

export type PageTheme = "light" | "dark";

/** True when an absolute colour is a dark one. Palette refs are assumed dark,
 *  which is what nearly every full-screen app paints. */
export function isDarkColour(colour: string): boolean {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
  if (match === null) {
    return true;
  }
  const luma =
    (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
  return luma <= 0.5;
}

/**
 * Which canvas mode a pane's content needs for the current page theme.
 *
 * Adapting unconditionally would be wrong in half the cases: a dark-canvas app
 * on the dark page is already correct, and inverting it would produce the very
 * mismatch this exists to remove. So the content is inverted only when its
 * canvas disagrees with the page.
 */
export function canvasModeFor(
  canvas: string | null,
  theme: PageTheme,
): "content" | "paper" | "carbon" {
  if (canvas === null) {
    // Plain output: the palette already follows the theme.
    return "content";
  }
  if (isDarkColour(canvas)) {
    return theme === "light" ? "paper" : "content";
  }
  return theme === "dark" ? "carbon" : "content";
}

/**
 * Does a pane match every whitespace-separated term? Terms are matched against
 * everything visible in the row plus the ids, so "/server" or "agy wE" both
 * work, and a term that matches nothing narrows the list to nothing.
 */
export function matchesFilter(query: string, row: { pane: AgentPane; workspaceName: string }): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) {
    return true;
  }
  const haystack = [
    row.workspaceName,
    row.pane.id,
    paneAgent(row.pane),
    paneListName(row.pane, row.workspaceName),
    paneOwnName(row.pane),
    clean(row.pane.cwd),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Filter a fleet listing, keeping it in the order groupFleet produced. */
export function filterFleet<Row extends { pane: AgentPane; workspaceName: string }>(
  rows: Row[],
  query: string,
): Row[] {
  return query.trim() === "" ? rows : rows.filter((row) => matchesFilter(query, row));
}

/**
 * Which pane to open for a workspace. One rule, used both for the initial load
 * and when a workspace is opened: whatever needs a human first, then whatever
 * herdr itself reports as focused, then simply the first pane.
 */
export function mostUrgentPane(panes: AgentPane[]): AgentPane | undefined {
  return (
    panes.find((pane) => toneOf(pane.agentStatus) === "blocked") ??
    panes.find((pane) => pane.focused === true) ??
    panes[0]
  );
}

/**
 * A flat list ordered by what a reader cares about, ignoring where each item
 * came from. Status is then carried by colour alone, so no group headers are
 * needed; the sort is stable, so items of equal tone keep herdr's own order.
 */
export function orderByTone<T>(items: T[], toneOfItem: (item: T) => Tone): T[] {
  return items
    .map((item, index) => ({ item, index, rank: TONE_ORDER.indexOf(toneOfItem(item)) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
}

/**
 * The last octet of the address a page was opened on, or "" for loopback.
 *
 * The masthead names the machine that answers: several consoles on several hosts
 * in one tailnet need "herdr(4)v0.3.1" to be told apart at a glance, while a
 * loopback page is this machine and needs no address at all.
 */
export function hostOctet(hostname: string): string {
  const host = hostname.trim();
  if (host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return "";
  }
  const parts = host.replace(/^\[|\]$/g, "").split(".");
  const last = parts[parts.length - 1];
  return /^\d+$/.test(last) ? last : host;
}

/**
 * The command that fetches a job's branch from the machine that ran it.
 *
 * A real merge across hosts is the operator's decision, not a button that
 * rewrites their repository, so this only prints the fetch. The console host is
 * the HTTP address; git needs the SSH address, which is the hostname without the
 * console's port.
 */
export function collectCommand(host: string, checkoutPath: string, branch: string): string {
  const path = checkoutPath.trim();
  if (path === "") {
    return "";
  }
  const raw = host.trim();
  let target = raw;
  try {
    target = new URL(raw).hostname;
  } catch {
    target = raw.replace(/^https?:\/\//i, "").split("/")[0];
    if (target.startsWith("[")) {
      const end = target.indexOf("]");
      if (end !== -1) {
        target = target.slice(0, end + 1);
      }
    } else {
      target = target.replace(/:\d+$/, "");
    }
  }
  const reference = branch.trim() === "" ? "HEAD" : branch.trim();
  const remote = `${target}:${path}`;
  // Paths with spaces are legal; keep the copy-pasteable command one argument.
  const quoted = /[\s'"\\$`]/.test(remote) ? `'${remote.replace(/'/g, `'\\''`)}'` : remote;
  return `git fetch ${quoted} ${reference}`;
}

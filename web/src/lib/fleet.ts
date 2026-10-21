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
 * The masthead names the daemon that answers: several consoles on several
 * machines in one tailnet need "herdr(4:0.8.2)" to be told apart at a glance,
 * while a loopback page is this machine and needs no address at all.
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

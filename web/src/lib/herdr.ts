/*
 * The only module that talks to the bridge. Everything else consumes these
 * types; nothing else calls fetch.
 */

export type HerdrStatus = {
  enabled: boolean;
  socket: string;
  status: string;
  version?: string;
  protocol?: number;
  protocolTested?: boolean;
  /** Which build of the console itself is answering. */
  consoleVersion?: string;
  error?: string;
};

export type HerdrWorkspace = {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  agentStatus?: string;
  activeTabId?: string;
  paneCount: number;
};

export type HerdrPane = {
  id: string;
  workspaceId: string;
  tabId: string;
  focused: boolean;
  cwd?: string;
  agentStatus?: string;
  /** The operator's own rename, from `herdr pane rename`. */
  label?: string;
  /** herdr's own title for the pane, distinct from the label. */
  title?: string;
  /** The OSC title the program in the pane set. */
  terminalTitle?: string;
  /** The coding agent running in the pane. */
  agent?: string;
  displayAgent?: string;
};

export type HerdrPaneRead = {
  paneId: string;
  text: string;
  revision: number;
  truncated: boolean;
  agentStatus?: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text === "" ? undefined : text;
}

async function getJSON(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return (await response.json()) as unknown;
}

async function postJSON(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const panePath = (paneId: string): string => `/api/v1/herdr/panes/${encodeURIComponent(paneId)}`;

/* ------------------------------------------------------------- parsers */

export function parseHerdrStatus(payload: unknown): HerdrStatus {
  const record = asRecord(payload) ?? {};
  return {
    enabled: record.enabled === true,
    socket: asString(record.socket),
    status: asString(record.status) || "unknown",
    version: optionalString(record.version),
    protocol: asNumber(record.protocol),
    protocolTested: record.protocolTested === true,
    // Which build of the console answered: the panel names it so two copies on
    // two hosts can be told apart.
    consoleVersion: optionalString(record.consoleVersion),
    error: optionalString(record.error),
  };
}

export function parseHerdrWorkspaces(payload: unknown): HerdrWorkspace[] {
  const record = asRecord(payload);
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.workspaces)
      ? (record.workspaces as unknown[])
      : [];
  const out: HerdrWorkspace[] = [];
  for (const item of list) {
    const workspace = asRecord(item);
    if (!workspace || asString(workspace.id) === "") {
      continue;
    }
    out.push({
      id: asString(workspace.id),
      name: asString(workspace.name) || asString(workspace.id),
      windows: asNumber(workspace.windows) ?? 0,
      attached: workspace.attached === true,
      agentStatus: optionalString(workspace.agentStatus),
      activeTabId: optionalString(workspace.activeTabId),
      paneCount: asNumber(workspace.paneCount) ?? 0,
    });
  }
  return out;
}

function parseHerdrPane(value: unknown): HerdrPane | null {
  const record = asRecord(value);
  if (!record || asString(record.id) === "") {
    return null;
  }
  return {
    id: asString(record.id),
    workspaceId: asString(record.workspaceId),
    tabId: asString(record.tabId),
    focused: record.focused === true,
    cwd: optionalString(record.cwd),
    agentStatus: optionalString(record.agentStatus),
    label: optionalString(record.label),
    title: optionalString(record.title),
    terminalTitle: optionalString(record.terminalTitle),
    agent: optionalString(record.agent),
    displayAgent: optionalString(record.displayAgent),
  };
}

export function parseHerdrPanes(payload: unknown): HerdrPane[] {
  const record = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.panes)
      ? (record.panes as unknown[])
      : [];
  const out: HerdrPane[] = [];
  for (const item of list) {
    const pane = parseHerdrPane(item);
    if (pane !== null) {
      out.push(pane);
    }
  }
  return out;
}

export function parseHerdrWorkspaceDetail(payload: unknown): {
  workspace: HerdrWorkspace | null;
  panes: HerdrPane[];
} {
  const record = asRecord(payload);
  const workspaceRecord = asRecord(record?.workspace);
  return {
    workspace: workspaceRaw(workspaceRecord),
    panes: parseHerdrPanes(record?.panes ?? []),
  };
}

function workspaceRaw(record: JsonRecord | null): HerdrWorkspace | null {
  if (!record || asString(record.id) === "") {
    return null;
  }
  const parsed = parseHerdrWorkspaces([record]);
  return parsed.length > 0 ? parsed[0] : null;
}

export function parseHerdrPaneRead(payload: unknown): HerdrPaneRead | null {
  const record = asRecord(payload);
  if (!record || asString(record.paneId) === "") {
    return null;
  }
  return {
    paneId: asString(record.paneId),
    text: asString(record.text),
    revision: asNumber(record.revision) ?? 0,
    truncated: record.truncated === true,
    agentStatus: optionalString(record.agentStatus),
  };
}

/* ----------------------------------------------------------------- IO */

export async function fetchStatus(): Promise<HerdrStatus | null> {
  try {
    return parseHerdrStatus(await getJSON("/api/v1/herdr/status"));
  } catch {
    return null;
  }
}

/**
 * Workspaces, or null when herdr could not be reached. Null is not the same as
 * empty: an empty answer means the daemon is up and has nothing, while null
 * means it is restarting and the console should keep what it already has.
 */
export async function fetchWorkspaces(): Promise<HerdrWorkspace[] | null> {
  const payload = await getJSON("/api/v1/herdr/workspaces");
  return payload === null ? null : parseHerdrWorkspaces(payload);
}

/** Rename a workspace. herdr requires a non-empty label. */
export async function renameWorkspace(workspaceId: string, label: string): Promise<boolean> {
  return postJSON(`/api/v1/herdr/workspaces/${encodeURIComponent(workspaceId)}/rename`, { label });
}

/** Every pane across every workspace, in one call. */
/** Every pane, or null when herdr could not be reached. See fetchWorkspaces. */
export async function fetchAllPanes(): Promise<HerdrPane[] | null> {
  const payload = await getJSON("/api/v1/herdr/panes");
  if (payload === null) {
    return null;
  }
  const record = asRecord(payload);
  return parseHerdrPanes(record?.panes ?? payload);
}

export async function fetchWorkspaceDetail(workspaceId: string): Promise<{
  workspace: HerdrWorkspace | null;
  panes: HerdrPane[];
}> {
  return parseHerdrWorkspaceDetail(
    await getJSON(`/api/v1/herdr/workspaces/${encodeURIComponent(workspaceId)}`),
  );
}

export const READ_LINES = 200;

export async function readPane(paneId: string, lines = READ_LINES): Promise<HerdrPaneRead | null> {
  return parseHerdrPaneRead(
    await getJSON(`${panePath(paneId)}/read?source=recent&lines=${lines}&format=ansi`),
  );
}

/**
 * Ask the visible transcript to re-read now.
 *
 * Typing is written to the daemon and the daemon draws it; waiting for the next
 * event would put that on the wire a round trip later than it needs to be. The
 * scope listens for this and reads immediately.
 */
export function pokeTranscript(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("herdr:poke"));
  }
}

/**
 * Send text to a pane. A newline is appended by default so the shell runs it;
 * pass newline=false to type without executing (shell completion).
 */
export async function sendPaneText(
  paneId: string,
  text: string,
  newline = true,
): Promise<boolean> {
  const body = !newline || text.endsWith("\n") ? text : `${text}\n`;
  const ok = await postJSON(`${panePath(paneId)}/input`, { text: body });
  pokeTranscript();
  return ok;
}

import type { PaneLayout } from "./layout";

export type Uploaded = { path: string; name: string; bytes: number };

/**
 * Send one file to the herdr host and get its absolute path there.
 *
 * herdr can only send text, so a path is the only way to hand an agent an
 * image: the agent reads the file from disk, exactly as it does when a file is
 * dragged into a terminal.
 */
export async function uploadFile(file: File): Promise<Uploaded | null> {
  const form = new FormData();
  form.append("file", file, file.name);
  try {
    const response = await fetch("/api/v1/herdr/uploads", { method: "POST", body: form });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Uploaded;
  } catch {
    return null;
  }
}

/** How a path is written into a prompt: quoted only when it needs to be. */
export function quotePath(path: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(path) ? path : `"${path.replace(/"/g, '\\"')}"`;
}

/** Parses the layout, refusing anything that is not the shape we asked for. */
export function parsePaneLayout(raw: unknown): PaneLayout | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Partial<PaneLayout>;
  if (!Array.isArray(value.panes) || typeof value.tabId !== "string") {
    return null;
  }
  return {
    tabId: value.tabId,
    workspaceId: value.workspaceId ?? "",
    zoomed: value.zoomed === true,
    area: value.area ?? { x: 0, y: 0, width: 0, height: 0 },
    focusedPaneId: value.focusedPaneId ?? "",
    panes: value.panes.filter(
      (pane) => typeof pane === "object" && pane !== null && typeof pane.id === "string",
    ),
    // A layout without edges is still usable: it just has nothing to drag.
    splits: Array.isArray(value.splits) ? value.splits : [],
  };
}

export type SplitDirection = "left" | "right" | "up" | "down";

/** POST and read the JSON body, for the calls that answer with something. */
async function postJSONResult(path: string, body: unknown): Promise<unknown> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Split a pane, which is how a new pane is made; answers with its id. */
export async function splitPane(
  paneId: string,
  direction: "right" | "down",
): Promise<string | null> {
  const raw = await postJSONResult(`${panePath(paneId)}/split`, { direction });
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as { paneId?: unknown };
  return typeof value.paneId === "string" && value.paneId !== "" ? value.paneId : null;
}

/** Close a pane and whatever is running in it. */
export async function closePane(paneId: string): Promise<boolean> {
  return postJSON(`${panePath(paneId)}/close`, {});
}

/**
 * Move one split edge. herdr ignores small amounts and moves in its own
 * increments, clamped so no pane falls below its minimum, so the caller
 * re-reads the layout afterwards rather than assuming where the edge landed.
 */
export async function resizePane(
  paneId: string,
  direction: SplitDirection,
): Promise<boolean> {
  return postJSON(`${panePath(paneId)}/resize`, { direction });
}

/** Whether a path exists on the machine this bridge runs on. */
export async function hostHas(path: string): Promise<boolean | null> {
  const raw = await getJSON(`/api/v1/herdr/host/stat?path=${encodeURIComponent(path)}`);
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as { exists?: unknown };
  return typeof value.exists === "boolean" ? value.exists : null;
}

/** How the panes of one tab are split. */
export async function fetchLayout(paneId: string): Promise<PaneLayout | null> {
  return parsePaneLayout(await getJSON(`${panePath(paneId)}/layout`));
}

/** What this machine's herdr looks like: installed, running, and up to date. */
export type HerdrHost = {
  installed: boolean;
  binary: string;
  clientVersion: string;
  channel: string;
  serverRunning: boolean;
  serverVersion: string;
  serverStatus: string;
  compatible: boolean;
  socket: string;
  restartNeeded: boolean;
  serverBinaryStale: boolean;
  installMethod: "direct" | "homebrew" | "nix" | "unknown";
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  error: string;
};

/** One command of a stop-update-start sequence, as the panel shows it. */
export type HostStep = {
  step: string;
  command: string;
  ok: boolean;
  output: string;
  exitCode: number;
  skipped?: string;
};

export type HostAction = {
  ok: boolean;
  command: string;
  output: string;
  exitCode: number;
  /** Present for update and restart: the daemon is stopped and started for you. */
  steps?: HostStep[];
};

/** The state of herdr on this host, for the console's status panel. */
export async function fetchHerdrHost(): Promise<HerdrHost | null> {
  const raw = await getJSON("/api/v1/herdr/host");
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  // The bridge omits fields it has nothing to say about (an empty error, a
  // version it could not read), so fill them in rather than rendering
  // "undefined" in the panel.
  const record = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const flag = (key: string): boolean => record[key] === true;
  return {
    installed: flag("installed"),
    binary: text("binary"),
    clientVersion: text("clientVersion"),
    channel: text("channel"),
    serverRunning: flag("serverRunning"),
    serverVersion: text("serverVersion"),
    serverStatus: text("serverStatus"),
    compatible: flag("compatible"),
    socket: text("socket"),
    restartNeeded: flag("restartNeeded"),
    serverBinaryStale: flag("serverBinaryStale"),
    installMethod: (text("installMethod") || "unknown") as HerdrHost["installMethod"],
    latestVersion: text("latestVersion"),
    updateAvailable: flag("updateAvailable"),
    canUpdate: flag("canUpdate"),
    error: text("error"),
  };
}

/** Install herdr on this host, or update it. Both run a fixed command. */
export async function runHostAction(
  action: "install" | "update" | "restart",
): Promise<HostAction | null> {
  const raw = await postJSONResult(`/api/v1/herdr/host/${action}`, {});
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  return raw as HostAction;
}

/** The console's own release identity, for the update it can apply itself. */
export type SelfRelease = {
  version: string;
  platform: string;
  sha256: string;
  source: string;
  executable: string;
};

export type SelfUpdate = {
  ok: boolean;
  updated: boolean;
  restart?: string;
  steps: { step: string; ok: boolean; detail: string; changed?: boolean }[];
  error?: string;
};

/**
 * The console's own build, straight from the console.
 *
 * It comes from here rather than from the daemon's status because the console's
 * identity does not depend on herdr answering: the masthead names the machine and
 * this build even while the daemon is down.
 */
export async function fetchSelfRelease(): Promise<SelfRelease | null> {
  const raw = await getJSON("/api/v1/herdr-web/release");
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  return raw as SelfRelease;
}

/**
 * Update the console itself.
 *
 * The bytes are compared rather than the version: whatever a source publishes is
 * an update if it differs from what is running. `from` points at a release
 * source — any running console serves one — so a host without GitHub updates
 * from a peer.
 */
export async function updateConsole(from?: string): Promise<SelfUpdate | null> {
  const raw = await postJSONResult("/api/v1/herdr-web/update", from ? { from } : {});
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  return raw as SelfUpdate;
}

/** One console in the fleet, as the hub knows it. */
export type FleetPeer = {
  id: string;
  addr: string;
  version: string;
  platform: string;
  /** Unix seconds of the last hello. */
  seen: number;
  /** True when it has not said hello recently. */
  stale: boolean;
};

export type Fleet = {
  /** True when this console is the hub itself. */
  hub: boolean;
  hubUrl: string;
  /** True when this console takes the hub's build automatically. */
  follow: boolean;
  peers: FleetPeer[];
  self: { id: string; addr: string; version: string; platform: string };
};

/**
 * The fleet this console belongs to: who else is out there and which build each
 * runs. On the hub it is the collected list; elsewhere it is the hub's answer
 * plus this console.
 */
export async function fetchFleet(): Promise<Fleet | null> {
  const raw = await getJSON("/api/v1/fleet");
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const peers = Array.isArray(record.peers)
    ? (record.peers as FleetPeer[]).filter((peer) => typeof peer?.id === "string" && peer.id !== "")
    : [];
  const self = (record.self ?? {}) as Record<string, unknown>;
  return {
    hub: record.hub === true,
    hubUrl: typeof record.hubUrl === "string" ? record.hubUrl : "",
    follow: record.follow === true,
    peers,
    self: {
      id: typeof self.id === "string" ? self.id : "",
      addr: typeof self.addr === "string" ? self.addr : "",
      version: typeof self.version === "string" ? self.version : "",
      platform: typeof self.platform === "string" ? self.platform : "",
    },
  };
}

/** A tmux session this host is running, for taking it over. */
export type TmuxSession = { name: string; windows: number; attached: number };

export type TmuxSessions = { available: boolean; sessions: TmuxSession[]; error?: string };

/** The tmux sessions on this host; herdr does not manage them, a pane can run them. */
export async function fetchTmuxSessions(): Promise<TmuxSessions | null> {
  const raw = await getJSON("/api/v1/herdr/tmux");
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const sessions = Array.isArray(record.sessions)
    ? (record.sessions as TmuxSession[]).filter(
        (session) => typeof session?.name === "string" && session.name !== "",
      )
    : [];
  return {
    available: record.available === true,
    sessions,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

/**
 * Make a workspace, and optionally run a command in its first pane.
 *
 * The command is how a tmux session that was already running is taken over: the
 * pane runs `tmux attach` and the session appears inside it.
 */
export async function createWorkspace(options: {
  label?: string;
  cwd?: string;
  command?: string[];
}): Promise<{ workspaceId: string; paneId: string; commandError?: string } | null> {
  const raw = await postJSONResult("/api/v1/herdr/workspaces", options);
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : "",
    paneId: typeof record.paneId === "string" ? record.paneId : "",
    commandError: typeof record.commandError === "string" ? record.commandError : undefined,
  };
}

/** Rename a pane; pass null to clear the name. */
export async function renamePane(paneId: string, label: string | null): Promise<boolean> {
  return postJSON(`${panePath(paneId)}/rename`, { label });
}

/** Send raw keys, e.g. ["Tab"] for shell completion. */
export async function sendPaneKeys(paneId: string, keys: string[]): Promise<boolean> {
  const ok = await postJSON(`${panePath(paneId)}/keys`, { keys });
  pokeTranscript();
  return ok;
}

/**
 * herdr's name for one typed character.
 *
 * The daemon rejects " " as a key — measured against a live session it answers
 * `invalid_key: unsupported key` — while "space" is the name it takes. Every
 * other printable character is accepted as itself.
 */
export function keyForChar(char: string): string {
  return char === " " ? "space" : char;
}

/**
 * Type text into a pane one key at a time, then Enter.
 *
 * `pane.send_text` is a paste, and a TUI that reads pasted text as literal
 * input does not open its own menus for it: measured against an agent TUI,
 * "/model" pasted does nothing while the same characters typed open the model
 * picker. Only plain ASCII is typed — a key cannot carry anything else — and
 * callers fall back to a paste for the rest.
 */
export async function typePaneText(
  paneId: string,
  text: string,
  enter = true,
): Promise<boolean> {
  const keys = Array.from(text, keyForChar);
  if (enter) {
    keys.push("Enter");
  }
  return sendPaneKeys(paneId, keys);
}

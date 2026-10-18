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

export async function fetchWorkspaces(): Promise<HerdrWorkspace[]> {
  return parseHerdrWorkspaces(await getJSON("/api/v1/herdr/workspaces"));
}

/** Every pane across every workspace, in one call. */
export async function fetchAllPanes(): Promise<HerdrPane[]> {
  const payload = await getJSON("/api/v1/herdr/panes");
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
 * Send text to a pane. A newline is appended by default so the shell runs it;
 * pass newline=false to type without executing (shell completion).
 */
export async function sendPaneText(
  paneId: string,
  text: string,
  newline = true,
): Promise<boolean> {
  const body = !newline || text.endsWith("\n") ? text : `${text}\n`;
  return postJSON(`${panePath(paneId)}/input`, { text: body });
}

/** Rename a pane; pass null to clear the name. */
export async function renamePane(paneId: string, label: string | null): Promise<boolean> {
  return postJSON(`${panePath(paneId)}/rename`, { label });
}

/** Send raw keys, e.g. ["Tab"] for shell completion. */
export async function sendPaneKeys(paneId: string, keys: string[]): Promise<boolean> {
  return postJSON(`${panePath(paneId)}/keys`, { keys });
}

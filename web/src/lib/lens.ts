/**
 * Which lens a session is read through on a narrow screen: the document
 * (chat) or the real terminal.
 *
 * A pane herdr did not report an agent in opens as a terminal: herdr says
 * `agent: ""` for a shell, and a prompt is not a conversation. That is a
 * default, not a lock. herdr only names the agents it recognises, so an agent
 * behind a wrapper, an `npm run` script or a brand-new binary arrives as a
 * shell — and at phone width its real terminal is the one view that cannot be
 * read. The switch is therefore offered for every pane, and any explicit choice
 * the operator made is remembered per pane, the same way Ovis remembers its
 * view per pane, because "this pane is always a terminal for me" is a real
 * preference and re-guessing it every time the phone reopens the console is a
 * papercut.
 */

export type Lens = "chat" | "terminal";

const PREFIX = "herdr:lens:";

/** The lens key for one pane. Kept in one place so a rename cannot silently
 *  orphan everybody's stored choice. */
export function lensKey(paneId: string): string {
  return `${PREFIX}${paneId}`;
}

/** The lens a pane should open in when nobody has chosen one yet. */
export function defaultLens(hasAgent: boolean): Lens {
  return hasAgent ? "chat" : "terminal";
}

/** The lens a pane actually opens in: an explicit per-pane choice first, the
 *  agent test only as the fallback. "No agent" is herdr failing to name the
 *  program, not proof that there is no conversation to read. */
export function resolveLens(stored: Lens | null, hasAgent: boolean): Lens {
  return stored ?? defaultLens(hasAgent);
}

/** The stored choice, if it is still a lens we render. A corrupt or outdated
 *  value must not be able to break the stage. */
export function readStoredLens(
  storage: Pick<Storage, "getItem"> | null,
  paneId: string,
): Lens | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(lensKey(paneId));
  } catch {
    return null;
  }
  return raw === "chat" || raw === "terminal" ? raw : null;
}

/** Remember the operator's choice; a full or blocked storage is not worth
 *  failing a click over. */
export function storeLens(
  storage: Pick<Storage, "setItem"> | null,
  paneId: string,
  lens: Lens,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(lensKey(paneId), lens);
  } catch {
    // Private mode and a full quota both land here. The lens still switched.
  }
}

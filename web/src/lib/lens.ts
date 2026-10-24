/**
 * Which lens a session is read through on a narrow screen: the document
 * (chat) or the real terminal.
 *
 * A pane that is not running an agent has no conversation to derive — herdr
 * reports `agent: ""` for a shell — so the terminal is the only honest lens
 * there. Any explicit choice the operator made is remembered per pane, the
 * same way Ovis remembers its view per pane, because "this pane is always a
 * terminal for me" is a real preference and re-guessing it every time the
 * phone reopens the console is a papercut.
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

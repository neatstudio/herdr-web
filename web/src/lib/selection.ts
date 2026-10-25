/**
 * Which pane the console was last reading.
 *
 * A phone reloads the page for reasons the operator did not ask for: the tab is
 * reclaimed, the app is switched to and back, the network blinks. Jumping from
 * the turn being read to whichever pane happens to be most urgent is a
 * papercut, so the last selection is remembered and restored when it still
 * exists. A pane herdr has since closed falls back to the old guess, which is
 * why the value is only a hint and never trusted blindly.
 */

const KEY = "herdr:pane";

/** The last pane read, or nothing when it was never stored or is corrupt. */
export function readStoredPane(storage: Pick<Storage, "getItem"> | null): string | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return null;
  }
  return raw === null || raw === "" ? null : raw;
}

/** Remember the pane being read; a blocked storage is not worth a failed click. */
export function storePane(storage: Pick<Storage, "setItem"> | null, paneId: string): void {
  if (storage === null || paneId === "") {
    return;
  }
  try {
    storage.setItem(KEY, paneId);
  } catch {
    // Private mode and a full quota both land here. The click still worked.
  }
}

/** The stored pane, but only while herdr still reports it. */
export function resolveStoredPane(
  stored: string | null,
  live: readonly string[],
): string | null {
  return stored !== null && live.includes(stored) ? stored : null;
}

import { useEffect, useRef, useState } from "react";

import { readPane } from "./herdr";

/** The daemon caps a single read at 2000 lines; that is the whole pane history. */
export const PANE_READ_LINES = 2000;
const FAST_MS = 400;
const IDLE_MS = 1500;
const HIDDEN_MS = 4000;

export type PaneRead = {
  /** Raw ANSI snapshot, exactly as the daemon rendered it. */
  text: string;
  lines: string[];
  revision: number;
  truncated: boolean;
  agentStatus: string | null;
  /** Epoch ms of the last successful read, 0 before the first one. */
  at: number;
  /** False once a read has failed (daemon unreachable). */
  live: boolean;
};

export const EMPTY_READ: PaneRead = {
  text: "",
  lines: [],
  revision: 0,
  truncated: false,
  agentStatus: null,
  at: 0,
  live: true,
};

function toRead(text: string, revision: number, truncated: boolean, status: string | null): PaneRead {
  return { text, lines: text.split("\n"), revision, truncated, agentStatus: status, at: Date.now(), live: true };
}

/**
 * Poll one pane's rendered scrollback.
 *
 * A herdr pane has no stream: `pane.read` re-serialises the whole visible
 * screen, so every lens polls. The chat transcript and the terminal both read
 * through this hook and decide for themselves how to present the snapshot.
 * Reads slow down while the tab is hidden, and an unchanged snapshot keeps the
 * previous object so React can bail out of the render.
 */
export function usePaneRead(paneId: string): PaneRead {
  const [read, setRead] = useState<PaneRead>(EMPTY_READ);
  const seen = useRef<{ text: string; revision: number }>({ text: "", revision: -1 });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let status: string | null = null;
    seen.current = { text: "", revision: -1 };
    setRead(EMPTY_READ);

    const schedule = (ms: number) => {
      if (alive) timer = setTimeout(tick, ms);
    };

    const tick = async (): Promise<void> => {
      if (document.visibilityState === "hidden") {
        schedule(HIDDEN_MS);
        return;
      }
      const result = await readPane(paneId, PANE_READ_LINES);
      if (!alive) return;
      if (result === null) {
        setRead((prev) => (prev.live ? { ...prev, live: false } : prev));
        schedule(IDLE_MS);
        return;
      }
      status = result.agentStatus ?? status;
      const same = result.text === seen.current.text && result.revision === seen.current.revision;
      if (same) {
        setRead((prev) => (prev.live ? prev : { ...prev, live: true }));
      } else {
        seen.current = { text: result.text, revision: result.revision };
        setRead(toRead(result.text, result.revision, result.truncated, status));
      }
      const busy = status === "working" || status === "blocked";
      schedule(busy ? FAST_MS : IDLE_MS);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [paneId]);

  return read;
}

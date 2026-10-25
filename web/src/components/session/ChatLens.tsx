import { useEffect, useMemo, useRef, useState } from "react";

import { deriveConversation } from "@/lib/conversation";
import { usePaneRead } from "@/lib/usePaneRead";
import { TurnList } from "./TurnList";

/**
 * A herdr session, read as a document instead of a terminal.
 *
 * `pane.read` hands back the ANSI snapshot of a pane's scrollback; that is the
 * only transcript herdr has. `deriveConversation` turns it into turns and work,
 * and this component renders the result. It owns no polling of its own — the
 * shared `usePaneRead` hook already decides how often to ask.
 *
 * A pane can be legitimately empty: a fresh agent, a shell prompt, a program
 * that paints later. In those cases the honest answer is a hint row that offers
 * the real terminal, not a fabricated empty chat.
 */

export type ChatLensProps = {
  paneId: string;
  /** herdr agentStatus: working | idle | blocked | done | unknown | null. */
  status: string | null;
  /** The lens switch; ChatLens only renders a hint row. */
  onOpenTerminal: () => void;
};

export function ChatLens({ paneId, status, onOpenTerminal }: ChatLensProps) {
  const read = usePaneRead(paneId);
  const conversation = useMemo(() => deriveConversation(read.text), [read.text]);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [started, setStarted] = useState<{ id: string | null; at: number }>({
    id: null,
    at: 0,
  });

  const turns = conversation.turns;
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  const live = status ?? read.agentStatus;
  const active = last !== null && (live === "working" || live === "blocked");

  // The pane snapshot has no timestamps, so the only duration available is the
  // one we observe: from the first snapshot that carried the running turn.
  useEffect(() => {
    stickyRef.current = true;
    setAtBottom(true);
    setStarted({ id: null, at: 0 });
  }, [paneId]);

  useEffect(() => {
    if (last === null || read.at <= 0) {
      return;
    }
    setStarted((current) => (current.id === last.id ? current : { id: last.id, at: read.at }));
  }, [last, read.at]);

  const seconds =
    active && started.id === last.id && started.at > 0 && read.at >= started.at
      ? (read.at - started.at) / 1000
      : null;

  // Stay pinned to the bottom while the agent is painting; let the operator
  // scroll back without being yanked forward on the next poll. The dependency
  // cannot be `read.revision`: `pane.read` carries no revision, so the hook
  // reports 0 forever and this effect would only ever run against the empty
  // lane. Key on the snapshot itself instead — every poll that changes the
  // transcript is exactly the moment to re-pin.
  useEffect(() => {
    const lane = laneRef.current;
    if (lane !== null && stickyRef.current) {
      lane.scrollTop = lane.scrollHeight;
    }
  }, [read.text, turns.length]);

  const onScroll = () => {
    const lane = laneRef.current;
    if (lane === null) {
      return;
    }
    const bottom = lane.scrollHeight - lane.scrollTop - lane.clientHeight < 48;
    stickyRef.current = bottom;
    setAtBottom(bottom);
  };

  // The lane holds a thousand lines of a session that keeps growing. Once the
  // operator scrolls back the next poll must not yank them forward, so the way
  // back is a control they press, not an effect that steals the scroll.
  const jumpToLatest = () => {
    const lane = laneRef.current;
    if (lane === null) {
      return;
    }
    stickyRef.current = true;
    setAtBottom(true);
    lane.scrollTop = lane.scrollHeight;
  };

  const empty = turns.length === 0;
  const waiting = read.text === "";
  const message = waiting ? "Waiting for the pane to paint." : "No transcript yet.";

  return (
    <div className="chat">
      <div className="chat__lane" ref={laneRef} onScroll={onScroll}>
        {empty ? (
          <div className="chat__empty">
            <p>{message}</p>
            <button type="button" onClick={onOpenTerminal}>
              Open terminal
            </button>
          </div>
        ) : (
          <TurnList
            turns={turns}
            status={live}
            at={read.at}
            truncated={read.truncated}
            seconds={seconds}
          />
        )}
        {!read.live && (
          <div className="chat__meta" data-status="unknown">
            daemon unreachable — showing the last snapshot
          </div>
        )}
      </div>
      {!atBottom && !empty && (
        <button
          type="button"
          className="chat__jump"
          onClick={jumpToLatest}
          aria-label="jump to the latest turn"
        >
          latest ↓
        </button>
      )}
    </div>
  );
}

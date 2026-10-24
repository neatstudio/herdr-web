import { useState } from "react";

import type { ChatTurn } from "@/lib/conversation";
import { Markdown } from "./Markdown";
import { WorkBlock } from "./WorkBlock";

/**
 * One user message, the work it caused, and the prose that came back.
 *
 * The rhythm is the whole design: a raised block for the operator's words, a
 * single quiet fold for everything the agent did, then plain prose. No
 * avatars, no names, no bubbles. The transcript reads as one document written
 * in two registers.
 */

export type TurnListProps = {
  turns: readonly ChatTurn[];
  /** herdr's view of the agent, used for the dot on the live turn only. */
  status: string | null;
  /** Epoch ms of the snapshot these turns were read from, 0 before the first. */
  at: number;
  truncated: boolean;
  /** Seconds the last turn has been running, or null when it is not running. */
  seconds: number | null;
};

function clock(at: number): string {
  if (at <= 0) {
    return "";
  }
  const date = new Date(at);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

function turnText(turn: ChatTurn): string {
  const parts: string[] = [];
  if (turn.user !== null) {
    parts.push(turn.user);
  }
  if (turn.answer !== "") {
    parts.push(turn.answer);
  }
  if (turn.recap !== null) {
    parts.push(turn.recap);
  }
  return parts.join("\n\n");
}

export function TurnList({ turns, status, at, truncated, seconds }: TurnListProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const lastIndex = turns.length - 1;
  const stamp = clock(at);
  const live = status ?? "unknown";

  const copy = (turn: ChatTurn) => {
    const text = turnText(turn);
    if (text === "") {
      return;
    }
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(turn.id))
      .catch(() => undefined);
  };

  return (
    <>
      {turns.map((turn, index) => {
        const isLast = index === lastIndex;
        const active = isLast && (status === "working" || status === "blocked");
        return (
          <div
            className="chat__turn"
            data-turn={turn.id}
            data-user={turn.user === null ? "false" : "true"}
            data-active={active ? "true" : "false"}
            key={turn.id}
          >
            {turn.user !== null && <div className="chat__user">{turn.user}</div>}
            <WorkBlock
              rows={turn.work}
              thoughts={turn.thoughts}
              seconds={active && isLast ? seconds : null}
            />
            {turn.answer !== "" && (
              <div className="chat__prose">
                <Markdown text={turn.answer} />
              </div>
            )}
            {turn.recap !== null && (
              <div className="chat__prose">
                <blockquote className="markdown__quote">{turn.recap}</blockquote>
              </div>
            )}
            {isLast && (
              <div className="chat__meta" data-status={live}>
                <span className="chat__live" data-status={live} aria-hidden="true" />
                <span>{active ? "running" : live}</span>
                {stamp !== "" && <span>{stamp}</span>}
                {isLast && (
                  <button type="button" onClick={() => copy(turn)}>
                    {copied === turn.id ? "copied" : "copy"}
                  </button>
                )}
                {truncated && <span>earlier lines dropped</span>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

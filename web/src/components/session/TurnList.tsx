import { useEffect, useState } from "react";

import { COPY_LABEL, turnCopyText, type CopyFormat } from "@/lib/answerText";
import { COPY_ACK_MS, copyText } from "@/lib/clipboard";
import { statusWord, type ChatTurn } from "@/lib/conversation";
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

export function TurnList({ turns, status, at, truncated, seconds }: TurnListProps) {
  const [copied, setCopied] = useState<{ id: string; format: CopyFormat } | null>(null);
  const lastIndex = turns.length - 1;
  const stamp = clock(at);
  const live = status ?? "unknown";
  const label = statusWord(status);

  // "copied" is an answer to one click, not a state the button should keep.
  useEffect(() => {
    if (copied === null) {
      return;
    }
    const timer = setTimeout(() => setCopied(null), COPY_ACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (turn: ChatTurn, format: CopyFormat) => {
    const text = turnCopyText(turn, format);
    if (text === "") {
      return;
    }
    void copyText(text).then((ok) => {
      if (ok) {
        setCopied({ id: turn.id, format });
      }
    });
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
            <TurnFooter
              turn={turn}
              live={live}
              isLast={isLast}
              label={label}
              stamp={stamp}
              truncated={truncated}
              copied={copied?.id === turn.id ? copied.format : null}
              onCopy={copy}
            />
          </div>
        );
      })}
    </>
  );
}

type TurnFooterProps = {
  turn: ChatTurn;
  live: string;
  isLast: boolean;
  label: string;
  stamp: string;
  truncated: boolean;
  copied: CopyFormat | null;
  onCopy: (turn: ChatTurn, format: CopyFormat) => void;
};

/**
 * The row under a turn: herdr's status when this is the live one, and the two
 * ways to take the turn away. The buttons are on every turn, not just the last
 * one — wanting to copy something is not something that only happens at the
 * bottom of a transcript, and on a phone there is no hover to find them with.
 */
function TurnFooter({ turn, live, isLast, label, stamp, truncated, copied, onCopy }: TurnFooterProps) {
  const formats: CopyFormat[] = ["markdown", "text"];
  if (turnCopyText(turn, "markdown") === "" && !isLast) {
    return null;
  }
  return (
    <div className="chat__meta" data-status={isLast ? live : undefined}>
      {isLast && <span className="chat__live" data-status={live} aria-hidden="true" />}
      {isLast && <span>{label}</span>}
      {isLast && stamp !== "" && <span>{stamp}</span>}
      <span className="chat__acts">
        {formats.map((format) => (
          <button
            type="button"
            key={format}
            data-format={format}
            onClick={() => onCopy(turn, format)}
            aria-label={`copy this turn as ${format === "text" ? "plain text" : "markdown"}`}
          >
            {copied === format ? "copied" : COPY_LABEL[format]}
          </button>
        ))}
      </span>
      {isLast && truncated && <span>earlier lines dropped</span>}
    </div>
  );
}

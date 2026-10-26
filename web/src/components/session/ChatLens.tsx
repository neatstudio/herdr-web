import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deriveConversation } from "@/lib/conversation";
import { sendPaneKeys } from "@/lib/herdr";
import { PICKER_BAR_KEYS, emptyLatches, type KeyLatch } from "@/lib/keybar";
import { parsePickerOptions, pickerKeyName, showsPicker } from "@/lib/pickerKeys";
import { usePaneRead } from "@/lib/usePaneRead";
import { KeyBar } from "./KeyBar";
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
  // The answer row scrolls sideways; these are the two edges it must fade.
  const pickRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ back: false, more: false });
  // A picker in the transcript can only be answered with keys, and on a phone
  // the only keyboard is the one this bar draws.
  const [latches, setLatches] = useState<KeyLatch>(emptyLatches);
  const [started, setStarted] = useState<{ id: string | null; at: number }>({
    id: null,
    at: 0,
  });

  const turns = conversation.turns;
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  const live = status ?? read.agentStatus;
  const active = last !== null && (live === "working" || live === "blocked");
  // "blocked" is herdr's word for "the agent asked something and stopped". In
  // the terminal lens the pane itself takes the answer; here the transcript is
  // a document, so the answer has to come from the key bar below it.
  const blocked = live === "blocked";
  // herdr only says `blocked` for the agents it knows how to read. A
  // third-party agent can draw a menu and report `working`, and on a phone the
  // bar below is the only keyboard that can answer it — so the snapshot gets a
  // second opinion.
  const picker = blocked || showsPicker(read.text);
  // A menu's own digits are one tap; the bar's arrows are three. Both stay on
  // screen: the chips answer, the bar still has esc and a way through a menu
  // whose answers the snapshot did not spell out.
  const options = useMemo(
    () => (picker ? parsePickerOptions(read.text) : null),
    [picker, read.text],
  );

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
    // The key bar takes 48px off the lane when it appears; that is a resize,
    // and the reader was at the bottom.
  }, [read.text, turns.length, picker]);

  // The arrows have to work for a keyboard, not only for the bar. Capturing on
  // the window takes the press before the page's own shortcut that pulls the
  // caret into the composer, so Enter confirms the picker instead of jumping
  // away from it; every key this does not take behaves exactly as before.
  useEffect(() => {
    if (!picker) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      if (document.querySelector(".viewer, .sheet, .hostpanel, [role='dialog']") !== null) {
        return;
      }
      const name = pickerKeyName(event, document.activeElement);
      if (name === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void sendPaneKeys(paneId, [name]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [picker, paneId]);

  // The composer grows as the operator writes, which takes height off the lane.
  // A reader who was at the bottom stays there, exactly as if a poll had landed:
  // otherwise the line being answered scrolls away under their own typing.
  useEffect(() => {
    const lane = laneRef.current;
    if (lane === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) {
        lane.scrollTop = lane.scrollHeight;
      }
    });
    observer.observe(lane);
    return () => observer.disconnect();
  }, []);

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

  // A fenced block or a verbatim block is `white-space: pre` with a sideways
  // scroll, so a long line is not cut off — but nothing says it continues. On a
  // phone the panel edge falls mid-glyph and reads as the end of the line, and
  // the block has no scrollbar to hint otherwise. The boxes therefore report
  // which side still has text behind it, and CSS fades exactly that edge, the
  // same convention the answer row above already borrowed from the tab strip.
  // It is an attribute rather than state: there can be a dozen blocks in the
  // lane, each with its own scroll offset, and only the one being swiped changes.
  useEffect(() => {
    const lane = laneRef.current;
    if (lane === null) {
      return;
    }
    const paint = () => {
      const boxes = lane.querySelectorAll<HTMLElement>(".chat__code-body, .chat__pre");
      for (const box of Array.from(boxes)) {
        const back = box.scrollLeft > 2;
        // `scrollWidth` counts the block's own 24px of padding and rounds, so a
        // line that just fits can still report 2-3px of overflow. Two glyphs of
        // a 12px mono line is the smallest gap worth asking a reader to swipe
        // for; below it the fade would dim legible text to hide 2px.
        const wider = box.scrollWidth - box.clientWidth > 16;
        const more = wider && box.scrollLeft + box.clientWidth < box.scrollWidth - 2;
        const edges = back ? (more ? "both" : "back") : more ? "more" : "";
        if ((box.dataset.edges ?? "") === edges) {
          continue;
        }
        if (edges === "") {
          delete box.dataset.edges;
        } else {
          box.dataset.edges = edges;
        }
      }
    };
    paint();
    // `scroll` does not bubble, so it is taken on the way down: one listener
    // covers every block, including the ones the next render adds.
    lane.addEventListener("scroll", paint, true);
    if (typeof ResizeObserver === "undefined") {
      return () => lane.removeEventListener("scroll", paint, true);
    }
    // A rotation or a wider frame changes both the box and its content width;
    // the lane's own box is the one box that changes in every case.
    const observer = new ResizeObserver(paint);
    observer.observe(lane);
    return () => {
      lane.removeEventListener("scroll", paint, true);
      observer.disconnect();
    };
  }, [read.text]);

  // A menu longer than the phone is wide turns its answer row into a sideways
  // scroll, and the chip at the screen edge is cut mid-glyph: that reads as a
  // clipped box, not as "there is more". Only the row knows whether anything is
  // left on either side of the viewport, so it reports both edges and the row
  // fades the one that still has answers behind it.
  const measurePick = useCallback(() => {
    const row = pickRef.current;
    if (row === null) {
      return;
    }
    const back = row.scrollLeft > 2;
    const more = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
    setEdges((current) =>
      current.back === back && current.more === more ? current : { back, more },
    );
  }, []);

  useEffect(() => {
    const row = pickRef.current;
    if (row === null) {
      setEdges((current) => (current.back || current.more ? { back: false, more: false } : current));
      return;
    }
    measurePick();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    // The row's own box can stay put while the answers under it change width, so
    // the chips are observed too: a new label is a new scrollWidth.
    const observer = new ResizeObserver(measurePick);
    observer.observe(row);
    for (const chip of Array.from(row.children)) {
      observer.observe(chip);
    }
    return () => observer.disconnect();
  }, [measurePick, options]);

  const pickClass =
    edges.back && edges.more
      ? "chat__pick chat__pick--back chat__pick--more"
      : edges.back
        ? "chat__pick chat__pick--back"
        : edges.more
          ? "chat__pick chat__pick--more"
          : "chat__pick";

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
      {options !== null && (
        <div
          className={pickClass}
          ref={pickRef}
          onScroll={measurePick}
          role="group"
          aria-label="answer the menu"
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className="chat__pickopt"
              aria-label={`answer ${option.key}: ${option.label}`}
              onClick={() => void sendPaneKeys(paneId, [option.key])}
            >
              <span className="chat__picknum">{option.key}</span>
              <span className="chat__picklabel">{option.label}</span>
            </button>
          ))}
        </div>
      )}
      {picker && (
        <KeyBar
          paneId={paneId}
          keys={PICKER_BAR_KEYS}
          latches={latches}
          onLatches={setLatches}
        />
      )}
    </div>
  );
}

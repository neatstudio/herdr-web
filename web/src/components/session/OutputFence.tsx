import { useState } from "react";

import { fenceSource, type FencePiece } from "@/lib/outputFold";

import { Markdown } from "./Markdown";

/**
 * One fenced block the agent used as a mention rather than a listing.
 *
 * A collapsed row is the block's head without the block: the language, the
 * line count and the first line, which is what the reader decides on. Opening
 * it hands the block back to `Markdown` — same copy button, same fold for long
 * blocks, same language label. The row never invents a preview it could not
 * have shown inline, and the count is only printed when it is a count: a single
 * line is already on the row as the preview.
 *
 * `open` is local: a transcript re-reads its snapshot every 400ms while the
 * agent is working, and lifting this state would re-close the block the reader
 * just opened on the next poll. The rows are keyed by position in the answer,
 * so a re-render keeps the open one open.
 */

export function OutputFence({ piece }: { piece: FencePiece }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="out" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="out__row"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="out__caret" aria-hidden="true">
          ›
        </span>
        <span className="out__lang">{piece.language === "" ? "text" : piece.language}</span>
        {piece.lines > 1 && <span className="out__count">{`${piece.lines} lines`}</span>}
        <span className="out__peek">{piece.peek}</span>
      </button>
      {open && (
        <div className="out__body">
          <Markdown text={fenceSource(piece)} />
        </div>
      )}
    </div>
  );
}

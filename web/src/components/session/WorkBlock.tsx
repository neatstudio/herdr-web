import { useId, useState } from "react";

import type { WorkRow } from "@/lib/conversation";
import { countWork, formatDuration, summariseWork, totalWork } from "@/lib/chatFormat";
import { diffLines, diffStat, looksLikeDiff, type DiffLine, type DiffLineKind } from "@/lib/diffLines";

/**
 * Everything an agent did between two user messages, folded into one line.
 *
 * A session transcript is mostly not prose: it is file reads, edits and
 * commands. Replaying those as a chat log would bury the three sentences that
 * matter, so they collapse under a single 34px summary — `Worked for 7s · 1
 * edit`. Opening it explains what the agent spent that time on; the detail of
 * an individual row only appears when that row itself is opened.
 *
 * There is no colour per kind. The row label carries the meaning (`Edit`,
 * `Read`, `Ran`) and the fold is quiet by design. The one exception is a
 * changed file: an edit body is a diff the terminal drew, and painting it grey
 * is what makes a six-line edit read as a wall, so it gets the two tints the
 * TUI itself used (`see lib/diffLines.ts`).
 */

/** The sigil column a diff line prints before its text. */
const SIGN: Record<DiffLineKind, string> = {
  add: "+",
  del: "−",
  context: "",
  gap: "",
  hunk: "",
  plain: "",
};

const KIND_LABEL: Record<WorkRow["kind"], string> = {
  edit: "Edit",
  read: "Read",
  command: "Ran",
  other: "Other",
};

function rowLabel(row: WorkRow): string {
  const label = KIND_LABEL[row.kind];
  return row.title.startsWith(`${label} `) || row.title === label
    ? row.title
    : `${label} ${row.title}`;
}

/** A file edit, rendered as the diff the TUI printed. */
function DiffBody({ lines }: { lines: readonly DiffLine[] }) {
  const stat = diffStat(lines);
  return (
    <div className="work__diff">
      {(stat.add > 0 || stat.del > 0) && (
        <div className="work__diff-stat">
          {stat.add > 0 && <span data-kind="add">+{stat.add}</span>}
          {stat.del > 0 && <span data-kind="del">−{stat.del}</span>}
        </div>
      )}
      <div className="work__diff-body">
        {lines.map((line, index) =>
          line.kind === "gap" ? (
            <div className="work__diff-gap" key={index} aria-hidden="true">
              ⋯
            </div>
          ) : (
            <div className="work__diff-line" data-kind={line.kind} key={index}>
              <span className="work__diff-sign" aria-hidden="true">
                {SIGN[line.kind]}
              </span>
              <span className="work__diff-text">{line.text === "" ? " " : line.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function WorkBlock({
  rows,
  thoughts,
  seconds,
}: {
  rows: readonly WorkRow[];
  thoughts: readonly string[];
  /** Live elapsed seconds for the turn still running, or null when unknown. */
  seconds: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const listId = useId();
  const counts = countWork(rows);
  const summary = summariseWork(counts);
  const total = totalWork(counts) + (thoughts.length > 0 ? 1 : 0);
  if (total === 0) {
    return null;
  }
  const head =
    seconds === null
      ? summary === "" ? "Thought" : summary
      : `Worked for ${formatDuration(seconds)}${summary === "" ? "" : ` · ${summary}`}`;

  const toggleRow = (index: number) => {
    setOpenRow((current) => (current === index ? null : index));
  };

  return (
    <div className="work" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="work__head"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="work__caret" aria-hidden="true">
          ›
        </span>
        <span className="work__summary">{head}</span>
      </button>
      {open && (
        <div className="work__rows" id={listId}>
          {thoughts.length > 0 && (
            <div className="work__row" data-kind="thought">
              <button type="button" aria-expanded={openRow === -1} onClick={() => toggleRow(-1)}>
                Thought
              </button>
              {openRow === -1 && (
                <div className="work__detail">
                  <pre className="work__detail-body">{thoughts.join("\n")}</pre>
                </div>
              )}
            </div>
          )}
          {rows.map((row, index) => {
            const hasDetail = row.detail.length > 0;
            const isOpen = openRow === index;
            const diff = isOpen && hasDetail && looksLikeDiff(row.detail) ? diffLines(row.detail) : null;
            return (
              <div
                className={`work__row work__row--${row.kind}`}
                data-kind={row.kind}
                key={`${row.kind}-${index}`}
              >
                {hasDetail ? (
                  <button type="button" aria-expanded={isOpen} onClick={() => toggleRow(index)}>
                    {rowLabel(row)}
                  </button>
                ) : (
                  <span>{rowLabel(row)}</span>
                )}
                {isOpen && hasDetail && (
                  <div className="work__detail">
                    {diff === null ? (
                      <pre className="work__detail-body">{row.detail.join("\n")}</pre>
                    ) : (
                      <DiffBody lines={diff} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

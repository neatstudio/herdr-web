import { useMemo, type ReactNode } from "react";

import { inlineSpans, safeHref } from "@/lib/markdown";
import { reflowProse } from "@/lib/prose";
import { splitTables, type TableModel } from "@/lib/table";

import { Markdown } from "./Markdown";

/**
 * The agent's answer, with the tables it drew rendered as tables.
 *
 * `Markdown` keeps anything that looks drawn — box characters, aligned
 * columns — in a `<pre>`, deliberately, because a terminal is the only place a
 * diagram survives. A table is the exception: it has columns, and a column has
 * a name, so a phone can stack a row into a card instead of making the reader
 * swipe a 1464px pre sideways to see four fifths of it. Everything that is not
 * a well-formed table stays exactly as it was.
 *
 * The prose goes through `reflowProse` first, per segment: an agent's answer is
 * wrapped for its own terminal, so a Chinese word arrives split over two rows
 * and a paragraph arrives with no blank row after it. Repairing that here, not
 * in the conversation model, keeps the model's own text intact for the copy
 * button and keeps this a presentation decision.
 */

function cell(text: string, key: string): ReactNode[] {
  return inlineSpans(text).map((span, index) => {
    const id = `${key}-${index}`;
    switch (span.kind) {
      case "strong":
        return <strong key={id}>{span.text}</strong>;
      case "code":
        return (
          <code className="markdown__code" key={id}>
            {span.text}
          </code>
        );
      case "em":
        return <em key={id}>{span.text}</em>;
      case "link": {
        const href = safeHref(span.href);
        if (href === null) {
          return <span key={id}>{span.text}</span>;
        }
        return (
          <a key={id} href={href} target="_blank" rel="noreferrer">
            {span.text}
          </a>
        );
      }
      default:
        return span.text;
    }
  });
}

/**
 * A real table while the lane has room, one card per row when it does not.
 *
 * The phone has 366px of lane and the drawn table needed 1464px: at that width
 * a column is narrower than its own header and the reader scrolls to learn what
 * a cell means. `data-label` carries the column name into the stacked layout,
 * so the CSS can put it above each cell and the same markup serves both.
 */
export function AgentTable({ table }: { table: TableModel }) {
  return (
    <div className="chat__table">
      <table>
        <thead>
          <tr>
            {table.head.map((label, column) => (
              <th key={column} scope="col">
                {cell(label, `h${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, column) => (
                <td key={column} data-label={table.head[column] ?? ""}>
                  {cell(value, `r${index}c${column}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnswerProse({ text }: { text: string }) {
  const segments = useMemo(() => splitTables(text), [text]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "table") {
          return <AgentTable key={index} table={segment.table} />;
        }
        if (segment.text.trim() === "") {
          return null;
        }
        return <Markdown key={index} text={reflowProse(segment.text)} />;
      })}
    </>
  );
}

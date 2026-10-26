/**
 * The two ways to take a turn off the screen.
 *
 * An agent writes markdown, and both copies of that are useful for different
 * places: pasted into an issue or an editor the syntax *is* the content, while
 * pasted into a chat or a shell prompt the `**` and the fences are noise. So a
 * turn offers both, and the difference is one function: markdown is the text as
 * it arrived, plain text is that text with its markup taken off.
 *
 * The user's own words pass through untouched in both formats — they are not
 * markdown, and `**hi**` typed by hand must not lose its asterisks.
 */

import type { ChatTurn } from "./conversation.ts";
import { FENCE_RE, HEADING_RE, QUOTE_RE, inlineSpans } from "./markdown.ts";

export type CopyFormat = "markdown" | "text";

/** What the operator reads on the two buttons. */
export const COPY_LABEL: Record<CopyFormat, string> = { markdown: "markdown", text: "text" };

/** The inline text of one line, with the markup that would not survive a paste. */
function plainLine(line: string): string {
  if (line.trim() === "") {
    return "";
  }
  const spans = inlineSpans(line);
  if (spans.length === 0) {
    return line;
  }
  let out = "";
  for (const span of spans) {
    if (span.kind === "link") {
      // A pasted link has to carry its target: the label alone is a dead end.
      out += span.text === span.href ? span.href : `${span.text} (${span.href})`;
    } else {
      out += span.text;
    }
  }
  return out;
}

/**
 * Markdown to the text a person would have typed.
 *
 * Fenced code keeps its lines byte for byte — that is the part of an answer
 * that gets pasted into a file — but the fence itself goes, since a shell does
 * not read ``` and neither does a terminal pane.
 */
export function markdownToPlain(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = FENCE_RE.exec(line);
    if (marker !== null) {
      if (fence === null) {
        fence = marker[1];
        continue;
      }
      if (marker[1] === fence) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    // A heading and a quote are block syntax: their markers are not words.
    const heading = HEADING_RE.exec(line);
    const quote = QUOTE_RE.exec(line);
    const body = heading !== null ? heading[2] : quote !== null ? quote[1] : line;
    out.push(plainLine(body).trimEnd());
  }
  // The last newline belongs to the file, not to the answer.
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n");
}

/**
 * One turn as it should land on the clipboard.
 *
 * The order is the order it was written in: what was asked, what came back, and
 * the recap the agent left behind. Empty parts are skipped so two blank lines
 * never stack up.
 */
export function turnCopyText(turn: ChatTurn, format: CopyFormat): string {
  const parts: string[] = [];
  if (turn.user !== null) {
    parts.push(turn.user);
  }
  if (turn.answer !== "") {
    parts.push(format === "markdown" ? turn.answer : markdownToPlain(turn.answer));
  }
  if (turn.recap !== null) {
    parts.push(format === "markdown" ? turn.recap : markdownToPlain(turn.recap));
  }
  return parts.join("\n\n").trim();
}

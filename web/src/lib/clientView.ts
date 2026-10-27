/**
 * The block a client prints when the operator asks it about the account, which
 * devin answers for `/usage`:
 *
 *     Daily   ■■■■■■■■■■■■■■■■■■■■  65% used  · resets in 9h 47m
 *     Weekly  ■■■■■■■■■■■■■■■■■■■■  33% used  · resets Oct 25, 8:00 AM (UTC)
 *
 *     This session
 *     Activity  1 turn · 22 tool calls · 0 files · 6 commands
 *     Tokens    108k in · 2.1k out  (~110k per turn)
 *     Model     Claude Opus 5.5 Medium
 *
 * Every row is a label and a value in columns, and the columns are the point:
 * as prose the newlines collapse and `Model Claude Opus 5.5 Medium` runs into
 * the token count above it, so the reader cannot tell which number belongs to
 * which label. The conversation model already keeps these rows as the answer to
 * the command (see `CLIENT_VIEW_PATTERNS` there); this decides they are drawn
 * verbatim instead of re-flowed.
 *
 * It is deliberately strict — two rows at least, every one of them a known
 * label — because the cost of guessing wrong is a paragraph of real prose
 * rendered as a monospace block.
 */

const PANEL_ROWS: readonly RegExp[] = [
  /^(?:daily|weekly|monthly|hourly)\s+[■▰▮▪=#]/i,
  /^this session$/i,
  /^activity\s+\d+\s+turns?\b/i,
  /^tokens\s+[\d.]+k?\s+in\b/i,
  /^model\s+\S/i,
];

export function isClientViewPanel(text: string): boolean {
  const rows = text
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "");
  if (rows.length < 2) {
    return false;
  }
  return rows.every((row) => PANEL_ROWS.some((pattern) => pattern.test(row)));
}

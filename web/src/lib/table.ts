/**
 * A table an agent drew in the terminal, put back together as cells.
 *
 * Agents print tables two ways. Markdown pipes come straight from the model:
 * `| 问题 | 证据 |` under a `| --- | --- |` divider. Box-drawing tables are
 * drawn by the CLI: `┌─┬─┐` on top, `│ cell │ cell │` per row, `├─┼─┤` between
 * rows, `└─┴─┘` at the bottom. Both used to fall through `Markdown`'s art rule
 * into a `<pre>`, which is honest on a wide screen and unusable on a phone: one
 * live devin table measured 1464px inside a 366px lane, so four fifths of every
 * row sat behind a sideways scroll and no column name stayed in view.
 *
 * This module only recovers the cells. It is deliberately strict — a block is
 * either a well-formed table or it stays art, because a diagram, a menu and a
 * banner must not be turned into a table nobody wrote. A false negative costs a
 * sideways scroll; a false positive invents a structure the agent never had.
 */

export type TableModel = {
  readonly head: string[];
  readonly rows: string[][];
};

export type TableSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "table"; readonly table: TableModel };

const BOX_OPEN = /^\s*┌[─┬]+┐\s*$/;
const BOX_DIVIDER = /^\s*├[─┼]+┤\s*$/;
const BOX_CLOSE = /^\s*└[─┴]+┘\s*$/;
const BOX_ROW = /^\s*│(.*)│\s*$/;
const PIPE_ROW = /^\s*\|(.*)\|\s*$/;
/** `| --- | :---: |` — a markdown divider needs two dashes, as the spec does. */
const PIPE_DIVIDER = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

type Found = { readonly table: TableModel; readonly end: number };

/**
 * Cells of one drawn row. A wide cell is wrapped by the CLI itself, so one
 * logical row arrives as several lines whose columns still line up: line one
 * holds the beginning of every cell, line two the tail of the ones that
 * overflowed. Parts are re-joined in column order with a single space.
 */
function groupCells(group: readonly (readonly string[])[]): string[] {
  let width = 0;
  for (const cells of group) {
    width = Math.max(width, cells.length);
  }
  const merged: string[] = [];
  for (let column = 0; column < width; column += 1) {
    const parts: string[] = [];
    for (const cells of group) {
      const part = (cells[column] ?? "").trim();
      if (part !== "") {
        parts.push(part);
      }
    }
    merged.push(parts.join(" "));
  }
  return merged;
}

/** Split a `│ a │ b │` row; `inner` is what sat between the outer borders. */
function splitBoxRow(inner: string): string[] {
  return inner.split("│").map((cell) => cell.trim());
}

/** Split a pipe row, keeping an escaped `\|` inside its cell. */
function splitPipeRow(inner: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\" && inner[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseBoxTable(lines: readonly string[], start: number): Found | null {
  if (!BOX_OPEN.test(lines[start] ?? "")) {
    return null;
  }
  const groups: string[][][] = [];
  let current: string[][] = [];
  let index = start + 1;
  let closed = false;
  while (index < lines.length) {
    const line = lines[index];
    if (BOX_CLOSE.test(line)) {
      closed = true;
      break;
    }
    if (BOX_DIVIDER.test(line)) {
      if (current.length > 0) {
        groups.push(current);
      }
      current = [];
      index += 1;
      continue;
    }
    const row = BOX_ROW.exec(line);
    if (row === null) {
      // A clipped right border, a trailing note inside the block: not a table
      // this reader is willing to guess at.
      return null;
    }
    current.push(splitBoxRow(row[1]));
    index += 1;
  }
  if (!closed) {
    return null;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  if (groups.length < 2) {
    return null;
  }
  const head = groupCells(groups[0]);
  if (head.length < 2) {
    return null;
  }
  if (head.every((cell) => cell === "")) {
    return null;
  }
  const rows = groups.slice(1).map(groupCells);
  if (rows.some((cells) => cells.length !== head.length)) {
    return null;
  }
  return { table: { head, rows }, end: index + 1 };
}

function parsePipeTable(lines: readonly string[], start: number): Found | null {
  const header = PIPE_ROW.exec(lines[start] ?? "");
  if (header === null) {
    return null;
  }
  if (!PIPE_DIVIDER.test(lines[start + 1] ?? "")) {
    return null;
  }
  const head = splitPipeRow(header[1]);
  if (head.length < 2) {
    return null;
  }
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const row = PIPE_ROW.exec(lines[index]);
    if (row === null) {
      break;
    }
    const cells = splitPipeRow(row[1]);
    if (cells.length !== head.length) {
      break;
    }
    rows.push(cells);
    index += 1;
  }
  if (rows.length === 0) {
    return null;
  }
  return { table: { head, rows }, end: index };
}

/** The table starting at `start`, if those lines are one. */
export function parseTable(lines: readonly string[], start: number): Found | null {
  return parseBoxTable(lines, start) ?? parsePipeTable(lines, start);
}

/**
 * The text split around every table it contains, in reading order. Adjacent
 * prose stays in one text segment so `Markdown` still sees whole paragraphs;
 * a table segment replaces exactly the lines that drew it.
 */
export function splitTables(text: string): TableSegment[] {
  const lines = text.split("\n");
  const segments: TableSegment[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) {
      segments.push({ kind: "text", text: prose.join("\n") });
      prose = [];
    }
  };
  let index = 0;
  while (index < lines.length) {
    const found = parseTable(lines, index);
    if (found === null) {
      prose.push(lines[index]);
      index += 1;
      continue;
    }
    flush();
    segments.push({ kind: "table", table: found.table });
    index = found.end;
  }
  flush();
  return segments;
}

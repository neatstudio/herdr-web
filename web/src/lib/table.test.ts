import assert from "node:assert/strict";
import test from "node:test";

import { splitTables } from "./table.ts";

/*
 * Tables arrive from third-party clients, so the fixtures are the client's
 * shape with text written for this test. A raw live pane is not something to
 * commit, and a device-width truncation inside one is not the shape to pin.
 */

/** A devin-shaped box table: rows wrap at the CLI's own column width. */
const DRAWN = [
  "┌────────┬──────────────────────┬──────────────┐",
  "│ 问题   │ 证据                 │ 建议         │",
  "├────────┼──────────────────────┼──────────────┤",
  "│ 大文件 │ server.go 2222 行、  │ 按职责拆分。 │",
  "│        │ watcher.go 2113 行   │ 可以拆成     │",
  "│        │                      │ 4 个文件     │",
  "├────────┼──────────────────────┼──────────────┤",
  "│ 迭代快 │ 7 天 71 次提交       │ 留一天修 Bug │",
  "└────────┴──────────────────────┴──────────────┘",
].join("\n");

test("a drawn table becomes a header and its rows", () => {
  const segments = splitTables(`先说明一下。\n\n${DRAWN}\n\n后面还有。`);

  assert.equal(segments.length, 3);
  const [before, table, after] = segments;
  assert.equal(before.kind, "text");
  assert.equal(after.kind, "text");
  if (table.kind !== "table") {
    throw new Error("expected the drawn table to be recognised");
  }
  assert.deepEqual(table.table.head, ["问题", "证据", "建议"]);
  assert.deepEqual(table.table.rows, [
    ["大文件", "server.go 2222 行、 watcher.go 2113 行", "按职责拆分。 可以拆成 4 个文件"],
    ["迭代快", "7 天 71 次提交", "留一天修 Bug"],
  ]);
  // The prose on either side survives untouched, blank lines included.
  if (before.kind === "text") {
    assert.equal(before.text, "先说明一下。\n");
  }
});

test("a markdown pipe table becomes the same model", () => {
  const segments = splitTables(
    ["结论如下：", "| 文件 | 行数 |", "| --- | ---: |", "| `server.go` | 2222 |", "| 守卫 | 无 |"].join(
      "\n",
    ),
  );

  assert.equal(segments.length, 2);
  const table = segments[1];
  if (table.kind !== "table") {
    throw new Error("expected the pipe table to be recognised");
  }
  assert.deepEqual(table.table.head, ["文件", "行数"]);
  assert.deepEqual(table.table.rows, [
    ["`server.go`", "2222"],
    ["守卫", "无"],
  ]);
});

test("an escaped pipe stays inside its cell", () => {
  const segments = splitTables(["| 表达式 | 含义 |", "| --- | --- |", "| `a \\| b` | 或 |"].join("\n"));

  const table = segments[0];
  if (table.kind !== "table") {
    throw new Error("expected the pipe table to be recognised");
  }
  assert.deepEqual(table.table.rows, [["`a | b`", "或"]]);
});

test("a diagram that is not a table stays art", () => {
  // A tree, a logo box and a one-column banner are all drawn with box
  // characters and none of them has columns; each must come back as text.
  const art = [
    "┌────────────────────┐",
    "│   herdr  ·  v0.9   │",
    "└────────────────────┘",
    "",
    "src/",
    "├── app/",
    "└── lib/",
  ].join("\n");

  const segments = splitTables(art);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
  if (segments[0].kind === "text") {
    assert.equal(segments[0].text, art);
  }
});

test("a row whose right border was clipped is not guessed at", () => {
  const clipped = [
    "┌────────┬────────┐",
    "│ 文件   │ 行数   │",
    "├────────┼────────┤",
    "│ a.go   │ 2222",
    "└────────┴────────┘",
  ].join("\n");

  const segments = splitTables(clipped);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
});

test("a header with no rows under it stays text", () => {
  const empty = ["┌──────┬──────┐", "│ 文件 │ 行数 │", "└──────┴──────┘"].join("\n");
  assert.equal(splitTables(empty)[0].kind, "text");
});

test("a pipe divider is required, so a stray pipe row is not a table", () => {
  const stray = ["| a | b |", "not a divider", "| c | d |"].join("\n");
  assert.equal(splitTables(stray)[0].kind, "text");
});

test("text without a table is one segment and unchanged", () => {
  const text = "第一段。\n\n第二段。\n";
  const segments = splitTables(text);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
  if (segments[0].kind === "text") {
    assert.equal(segments[0].text, text);
  }
});

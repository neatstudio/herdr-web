import assert from "node:assert/strict";
import test from "node:test";

import { classifyLine, diffLines, diffStat, looksLikeDiff } from "./diffLines.ts";

/* ------------------------------------------------------------ classification */

test("a boxed row carries its sigil, its number and its body", () => {
  const kept = classifyLine("181│ if err != nil {", true);
  assert.deepEqual(kept, { kind: "context", number: "181", text: "if err != nil {" });

  const removed = classifyLine("-185│\u2192 \u2192 s.ledger.started()", true);
  assert.equal(removed.kind, "del");
  assert.equal(removed.number, "185");
  assert.equal(removed.text, "\t\ts.ledger.started()");

  const added = classifyLine("+186│ \u2192 taskID := 1", true);
  assert.equal(added.kind, "add");
  assert.equal(added.number, "186");
  assert.equal(added.text, "\ttaskID := 1");
});

test("an added row with no number of its own is still an addition", () => {
  const row = classifyLine("  +\u2502 \u2192 next()", true);
  assert.equal(row.kind, "add");
  assert.equal(row.number, null);
  assert.equal(row.text, "\tnext()");
});

test("the elision marker is a gap, not text", () => {
  assert.deepEqual(classifyLine("\u2026", true), { kind: "gap", number: null, text: "" });
  assert.equal(classifyLine("   \u2026  ", true).kind, "gap");
});

test("a hunk head is marked even when the box drew a gutter", () => {
  assert.equal(classifyLine("@@ -1,3 +1,4 @@", false).kind, "hunk");
  assert.equal(classifyLine("| @@ -1,3 +1,4 @@", true).kind, "hunk");
});

test("prose keeps its dashes unless the run is a box", () => {
  assert.equal(classifyLine("- a bullet", false).kind, "plain");
  assert.equal(classifyLine("+ not a diff either", false).kind, "plain");
  // Inside a box, a bare sigil is the TUI's own and is trusted.
  assert.equal(classifyLine("- s.ledger.started()", true).kind, "del");
  assert.equal(classifyLine("+ taskID := 1", true).kind, "add");
  // `---`/`+++` file heads are not counted as changed lines.
  assert.equal(classifyLine("--- a/file.go", true).kind, "plain");
  assert.equal(classifyLine("+++ b/file.go", true).kind, "plain");
});

/* ------------------------------------------------------------------ whole body */

test("a boxed edit is detected as a diff and totals its two sides", () => {
  const lines = [
    "181│      if err := s.runInPane(ctx, paneID, command); err != nil {",
    "-185│ \u2192 \u2192 s.ledger.started(taskID)",
    "  +\u2502 \u2192 \u2192 s.ledger.started(sharedTaskID(request, paneID))",
    "+186│ \u2192 taskID := sharedTaskID(request, paneID)",
    "\u2026",
    "186│      writeJSON(w, http.StatusOK, jobStarted{",
  ];
  assert.equal(looksLikeDiff(lines), true);
  const classified = diffLines(lines);
  assert.deepEqual(
    classified.map((line) => line.kind),
    ["context", "del", "add", "add", "gap", "context"],
  );
  assert.deepEqual(diffStat(classified), { add: 2, del: 1 });
});

test("a number-then-sigil row counts as a changed line", () => {
  const lines = ["12 -  old line", "12 +  new line"];
  assert.equal(looksLikeDiff(lines), true);
  assert.deepEqual(diffLines(lines), [
    { kind: "del", number: "12", text: "old line" },
    { kind: "add", number: "12", text: "new line" },
  ]);
  assert.deepEqual(diffStat(diffLines(lines)), { add: 1, del: 1 });
});

test("command output is not a diff", () => {
  const lines = [
    "$ go test ./...",
    "PASS",
    "ok  github.com/neatstudio/herdr-web  0.21s",
  ];
  assert.equal(looksLikeDiff(lines), false);
  assert.deepEqual(diffLines(lines), [
    { kind: "plain", number: null, text: "$ go test ./..." },
    { kind: "plain", number: null, text: "PASS" },
    { kind: "plain", number: null, text: "ok  github.com/neatstudio/herdr-web  0.21s" },
  ]);
});

test("a read listing of numbered lines is context, not a diff", () => {
  // `read` rows print a number gutter too; nothing changed, so no sigil shows.
  const lines = [" 1│ package main", " 2│ ", " 3│ func main() {}"];
  assert.equal(looksLikeDiff(lines), false);
  assert.deepEqual(
    diffLines(lines).map((line) => [line.kind, line.number]),
    [
      ["context", "1"],
      ["context", "2"],
      ["context", "3"],
    ],
  );
});

test("trailing whitespace never reaches the viewport", () => {
  assert.equal(classifyLine("+186│ \u2192 taskID   ", true).text, "\ttaskID");
});

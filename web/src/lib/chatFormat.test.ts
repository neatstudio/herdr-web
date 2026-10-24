import assert from "node:assert/strict";
import test from "node:test";

import {
  COUNT_ORDER,
  EMPTY_COUNTS,
  countLabel,
  countWork,
  formatDuration,
  parseDuration,
  summariseWork,
  totalWork,
  type WorkCounts,
} from "./chatFormat.ts";

/* -------------------------------------------------------------- counting */

test("a single row is singular and a pair is plural", () => {
  assert.equal(countLabel("edit", 1), "1 edit");
  assert.equal(countLabel("edit", 2), "2 edits");
  assert.equal(countLabel("read", 1), "1 file read");
  assert.equal(countLabel("read", 3), "3 file reads");
  assert.equal(countLabel("command", 1), "1 command");
  assert.equal(countLabel("command", 4), "4 commands");
  assert.equal(countLabel("other", 1), "1 action");
  assert.equal(countLabel("other", 2), "2 actions");
});

test("missing counts render as nothing", () => {
  assert.equal(countLabel("edit", 0), "");
  assert.equal(countLabel("edit", -2), "");
  assert.equal(countLabel("command", Number.NaN), "");
  assert.equal(countLabel("read", Number.POSITIVE_INFINITY), "");
});

test("counts tally rows by kind", () => {
  const counts = countWork([
    { kind: "edit" },
    { kind: "read" },
    { kind: "read" },
    { kind: "other" },
  ]);
  assert.deepEqual(counts, { edit: 1, read: 2, command: 0, other: 1 });
  assert.deepEqual(countWork([]), EMPTY_COUNTS);
});

test("the summary joins non-empty kinds in reading order", () => {
  const counts: WorkCounts = { edit: 2, read: 1, command: 3, other: 0 };
  assert.equal(summariseWork(counts), "2 edits · 1 file read · 3 commands");
  assert.equal(summariseWork(EMPTY_COUNTS), "");
  assert.equal(summariseWork({ edit: 1, read: 0, command: 0, other: 1 }), "1 edit · 1 action");
  assert.deepEqual([...COUNT_ORDER], ["edit", "read", "command", "other"]);
});

test("the total adds every kind", () => {
  assert.equal(totalWork({ edit: 1, read: 2, command: 3, other: 4 }), 10);
  assert.equal(totalWork(EMPTY_COUNTS), 0);
});

/* ------------------------------------------------------------ durations */

test("short durations keep the natural unit", () => {
  assert.equal(formatDuration(7), "7s");
  assert.equal(formatDuration(156), "2m 36s");
  assert.equal(formatDuration(120), "2m");
  assert.equal(formatDuration(3720), "1h 2m");
  assert.equal(formatDuration(3600), "1h");
});

test("nothing at all renders as zero seconds", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-3), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
});

test("sub-second durations read in milliseconds, never as zero", () => {
  assert.equal(formatDuration(0.014), "14ms");
  assert.equal(formatDuration(0.0004), "1ms");
  assert.equal(formatDuration(0.9996), "1000ms");
});

test("agents print compact durations that parse back to seconds", () => {
  assert.equal(parseDuration("2m17s"), 137);
  assert.equal(parseDuration("1h 2m"), 3720);
  assert.equal(parseDuration("14ms"), 0.014);
  assert.equal(parseDuration("3s"), 3);
  assert.equal(parseDuration(" 45s "), 45);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("1h"), 3600);
});

test("text with no duration parses as null", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("   "), null);
  assert.equal(parseDuration("7"), null);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("2m17s done"), null);
});

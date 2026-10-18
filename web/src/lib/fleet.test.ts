import assert from "node:assert/strict";
import test from "node:test";

import * as fleet from "./fleet.ts";

test("toneOf maps every status the daemon is known to send", () => {
  assert.equal(fleet.toneOf("working"), "working");
  assert.equal(fleet.toneOf("running"), "working");
  assert.equal(fleet.toneOf("blocked"), "blocked");
  assert.equal(fleet.toneOf("needs input"), "blocked");
  assert.equal(fleet.toneOf("Needs Input"), "blocked");
  assert.equal(fleet.toneOf("done"), "done");
  assert.equal(fleet.toneOf("finished"), "done");
});

test("toneOf treats unknown and empty statuses as idle", () => {
  assert.equal(fleet.toneOf("unknown"), "idle");
  assert.equal(fleet.toneOf(""), "idle");
  assert.equal(fleet.toneOf(undefined), "idle");
  assert.equal(fleet.toneOf(null), "idle");
});

test("groupByTone puts blocked first and drops empty groups", () => {
  const items = [
    { id: "a", status: "idle" },
    { id: "b", status: "working" },
    { id: "c", status: "blocked" },
    { id: "d", status: "idle" },
  ];
  const groups = fleet.groupByTone(items, (item) => item.status);
  assert.deepEqual(
    groups.map((group) => group.tone),
    ["blocked", "working", "idle"],
  );
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.id)),
    [["c"], ["b"], ["a", "d"]],
  );
});

test("groupByTone returns nothing for an empty fleet", () => {
  assert.deepEqual(fleet.groupByTone([], () => undefined), []);
});

test("splitLines drops the trailing newline but keeps blank lines", () => {
  assert.deepEqual(fleet.splitLines(""), []);
  // A lone newline is one empty line that was terminated, not nothing.
  assert.deepEqual(fleet.splitLines("\n"), [""]);
  assert.deepEqual(fleet.splitLines("a\n"), ["a"]);
  assert.deepEqual(fleet.splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(fleet.splitLines("a\n\nb\n"), ["a", "", "b"]);
});

test("tailPath keeps the last segments for compact readouts", () => {
  assert.equal(fleet.tailPath("/home/op/.config/herdr/herdr.sock", 2), "herdr/herdr.sock");
  assert.equal(fleet.tailPath("/tmp/herdr.sock"), "herdr.sock");
  assert.equal(fleet.tailPath("herdr.sock"), "herdr.sock");
  assert.equal(fleet.tailPath("/", 2), "/");
});

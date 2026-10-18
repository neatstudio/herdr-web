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

test("paneName prefers the operator's rename over everything else", () => {
  // herdr keeps four independent names; a deliberate rename wins.
  assert.equal(
    fleet.paneName({
      id: "w1:p1",
      label: "Deploy Watch",
      title: "herdr title",
      terminalTitle: "some program title",
      agent: "claude",
    }),
    "Deploy Watch",
  );
});

test("paneName falls back through title, terminal title and agent", () => {
  assert.equal(
    fleet.paneName({ id: "w6:p3", title: "herdr title", terminalTitle: "osc", agent: "grok" }),
    "herdr title",
  );
  assert.equal(
    fleet.paneName({ id: "w7:p1", terminalTitle: "vnstat 区间流量合计脚本 - grok", agent: "grok" }),
    "vnstat 区间流量合计脚本 - grok",
  );
  assert.equal(fleet.paneName({ id: "w6:p1", agent: "agy" }), "agy");
  assert.equal(fleet.paneName({ id: "w6:p1", displayAgent: "Claude", agent: "claude" }), "Claude");
});

test("paneName ignores blank names and ends at the pane id", () => {
  assert.equal(fleet.paneName({ id: "w9:p9", label: "   ", title: "", agent: "  " }), "w9:p9");
  assert.equal(fleet.paneName({ id: "w9:p9" }), "w9:p9");
});

test("paneOwnName never falls back to the agent", () => {
  // The fleet list has its own agent column, so the name column must not
  // repeat it: an unnamed pane is identified by its id instead.
  assert.equal(fleet.paneOwnName({ id: "w1:p1", agent: "agy" }), "w1:p1");
  assert.equal(fleet.paneOwnName({ id: "w1:p1", terminalTitle: "osc", agent: "agy" }), "osc");
  assert.equal(fleet.paneOwnName({ id: "w1:p1", label: "Deploy", agent: "agy" }), "Deploy");
});

test("paneHasName distinguishes a named pane from a bare id", () => {
  assert.equal(fleet.paneHasName({ id: "w1:p1", label: "web" }), true);
  assert.equal(fleet.paneHasName({ id: "w1:p1", agent: "claude" }), true);
  assert.equal(fleet.paneHasName({ id: "w1:p1" }), false);
});

test("shortPaneId drops the workspace prefix", () => {
  assert.equal(fleet.shortPaneId("w7:p1"), "p1");
  assert.equal(fleet.shortPaneId("w7:pJ"), "pJ");
  assert.equal(fleet.shortPaneId("plain"), "plain");
});

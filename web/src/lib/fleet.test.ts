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

test("statusLabel prints the status, never folding an unknown one into idle", () => {
  assert.equal(fleet.statusLabel("blocked"), "needs input");
  assert.equal(fleet.statusLabel("running"), "working");
  assert.equal(fleet.statusLabel("finished"), "finished");
  assert.equal(fleet.statusLabel("idle"), "idle");
  assert.equal(fleet.statusLabel(""), "idle");
  assert.equal(fleet.statusLabel(undefined), "idle");
  // Statuses herdr has not taught the UI about keep their own word, because
  // the tone they fall into is a colour choice, not a status.
  assert.equal(fleet.statusLabel("error"), "error");
  assert.equal(fleet.statusLabel("Paused"), "paused");
  assert.equal(fleet.statusLabel("reviewing tests"), "reviewing tests");
  assert.equal(fleet.isKnownStatus("error"), false);
  assert.equal(fleet.isKnownStatus(" Needs   Input "), true);
});

test("statusLabel and statusChip clip a status that is a whole sentence", () => {
  const long = "waiting for the operator to approve this step";
  // The cut lands on a word boundary, never in the middle of a word.
  assert.equal(fleet.statusLabel(long), "waiting for the…");
  assert.equal(fleet.statusChip(long), "waiting…");
  // One long word has no boundary to land on, so it is cut where the budget ends.
  assert.equal(fleet.statusChip("reconfiguring"), "reconfiguri…");
  // A known word is never clipped, however long the tone label is.
  assert.equal(fleet.statusChip("needs input"), "blocked");
  assert.equal(fleet.statusLabel("needs input"), "needs input");
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

test("idleTileFacts says only what an unread tile can know", () => {
  const base = { id: "w1:p2", workspaceId: "w1" };
  // The tail is what tells two checkouts of one repo apart, so the head of the
  // path is dropped; the tooltip in the tile keeps the whole thing.
  assert.deepEqual(fleet.idleTileFacts({ ...base, cwd: "/Users/op/server/herdr-web" }), {
    cwd: "server/herdr-web",
  });
  // No cwd is no line, not an empty one.
  assert.deepEqual(fleet.idleTileFacts(base), { cwd: "" });
  assert.deepEqual(fleet.idleTileFacts({ ...base, cwd: "" }), { cwd: "" });
  // A known status is already in the header; only an unknown word, which the
  // header chip would clip, is repeated in the body.
  assert.deepEqual(fleet.idleTileFacts({ ...base, agentStatus: "working" }), { cwd: "" });
  assert.deepEqual(fleet.idleTileFacts({ ...base, agentStatus: "waiting for review" }), {
    cwd: "",
    note: "waiting for review",
  });
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

test("paneListName prefers a real name, then the directory, then the id", () => {
  assert.equal(
    fleet.paneListName({ id: "w1:p1", label: "Deploy", cwd: "/srv/app" }, "web"),
    "Deploy",
  );
  // The agent is shown in its own column, so the name column uses the cwd.
  assert.equal(fleet.paneListName({ id: "w1:p1", agent: "agy", cwd: "/srv/app" }, "web"), "app");
  // A directory that merely repeats the workspace name adds nothing.
  assert.equal(fleet.paneListName({ id: "w1:p1", cwd: "/srv/web" }, "web"), "w1:p1");
  assert.equal(fleet.paneListName({ id: "w1:p1" }, "web"), "w1:p1");
});

test("paneNameRepeatsAgent spots a title that is only the agent again", () => {
  // herdr titles an untouched agent pane with the program it runs, so the row's
  // agent chip and its name column would print the same word twice.
  assert.equal(fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", agent: "codex" }, "web"), false);
  assert.equal(
    fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", agent: "codex", terminalTitle: "codex" }, "web"),
    true,
  );
  assert.equal(
    fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", agent: "codex", terminalTitle: " CODEX " }, "web"),
    true,
  );
  // displayAgent wins over agent, as everywhere else in the fleet list.
  assert.equal(
    fleet.paneNameRepeatsAgent(
      { id: "w1:p1", workspaceId: "w1", agent: "codex", displayAgent: "omp", terminalTitle: "omp" },
      "web",
    ),
    true,
  );
  // A renamed pane and a shell pane both say something new.
  assert.equal(
    fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", agent: "codex", terminalTitle: "fix the tests" }, "web"),
    false,
  );
  // A directory that happens to spell the agent is still one word, so it goes.
  assert.equal(
    fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", agent: "app", cwd: "/srv/app" }, "web"),
    true,
  );
  assert.equal(fleet.paneNameRepeatsAgent({ id: "w1:p1", workspaceId: "w1", terminalTitle: "omp" }, "web"), false);
});

test("paneRowName falls back to the pane id instead of repeating the agent", () => {
  assert.equal(fleet.paneRowName({ id: "w1:p2", workspaceId: "w1", agent: "codex" }, "web"), "w1:p2");
  assert.equal(
    fleet.paneRowName({ id: "w1:p2", workspaceId: "w1", agent: "codex", terminalTitle: "codex" }, "web"),
    "p2",
  );
  assert.equal(
    fleet.paneRowName({ id: "w1:p2", workspaceId: "w1", agent: "codex", terminalTitle: "deploy" }, "web"),
    "deploy",
  );
  assert.equal(fleet.paneRowName({ id: "w1:p2", workspaceId: "w1", cwd: "/srv/app" }, "web"), "app");
});

test("paneOwnHasName ignores the agent and the id", () => {
  assert.equal(fleet.paneOwnHasName({ id: "w1:p1", agent: "agy" }), false);
  assert.equal(fleet.paneOwnHasName({ id: "w1:p1", label: "Deploy" }), true);
  assert.equal(fleet.paneOwnHasName({ id: "w1:p1", terminalTitle: "osc" }), true);
});

test("groupFleet orders rows so a group does not reshuffle between polls", () => {
  const groups = fleet.groupFleet(
    [
      { id: "w1:p2", workspaceId: "w1", agentStatus: "idle", agent: "grok", cwd: "/srv/b" },
      { id: "w1:p1", workspaceId: "w1", agentStatus: "idle", agent: "agy", cwd: "/srv/a" },
      { id: "w2:p1", workspaceId: "w2", agentStatus: "idle", agent: "agy", cwd: "/srv/c" },
    ],
    [
      { id: "w1", name: "alpha" },
      { id: "w2", name: "beta" },
    ],
  );
  assert.deepEqual(
    groups[0].items.map((row) => row.pane.id),
    ["w1:p1", "w1:p2", "w2:p1"],
  );
  assert.deepEqual(
    groups[0].items.map((row) => row.workspaceName),
    ["alpha", "alpha", "beta"],
  );
});

test("filterFleet matches every term against what the row shows", () => {
  const rows = [
    { pane: { id: "wE:p4", workspaceId: "wE", agent: "omp", label: "pm-android_dev", cwd: "/srv/app" }, workspaceName: "android_dev" },
    { pane: { id: "w7:p1", workspaceId: "w7", agent: "grok", cwd: "/srv/site" }, workspaceName: "server" },
  ];
  // Empty query keeps everything.
  assert.equal(fleet.filterFleet(rows, "   ").length, 2);
  assert.equal(fleet.filterFleet(rows, "grok").length, 1);
  assert.equal(fleet.filterFleet(rows, "GROK")[0].pane.id, "w7:p1");
  // The workspace name, the pane id and the directory are all searchable.
  assert.equal(fleet.filterFleet(rows, "android").length, 1);
  assert.equal(fleet.filterFleet(rows, "wE:p4").length, 1);
  assert.equal(fleet.filterFleet(rows, "site").length, 1);
  // Terms are ANDed.
  assert.equal(fleet.filterFleet(rows, "omp android_dev").length, 1);
  assert.equal(fleet.filterFleet(rows, "omp server").length, 0);
  // A term that matches nothing narrows to nothing.
  assert.equal(fleet.filterFleet(rows, "zzz").length, 0);
});

test("shortPaneId drops the workspace prefix", () => {
  assert.equal(fleet.shortPaneId("w7:p1"), "p1");
  assert.equal(fleet.shortPaneId("w7:pJ"), "pJ");
  assert.equal(fleet.shortPaneId("plain"), "plain");
});

test("mostUrgentPane prefers blocked, then focused, then the first", () => {
  assert.equal(
    fleet.mostUrgentPane([
      { id: "a", workspaceId: "w", agentStatus: "idle" },
      { id: "b", workspaceId: "w", agentStatus: "blocked" },
    ])?.id,
    "b",
  );
  assert.equal(
    fleet.mostUrgentPane([
      { id: "a", workspaceId: "w", agentStatus: "idle" },
      { id: "b", workspaceId: "w", agentStatus: "working", focused: true },
    ])?.id,
    "b",
  );
  assert.equal(fleet.mostUrgentPane([{ id: "a", workspaceId: "w" }])?.id, "a");
  assert.equal(fleet.mostUrgentPane([]), undefined);
});

test("orderByTone sorts by status and keeps the original order within a tone", () => {
  const items = [
    { id: "a", status: "idle" },
    { id: "b", status: "blocked" },
    { id: "c", status: "working" },
    { id: "d", status: "idle" },
  ];
  assert.deepEqual(
    fleet.orderByTone(items, (item) => fleet.toneOf(item.status)).map((item) => item.id),
    ["b", "c", "a", "d"],
  );
});

test("the daemon label keeps the last octet and drops loopback", () => {
  assert.equal(fleet.hostOctet("100.89.0.4"), "4");
  assert.equal(fleet.hostOctet("100.89.0.200"), "200");
  assert.equal(fleet.hostOctet("127.0.0.1"), "");
  assert.equal(fleet.hostOctet("localhost"), "");
  assert.equal(fleet.hostOctet("  "), "");
  // A name that is not an address is kept whole rather than mangled.
  assert.equal(fleet.hostOctet("m9.local"), "m9.local");
});

test("collectCommand names the machine, the checkout and the branch", () => {
  assert.equal(
    fleet.collectCommand("http://100.89.0.4:5000", "/home/g/.herdr/worktrees/web", "job/audit"),
    "git fetch 100.89.0.4:/home/g/.herdr/worktrees/web job/audit",
  );
  // A detached job still has a HEAD to fetch.
  assert.equal(
    fleet.collectCommand("http://100.89.0.4:5000", "/home/g/.herdr/worktrees/web", ""),
    "git fetch 100.89.0.4:/home/g/.herdr/worktrees/web HEAD",
  );
  // Without a checkout there is nothing to collect.
  assert.equal(fleet.collectCommand("http://100.89.0.4:5000", "", "job/audit"), "");
  // A path with a space stays one argument.
  assert.equal(
    fleet.collectCommand("http://m9.local:5000", "/tmp/a b", "job/x"),
    "git fetch 'm9.local:/tmp/a b' job/x",
  );
  // A host written without a scheme loses the console port, not the hostname.
  assert.equal(
    fleet.collectCommand("100.89.0.4:5000", "/srv/wt", "job/x"),
    "git fetch 100.89.0.4:/srv/wt job/x",
  );
});

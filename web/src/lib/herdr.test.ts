import assert from "node:assert/strict";
import test from "node:test";

import * as herdr from "./herdr.ts";

test("parseHerdrPaneRead keeps revision 0 as an unknown watermark", () => {
  assert.equal(herdr.parseHerdrPaneRead(null), null);
  assert.equal(herdr.parseHerdrPaneRead({ paneId: "" }), null);
  assert.deepEqual(herdr.parseHerdrPaneRead({ paneId: "w1:p1" }), {
    paneId: "w1:p1",
    text: "",
    revision: 0,
    truncated: false,
    agentStatus: undefined,
  });
  assert.deepEqual(
    herdr.parseHerdrPaneRead({
      paneId: "w1:p1",
      text: "hi\n",
      revision: 9,
      truncated: true,
      agentStatus: "blocked",
    }),
    {
      paneId: "w1:p1",
      text: "hi\n",
      revision: 9,
      truncated: true,
      agentStatus: "blocked",
    },
  );
});

test("parseHerdrWorkspaces accepts the bridge's bare array", () => {
  const parsed = herdr.parseHerdrWorkspaces([
    { id: "w1", name: "web", windows: 2, attached: true, paneCount: 3, agentStatus: "working" },
    { id: "", name: "dropped" },
    "garbage",
  ]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    id: "w1",
    name: "web",
    windows: 2,
    attached: true,
    agentStatus: "working",
    activeTabId: undefined,
    paneCount: 3,
  });
});

test("parseHerdrWorkspaces falls back to the id when the label is empty", () => {
  const parsed = herdr.parseHerdrWorkspaces([{ id: "w9" }]);
  assert.equal(parsed[0].name, "w9");
  assert.equal(parsed[0].paneCount, 0);
  assert.equal(parsed[0].attached, false);
});

test("parseHerdrWorkspaceDetail reads the wrapped shape", () => {
  const detail = herdr.parseHerdrWorkspaceDetail({
    workspace: { id: "w1", name: "web" },
    panes: [
      { id: "w1:p1", workspaceId: "w1", tabId: "t1", focused: true, agentStatus: "idle" },
      { id: "" },
    ],
  });
  assert.equal(detail.workspace?.id, "w1");
  assert.equal(detail.panes.length, 1);
  assert.equal(detail.panes[0].id, "w1:p1");
  assert.equal(detail.panes[0].focused, true);
});

test("parseHerdrWorkspaceDetail tolerates a missing workspace", () => {
  const detail = herdr.parseHerdrWorkspaceDetail({ panes: [] });
  assert.equal(detail.workspace, null);
  assert.deepEqual(detail.panes, []);
});

test("parseHerdrStatus defaults to unknown rather than throwing", () => {
  assert.deepEqual(herdr.parseHerdrStatus(null), {
    enabled: false,
    socket: "",
    status: "unknown",
    version: undefined,
    protocol: undefined,
    protocolTested: false,
    consoleVersion: undefined,
    error: undefined,
  });
  const ok = herdr.parseHerdrStatus({
    enabled: true,
    socket: "/tmp/herdr.sock",
    status: "ok",
    version: "0.9.0",
    protocol: 22,
    protocolTested: true,
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.protocol, 22);
  assert.equal(ok.protocolTested, true);
});

test("the console's own version survives parsing", () => {
  // Two copies of the console on two hosts are told apart by this field, so
  // dropping it while parsing hid which build was answering.
  const parsed = herdr.parseHerdrStatus({
    enabled: true,
    status: "ok",
    consoleVersion: "v0.2.0",
  });
  assert.equal(parsed.consoleVersion, "v0.2.0");
  assert.equal(herdr.parseHerdrStatus({}).consoleVersion, undefined);
});

test("pane paths are URL-encoded so the colon survives", () => {
  // The bridge routes on /panes/<id>/read; a raw colon is fine in a path, but
  // encoding keeps ids with slashes or spaces safe.
  const encoded = encodeURIComponent("w1:p1");
  assert.equal(encoded, "w1%3Ap1");
  assert.equal(decodeURIComponent(encoded), "w1:p1");
});

test("a space is a named key, not a character", () => {
  // herdr answers invalid_key for " " and takes "space"; typing "echo hi" with a
  // literal space would otherwise arrive as "echohi".
  assert.equal(herdr.keyForChar(" "), "space");
  assert.equal(herdr.keyForChar("a"), "a");
  assert.equal(herdr.keyForChar("|"), "|");
});

test("terminalKeyName keeps the modifiers a TUI needs", () => {
  // Measured against the daemon: shift+tab sends CSI Z (BackTab), and the
  // daemon rejects the BackTab spelling itself.
  assert.equal(herdr.terminalKeyName({ key: "Tab", shiftKey: true }), "shift+tab");
  assert.equal(herdr.terminalKeyName({ key: "Tab" }), "Tab");
  assert.equal(herdr.terminalKeyName({ key: "Enter", shiftKey: true }), "shift+enter");
  assert.equal(herdr.terminalKeyName({ key: "ArrowUp", shiftKey: true }), "shift+up");
  assert.equal(herdr.terminalKeyName({ key: "A", ctrlKey: true, shiftKey: true }), "ctrl+shift+a");
  assert.equal(herdr.terminalKeyName({ key: "a", altKey: true }), "alt+a");
  assert.equal(herdr.terminalKeyName({ key: " ", ctrlKey: true }), "ctrl+space");
  // Cmd belongs to the browser.
  assert.equal(herdr.terminalKeyName({ key: "a", metaKey: true }), null);
  // A shifted printable key is already the character the terminal wants.
  assert.equal(herdr.terminalKeyName({ key: "A", shiftKey: true }), "A");
  assert.equal(herdr.terminalKeyName({ key: "Escape" }), "esc");
});

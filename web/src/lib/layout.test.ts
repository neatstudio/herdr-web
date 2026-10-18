import assert from "node:assert/strict";
import test from "node:test";

import * as layout from "./layout.ts";

const split: layout.PaneLayout = {
  tabId: "w1:t1",
  workspaceId: "w1",
  zoomed: false,
  area: { x: 0, y: 0, width: 120, height: 40 },
  focusedPaneId: "w1:p1",
  panes: [
    { id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 60, height: 40 } },
  ],
};

test("a side-by-side split keeps herdr's own arrangement", () => {
  assert.deepEqual(layout.arrangeTiles(split, "side"), [
    { id: "w1:p1", focused: true, left: 0, top: 0, width: 50, height: 100 },
    { id: "w1:p2", focused: false, left: 50, top: 0, width: 50, height: 100 },
  ]);
});

test("the same split stacks on a phone", () => {
  // Two 60-column panes side by side on a phone would leave neither readable.
  assert.deepEqual(layout.arrangeTiles(split, "stack"), [
    { id: "w1:p1", focused: true, left: 0, top: 0, width: 100, height: 50 },
    { id: "w1:p2", focused: false, left: 0, top: 0, width: 100, height: 50 },
  ]);
});

test("a nested split is just more boxes", () => {
  const nested: layout.PaneLayout = {
    ...split,
    panes: [
      { id: "a", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
      { id: "b", focused: false, rect: { x: 60, y: 0, width: 60, height: 20 } },
      { id: "c", focused: false, rect: { x: 60, y: 20, width: 60, height: 20 } },
    ],
  };
  assert.deepEqual(
    layout.arrangeTiles(nested, "side").map((tile) => [tile.id, tile.left, tile.top, tile.width, tile.height]),
    [
      ["a", 0, 0, 50, 100],
      ["b", 50, 0, 50, 50],
      ["c", 50, 50, 50, 50],
    ],
  );
});

test("a zoomed tab is one pane filling the stage", () => {
  const zoomed = { ...split, zoomed: true, focusedPaneId: "w1:p2" };
  assert.deepEqual(layout.arrangeTiles(zoomed, "side"), [
    { id: "w1:p2", focused: true, left: 0, top: 0, width: 100, height: 100 },
  ]);
});

test("a single pane fills the stage in either mode", () => {
  const single: layout.PaneLayout = {
    ...split,
    panes: [{ id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }],
  };
  for (const mode of ["side", "stack"] as const) {
    assert.deepEqual(layout.arrangeTiles(single, mode), [
      { id: "w1:p1", focused: true, left: 0, top: 0, width: 100, height: 100 },
    ]);
  }
});

test("no layout, or no area, still produces usable tiles", () => {
  assert.deepEqual(layout.arrangeTiles(null, "side"), []);
  assert.deepEqual(layout.arrangeTiles({ ...split, panes: [] }, "side"), []);
  // A tab that reports no area must not divide by zero.
  const flat = layout.arrangeTiles({ ...split, area: { x: 0, y: 0, width: 0, height: 0 } }, "side");
  assert.deepEqual(
    flat.map((tile) => [tile.top, tile.height]),
    [
      [0, 50],
      [50, 50],
    ],
  );
});

test("tabsOf lists one entry per tab, named by the focused pane", () => {
  const panes = [
    { id: "w1:p1", tabId: "w1:t1", focused: false },
    { id: "w1:p2", tabId: "w1:t1", focused: true },
    { id: "w1:p3", tabId: "w1:t2", focused: false },
  ];
  assert.deepEqual(
    layout.tabsOf(panes).map((tab) => [tab.tabId, tab.pane.id]),
    [
      ["w1:t1", "w1:p2"],
      ["w1:t2", "w1:p3"],
    ],
  );
});

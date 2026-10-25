import assert from "node:assert/strict";
import test from "node:test";

import { holdCreatedPane, type CreatedPane } from "./createdPane.ts";
import type { HerdrPane } from "./herdr.ts";

const GRACE = 9000;

function pane(id: string, extra: Partial<HerdrPane> = {}): HerdrPane {
  return {
    id,
    workspaceId: "w1",
    tabId: `w1:t${id.split(":p").at(-1)}`,
    focused: false,
    agentStatus: "unknown",
    ...extra,
  };
}

const OLD = pane("w1:p1", { focused: true });
const NEW = pane("w1:p9");

function created(at = 1000): CreatedPane {
  return { pane: NEW, at };
}

test("a poll with nothing pending is passed through unchanged", () => {
  const held = holdCreatedPane(null, [OLD], 5000, GRACE);
  assert.deepEqual(held.panes, [OLD]);
  assert.equal(held.pending, null);
});

test("a pane herdr does not list yet stays in the view", () => {
  const held = holdCreatedPane(created(1000), [OLD], 2500, GRACE);
  assert.deepEqual(held.panes, [OLD, NEW]);
  // The caller keeps holding it, so the next poll is covered as well.
  assert.deepEqual(held.pending, created(1000));
});

test("once herdr lists the pane the poll is the truth and nothing is added twice", () => {
  const fromHerdr = pane("w1:p9", { tabId: "w1:t9", focused: true, terminalTitle: "shell" });
  const held = holdCreatedPane(created(1000), [OLD, fromHerdr], 2500, GRACE);
  assert.deepEqual(held.panes, [OLD, fromHerdr]);
  assert.equal(held.pending, null);
  // The daemon's own record — not the guess — is what the view now holds.
  assert.equal(held.panes[1].terminalTitle, "shell");
});

test("a pane that never appears gives the view back when the grace runs out", () => {
  const held = holdCreatedPane(created(1000), [OLD], 1000 + GRACE, GRACE);
  assert.deepEqual(held.panes, [OLD]);
  assert.equal(held.pending, null);
});

test("the grace boundary is inclusive, so the hold is not one poll too long", () => {
  assert.equal(holdCreatedPane(created(0), [OLD], GRACE - 1, GRACE).pending === null, false);
  assert.equal(holdCreatedPane(created(0), [OLD], GRACE, GRACE).pending, null);
});

test("the poll's own list is never mutated", () => {
  const polled = [OLD];
  const held = holdCreatedPane(created(), polled, 2000, GRACE);
  assert.equal(polled.length, 1);
  assert.notEqual(held.panes, polled);
});

test("a pane the operator closed during the grace is not resurrected", () => {
  // Closing a pane the console just made is the one case where "gone" is real:
  // the console emptied its own list, and herdr agrees. The hold expires like any
  // other, so the pane comes back for at most the rest of the grace.
  const held = holdCreatedPane(created(1000), [], 1500, GRACE);
  assert.deepEqual(held.panes, [NEW]);
  const after = holdCreatedPane(created(1000), [], 1000 + GRACE, GRACE);
  assert.deepEqual(after.panes, []);
});

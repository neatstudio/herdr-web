import assert from "node:assert/strict";
import test from "node:test";

import { isClientViewPanel } from "./clientView.ts";

const PANEL = [
  "Daily   ■■■■■■■■■■■■■■■■■■■■  65% used  · resets in 9h 47m",
  "Weekly  ■■■■■■■■■■■■■■■■■■■■  33% used  · resets Oct 25, 8:00 AM (UTC)",
  "",
  "This session",
  "Activity  1 turn · 22 tool calls · 0 files · 6 commands",
  "Tokens    108k in · 2.1k out  (~110k per turn)",
  "Model     Claude Opus 5.5 Medium",
].join("\n");

test("the account panel is read as one block", () => {
  assert.equal(isClientViewPanel(PANEL), true);
});

test("a panel without the session section is still a panel", () => {
  const text = ["Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m", "Model     Claude Opus 5.5 Medium"].join(
    "\n",
  );
  assert.equal(isClientViewPanel(text), true);
});

test("one label alone is not a panel", () => {
  // A single footer row leaks into an answer every now and then; drawing that
  // as a monospace block would be noise, not a panel.
  assert.equal(isClientViewPanel("Model     Claude Opus 5.5 Medium"), false);
});

test("prose that mentions a model is not a panel", () => {
  const text = ["Model 是 Claude Opus 5.5", "Tokens 那一行我只看了眼总量。"].join("\n");
  assert.equal(isClientViewPanel(text), false);
});

test("prose with one label row mixed in is not a panel", () => {
  const text = ["我先看了一下用量：", "Daily   ■■■■■■■■■■■■■■■■■■■■  65% used"].join("\n");
  assert.equal(isClientViewPanel(text), false);
});

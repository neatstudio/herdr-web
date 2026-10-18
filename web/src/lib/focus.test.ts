import assert from "node:assert/strict";
import test from "node:test";

import * as focus from "./focus.ts";

test("a bare Tab or Enter is claimed for the prompt", () => {
  assert.equal(focus.shouldClaimKey("Tab", { tagName: "BODY" }), true);
  assert.equal(focus.shouldClaimKey("Enter", { tagName: "BODY" }), true);
  // The transcript is a plain div: pressing Tab there should reach the prompt.
  assert.equal(focus.shouldClaimKey("Tab", { tagName: "DIV" }), true);
  assert.equal(focus.shouldClaimKey("Enter", null), true);
});

test("keys that belong to a focused control are left alone", () => {
  // Otherwise Enter on a focused button would jump instead of pressing it.
  for (const tagName of ["BUTTON", "A", "SELECT", "TEXTAREA", "SUMMARY"]) {
    assert.equal(focus.shouldClaimKey("Enter", { tagName }), false, tagName);
    assert.equal(focus.shouldClaimKey("Tab", { tagName }), false, tagName);
  }
  // The prompt itself handles its own Enter and Tab.
  assert.equal(focus.shouldClaimKey("Enter", { tagName: "INPUT" }), false);
  assert.equal(focus.shouldClaimKey("Tab", { tagName: "INPUT" }), false);
  assert.equal(focus.shouldClaimKey("Enter", { tagName: "DIV", isContentEditable: true }), false);
});

test("only Tab and Enter are ever claimed", () => {
  for (const key of ["Escape", "a", "ArrowUp", " ", "F1"]) {
    assert.equal(focus.shouldClaimKey(key, { tagName: "BODY" }), false, key);
  }
});

test("a caret is only taken where a keyboard is the primary input", () => {
  assert.equal(focus.keyboardIsPrimary(() => true), true);
  assert.equal(focus.keyboardIsPrimary(() => false), false);
  // A touch phone reports neither hover nor a fine pointer.
  assert.equal(
    focus.keyboardIsPrimary((query) => query.includes("pointer: fine") === false),
    false,
  );
});

test("the prompt id is the one the page and the tests use", () => {
  assert.equal(focus.PROMPT_ID, "herdr-input");
});

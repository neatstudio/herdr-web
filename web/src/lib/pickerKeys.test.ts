import assert from "node:assert/strict";
import test from "node:test";

import { pickerKeyName, isTypingTarget, PICKER_EVENT_KEYS } from "./pickerKeys.ts";

test("the arrows, Enter and Escape reach a blocked pane", () => {
  assert.equal(pickerKeyName({ key: "ArrowUp" }, { tagName: "BODY" }), "Up");
  assert.equal(pickerKeyName({ key: "ArrowDown" }, { tagName: "BODY" }), "Down");
  assert.equal(pickerKeyName({ key: "ArrowLeft" }, { tagName: "BODY" }), "Left");
  assert.equal(pickerKeyName({ key: "ArrowRight" }, { tagName: "BODY" }), "Right");
  assert.equal(pickerKeyName({ key: "Escape" }, { tagName: "BODY" }), "esc");
  // Nothing focused at all is the same as focus on the page.
  assert.equal(pickerKeyName({ key: "ArrowDown" }, null), "Down");
  assert.equal(pickerKeyName({ key: "Enter" }, null), "Enter");
});

test("typing keeps every key it owns", () => {
  for (const tagName of ["TEXTAREA", "INPUT", "SELECT"]) {
    assert.equal(isTypingTarget({ tagName }), true, tagName);
    assert.equal(pickerKeyName({ key: "ArrowUp" }, { tagName }), null, tagName);
    assert.equal(pickerKeyName({ key: "Enter" }, { tagName }), null, tagName);
    assert.equal(pickerKeyName({ key: "Escape" }, { tagName }), null, tagName);
  }
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(pickerKeyName({ key: "ArrowUp" }, { tagName: "DIV", isContentEditable: true }), null);
  // A plain element is not a caret: the transcript is a div.
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
});

test("Enter belongs to whatever is focused, unless nothing is", () => {
  for (const tagName of ["BUTTON", "A", "SUMMARY"]) {
    assert.equal(pickerKeyName({ key: "Enter" }, { tagName }), null, tagName);
    // Escape has no owner on a button, so the pane still gets it.
    assert.equal(pickerKeyName({ key: "Escape" }, { tagName }), "esc", tagName);
  }
});

test("modified presses stay with the page", () => {
  for (const modifier of ["ctrlKey", "altKey", "shiftKey", "metaKey"]) {
    assert.equal(pickerKeyName({ key: "ArrowUp", [modifier]: true }, { tagName: "BODY" }), null, modifier);
    assert.equal(pickerKeyName({ key: "Enter", [modifier]: true }, null), null, modifier);
  }
});

test("only the picker's keys are taken", () => {
  for (const key of ["a", " ", "Tab", "Home", "PageDown", "Backspace", "F1"]) {
    assert.equal(pickerKeyName({ key }, { tagName: "BODY" }), null, key);
  }
  assert.deepEqual([...PICKER_EVENT_KEYS].sort(), [
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "Enter",
    "Escape",
  ]);
});

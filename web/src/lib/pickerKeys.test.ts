import assert from "node:assert/strict";
import test from "node:test";

import {
  pickerKeyName,
  isTypingTarget,
  showsPicker,
  PICKER_EVENT_KEYS,
} from "./pickerKeys.ts";

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

test("a menu herdr never reported as blocked still shows its bar", () => {
  // The three shapes the agents on this machine actually draw. Codex and
  // Claude Code answer with `blocked`; a third-party agent answers with
  // `working` and this is the only thing left to read.
  assert.equal(
    showsPicker(
      "  Do you want to proceed?\n" +
        "  ❯ 1. Yes\n" +
        "    2. Yes, and don't ask again for bash\n" +
        "    3. No\n\n" +
        "  Esc to cancel · Tab to amend",
    ),
    true,
    "claude code",
  );
  assert.equal(
    showsPicker(
      "  › 1. Yes, proceed\n" +
        "    2. No, and tell Codex what to do differently\n\n" +
        "  Press enter to confirm or esc to cancel",
    ),
    true,
    "codex",
  );
  assert.equal(showsPicker("  [1] keep   [2] skip   [3] edit   esc cancel"), true, "inline row");
  // Colour, box drawing and a gutter are all just noise to the reader.
  assert.equal(
    showsPicker(
      "\u001b[2m│\u001b[0m \u001b[36m❯ 1.\u001b[0m keep\n" +
        "│   2. skip\n" +
        "│\n" +
        "│ \u001b[2m↑/↓ to move · Enter to select\u001b[0m",
    ),
    true,
    "ansi and box",
  );
});

test("prose about a menu is not a menu", () => {
  // An answer that quotes a menu must not summon a key bar: the reader is
  // reading, not choosing.
  assert.equal(showsPicker("The prompt asks:\n1. Yes\n2. No\n"), false, "quoted list");
  assert.equal(showsPicker("Esc to cancel\n"), false, "hint without options");
  assert.equal(showsPicker("1. Yes\n2. No\n\nThat is what it would ask."), false, "trailing prose");
  assert.equal(showsPicker(""), false, "empty pane");
  assert.equal(showsPicker("\n\n\n"), false, "blank pane");
});

test("a menu the agent already answered is history, not a question", () => {
  // The options stay inside the tail, but the hint is nine lines up: that menu
  // was answered and the pane has moved on.
  const answered = [
    "❯ 1. Yes",
    "  2. No",
    "Esc to cancel",
    ...Array.from({ length: 9 }, (_, i) => `▸ ran tool ${i + 1}`),
  ].join("\n");
  assert.equal(showsPicker(answered), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  pickerKeyName,
  isTypingTarget,
  parsePickerOptions,
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

test("a menu's answers come back as the digits a thumb can press", () => {
  const claude = [
    "Which file should the change land in?",
    "  1. src/lib/find.ts",
    "  2. src/lib/pickerKeys.ts",
    "  3. somewhere else",
    "Esc to cancel · Tab to amend",
  ].join("\n");
  assert.deepEqual(parsePickerOptions(claude), [
    { key: "1", label: "src/lib/find.ts" },
    { key: "2", label: "src/lib/pickerKeys.ts" },
    { key: "3", label: "somewhere else" },
  ]);

  // An inline row answers several questions in one line, and the hint keeps
  // its own column: the gap is what separates an answer from the key legend.
  assert.deepEqual(parsePickerOptions("  [1] keep   [2] skip   [3] edit   esc cancel"), [
    { key: "1", label: "keep" },
    { key: "2", label: "skip" },
    { key: "3", label: "edit" },
  ]);

  // Colour, a box, a cursor glyph and a `(2)` marker are all still a menu.
  const boxed = [
    "\u001b[2m╭─────────────╮\u001b[0m",
    "│ ❯ (1) yes   │",
    "│   (2) no    │",
    "╰─────────────╯",
    "Press enter to confirm or esc to cancel",
  ].join("\n");
  assert.deepEqual(parsePickerOptions(boxed), [
    { key: "1", label: "yes" },
    { key: "2", label: "no" },
  ]);
});

test("a number inside an answer is text, not another answer", () => {
  // One row, one answer: "2." here is part of the label, not a second option.
  assert.equal(parsePickerOptions(["1. run step 2. then stop", "Esc to cancel"].join("\n")), null);
  // Answers separated by a single space are too tight to tell labels apart;
  // the bar stays as the fallback rather than guessing a label.
  assert.equal(parsePickerOptions("[1] keep [2] skip\nEsc to cancel"), null);
});

test("without a menu there is nothing to press", () => {
  assert.equal(parsePickerOptions(""), null, "empty snapshot");
  assert.equal(parsePickerOptions("just prose, no options at all"), null);
  // Options alone are a list, not a question: no hint, no chips.
  assert.equal(parsePickerOptions("1. first\n2. second\n3. third"), null);
  // A single option cannot be a choice, even with a hint under it.
  assert.equal(parsePickerOptions("1. continue\nEsc to cancel"), null);
  // A menu the agent already answered belongs to history.
  assert.equal(
    parsePickerOptions(["1. yes", "2. no", "Enter to confirm", ...Array.from({ length: 9 }, () => "▸ ran tool")].join("\n")),
    null,
  );
});

test("a long answer is clipped in the middle, so its tail survives", () => {
  const long = "x".repeat(80);
  const parsed = parsePickerOptions(["1. " + long, "2. short", "Esc to cancel"].join("\n"));
  assert.deepEqual(
    parsed?.map((option) => option.label.length),
    [26, 5],
  );
  assert.equal(parsed?.[0].label, `${"x".repeat(11)}…${"x".repeat(14)}`);

  // Two paths that share a prefix stay distinguishable at the chip's width.
  const paths = parsePickerOptions(
    ["1. /Users/gouki/server/herdr-web/alpha", "2. /Users/gouki/server/herdr-web/beta", "Esc to cancel"].join(
      "\n",
    ),
  );
  assert.equal(paths?.[0].label, "/Users/gouk…erdr-web/alpha");
  assert.equal(paths?.[1].label, "/Users/gouk…herdr-web/beta");
});

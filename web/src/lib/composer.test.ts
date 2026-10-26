import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ACTIONS,
  COMPOSER_MAX_ROWS,
  COMPOSER_VIEWPORT_SHARE,
  KEYBOARD_STACK_MIN,
  applyCompletion,
  clearDraft,
  draftKey,
  fitComposer,
  imeEnter,
  keyboardInset,
  mentionItems,
  mentionQuery,
  readDraft,
  scoreMatches,
  sendTrouble,
  slashQuery,
  writeDraft,
  type ComposerItem,
  type DraftStore,
} from "./composer.ts";

/* --------------------------------------------------------------- drafts */

function fakeStore(seed: Record<string, string> = {}): DraftStore & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

test("draftKey is namespaced per pane", () => {
  assert.equal(draftKey("w1:p1"), "herdr:draft:w1:p1");
  assert.notEqual(draftKey("w1:p1"), draftKey("w1:p2"));
});

test("drafts round-trip per pane and never bleed across panes", () => {
  const store = fakeStore();
  writeDraft(store, "w1:p1", "half a sentence");
  assert.equal(readDraft(store, "w1:p1"), "half a sentence");
  assert.equal(readDraft(store, "w1:p2"), "");
  writeDraft(store, "w1:p2", "other");
  assert.equal(readDraft(store, "w1:p1"), "half a sentence");
  clearDraft(store, "w1:p1");
  assert.equal(readDraft(store, "w1:p1"), "");
  assert.equal(readDraft(store, "w1:p2"), "other");
});

test("an empty draft removes the key instead of storing blanks", () => {
  const store = fakeStore({ "herdr:draft:w1:p1": "text" });
  writeDraft(store, "w1:p1", "");
  assert.equal(store.entries.has("herdr:draft:w1:p1"), false);
  assert.equal(readDraft(store, "w1:p1"), "");
});

test("storage failures are quiet: no draft is better than a thrown keystroke", () => {
  const hostile: DraftStore = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readDraft(hostile, "w1:p1"), "");
  assert.doesNotThrow(() => writeDraft(hostile, "w1:p1", "text"));
  assert.doesNotThrow(() => clearDraft(hostile, "w1:p1"));
  assert.equal(readDraft(null, "w1:p1"), "");
  assert.doesNotThrow(() => writeDraft(null, "w1:p1", "text"));
});

/* ---------------------------------------------------------- slash query */

test("slashQuery only fires at the start of a line", () => {
  assert.deepEqual(slashQuery("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(slashQuery("/task", 5), { start: 0, end: 5, query: "task" });
  assert.deepEqual(slashQuery("  /stop", 7), { start: 2, end: 7, query: "stop" });
  assert.deepEqual(slashQuery("hi\n/model", 9), { start: 3, end: 9, query: "model" });
  assert.equal(slashQuery("", 0), null);
  assert.equal(slashQuery("a /model", 8), null);
  assert.equal(slashQuery("first\nsecond", 12), null);
});

test("slashQuery covers the whole token, but not the argument after a space", () => {
  // Caret in the middle of the word: the menu replaces the whole command.
  assert.deepEqual(slashQuery("/ta|sk".replace("|", ""), 3), { start: 0, end: 5, query: "ta" });
  // Once there is a space the command is done and the palette closes.
  assert.equal(slashQuery("/task foo", 9), null);
  // An unknown command keeps its text: detection is not acceptance.
  assert.deepEqual(slashQuery("/tmp/x", 6), { start: 0, end: 6, query: "tmp/x" });
});

/* -------------------------------------------------------- mention query */

test("mentionQuery reads the word under the caret", () => {
  assert.deepEqual(mentionQuery("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionQuery("@tmp", 4), { start: 0, end: 4, query: "tmp" });
  assert.deepEqual(mentionQuery("@tmp", 2), { start: 0, end: 4, query: "t" });
  assert.deepEqual(mentionQuery("ping @w1:p1 now", 10), { start: 5, end: 11, query: "w1:p" });
  assert.deepEqual(mentionQuery("(@tmp/x", 5), { start: 1, end: 7, query: "tmp" });
  assert.deepEqual(mentionQuery("hello,@tmp", 10), { start: 6, end: 10, query: "tmp" });
});

test("mentionQuery ignores addresses and mentions the caret is not inside", () => {
  assert.equal(mentionQuery("foo@bar.com", 11), null);
  assert.equal(mentionQuery("mail me at a@b", 15), null);
  assert.equal(mentionQuery("first @one second", 6), null);
  assert.equal(mentionQuery("first @one second", 0), null);
  assert.equal(mentionQuery("", 0), null);
  assert.deepEqual(mentionQuery("@one @two", 9), { start: 5, end: 9, query: "two" });
});

/* --------------------------------------------------------- completion */

test("applyCompletion replaces the token and puts the caret after the insert", () => {
  assert.deepEqual(
    applyCompletion("/ta", 3, { start: 0, end: 3, query: "ta", value: "" }),
    { text: "", caret: 0 },
  );
  assert.deepEqual(
    applyCompletion("say @tm please", 7, { start: 4, end: 7, query: "tm", value: "@w1:p1 " }),
    { text: "say @w1:p1  please", caret: 11 },
  );
  assert.deepEqual(
    applyCompletion("look at /tmp/a b", 14, { start: 8, end: 14, query: "tmp/a", value: "" }),
    { text: "look at  b", caret: 8 },
  );
});

test("applyCompletion keeps the rest of a multi-line draft intact", () => {
  const text = "first line\n/pal";
  const result = applyCompletion(text, text.length, { start: 11, end: 15, query: "pal", value: "" });
  assert.deepEqual(result, { text: "first line\n", caret: 11 });
});

/* ------------------------------------------------------------ ranking */

const items: ComposerItem[] = [
  { value: "@w1:p1", label: "planner", kind: "pane", hint: "w1:p1" },
  { value: "@w1:p2", label: "builder", kind: "pane", hint: "w1:p2", keywords: ["web"] },
  { value: "@w2:p1", label: "reviewer", kind: "pane", hint: "w2:p1" },
  { value: "@main", label: "main", kind: "workspace", hint: "main" },
];

test("scoreMatches keeps order for an empty query and drops everything for no match", () => {
  assert.deepEqual(scoreMatches("", items).map((item) => item.value), items.map((item) => item.value));
  assert.deepEqual(scoreMatches("   ", items).map((item) => item.label), items.map((item) => item.label));
  assert.deepEqual(scoreMatches("zzz", items), []);
});

test("scoreMatches ranks exact, then prefix, then word-start, then substring", () => {
  assert.deepEqual(scoreMatches("main", items).map((item) => item.label), ["main"]);
  assert.deepEqual(scoreMatches("pla", items).map((item) => item.label), ["planner"]);
  // "w1:p2" matches the value of p2, and the id behind the label of p1/p2.
  assert.deepEqual(scoreMatches("w1:p2", items).map((item) => item.value), ["@w1:p2"]);
  // Case-insensitive, and a keyword beats nothing.
  assert.deepEqual(scoreMatches("WEB", items).map((item) => item.value), ["@w1:p2"]);
  // A prefix beats an inner substring.
  const ordered = scoreMatches("e", [
    { value: "x-reviewer", label: "x-reviewer", kind: "k" },
    { value: "editor", label: "editor", kind: "k" },
  ]);
  assert.deepEqual(ordered.map((entry) => entry.label), ["editor", "x-reviewer"]);
});

test("scoreMatches is stable for equal scores", () => {
  const twins: ComposerItem[] = [
    { value: "@a", label: "same", kind: "pane" },
    { value: "@b", label: "same", kind: "pane" },
  ];
  assert.deepEqual(scoreMatches("same", twins).map((item) => item.value), ["@a", "@b"]);
});

/* ------------------------------------------------------- mention items */

test("mentionItems labels panes readably and inserts the pane id", () => {
  const rows = mentionItems({ panes: [{ id: "w1:p1" }, { id: "w1:p2", name: "builder", agent: "claude" }] });
  assert.deepEqual(rows, [
    { value: "@w1:p1", label: "w1:p1", kind: "pane", hint: "w1:p1", keywords: ["w1:p1"] },
    {
      value: "@w1:p2",
      label: "builder",
      kind: "pane",
      hint: "w1:p2",
      keywords: ["w1:p2", "claude"],
    },
  ]);
});

test("mentionItems lists workspaces by id and known files by their quoted path", () => {
  const rows = mentionItems({
    workspaces: [{ id: "main", name: "herdr-web" }],
    files: ["/Users/gouki/server/herdr-web/web/src/App.tsx", "/tmp/two words.md", "/tmp/a.ts", "/tmp/a.ts"],
  });
  assert.deepEqual(
    rows.map((row) => ({ kind: row.kind, value: row.value, label: row.label })),
    [
      { kind: "workspace", value: "@main", label: "herdr-web" },
      { kind: "file", value: "/Users/gouki/server/herdr-web/web/src/App.tsx", label: "App.tsx" },
      { kind: "file", value: "\"/tmp/two words.md\"", label: "two words.md" },
      { kind: "file", value: "/tmp/a.ts", label: "a.ts" },
    ],
  );
  assert.deepEqual(rows[0].keywords, []);
});

/* ------------------------------------------------------ app actions */

test("APP_ACTIONS covers the six app actions and filters by their labels", () => {
  assert.deepEqual(
    APP_ACTIONS.map((item) => item.action),
    ["chat", "terminal", "files", "upload", "workspace", "stop"],
  );
  for (const item of APP_ACTIONS) {
    assert.notEqual(item.value, "");
    assert.ok(scoreMatches(item.value.slice(1), APP_ACTIONS).includes(item), item.value);
  }
  assert.deepEqual(scoreMatches("st", APP_ACTIONS).map((item) => item.action), ["stop"]);
  assert.deepEqual(scoreMatches("file", APP_ACTIONS).map((item) => item.action), ["files", "upload"]);
  assert.deepEqual(scoreMatches("zzz", APP_ACTIONS), []);
});

/* --------------------------------------------------- enter key */

test("an IME keeps its Enter", () => {
  // The composing Enter picks a candidate; only a plain Enter sends.
  assert.equal(imeEnter({}), false);
  assert.equal(imeEnter({ isComposing: false, keyCode: 13 }), false);
  assert.equal(imeEnter({ isComposing: true, keyCode: 13 }), true);
  // WebKit reports the commit as 229 after compositionend has already cleared
  // isComposing, so the legacy code has to be enough on its own.
  assert.equal(imeEnter({ isComposing: false, keyCode: 229 }), true);
});

/* ------------------------------------------------------- box sizing */

const LINE = 22.4;
const PAD = 14;

function fit(content: number, viewport = 844): { height: number; scrolls: boolean } {
  return fitComposer({ content, line: LINE, padding: PAD, viewport, maxRows: COMPOSER_MAX_ROWS });
}

test("an empty composer is exactly one line tall, never shorter", () => {
  // `scrollHeight` rounds 22.4px to 22: without the floor the box would be two
  // pixels short of its own line box and grow a scrollbar over nothing.
  assert.equal(fit(0).height, Math.ceil(LINE + PAD));
  assert.equal(fit(0).scrolls, false);
  assert.equal(fit(22).height, Math.ceil(LINE + PAD));
});

test("a floor of rows holds the box open while the draft is shorter", () => {
  // The draft card reserves two rows so the first line does not sit alone in a
  // box that grows the moment the writer wraps.
  const floor = Math.ceil(LINE * 2 + PAD);
  const two = fitComposer({ content: 0, line: LINE, padding: PAD, viewport: 844, maxRows: COMPOSER_MAX_ROWS, minRows: 2 });
  assert.deepEqual(two, { height: floor, scrolls: false });
  assert.deepEqual(
    fitComposer({ content: LINE + PAD, line: LINE, padding: PAD, viewport: 844, maxRows: COMPOSER_MAX_ROWS, minRows: 2 }),
    { height: floor, scrolls: false },
  );
  // Past the floor it behaves like any other box.
  assert.equal(
    fitComposer({ content: LINE * 3 + PAD, line: LINE, padding: PAD, viewport: 844, maxRows: COMPOSER_MAX_ROWS, minRows: 2 }).height,
    Math.ceil(LINE * 3 + PAD),
  );
});

test("the floor wins over a viewport too short to hold it, and loses to the row cap", () => {
  // A keyboard-open phone frame can leave less room than the floor: showing the
  // floor and scrolling is better than collapsing the draft to one line.
  const floor = Math.ceil(LINE * 2 + PAD);
  const squeezed = fitComposer({ content: 10_000, line: LINE, padding: PAD, viewport: 20, maxRows: COMPOSER_MAX_ROWS, minRows: 2 });
  assert.deepEqual(squeezed, { height: floor, scrolls: true });
  // A floor larger than the cap is clamped to the cap, never past it.
  const capped = fitComposer({ content: 0, line: LINE, padding: PAD, viewport: 844, maxRows: 3, minRows: 9 });
  assert.equal(capped.height, Math.ceil(LINE * 3 + PAD));
});

test("the composer grows with its lines and only scrolls past the cap", () => {
  assert.deepEqual(fit(36), { height: 37, scrolls: false });
  const three = Math.ceil(LINE * 3 + PAD);
  assert.deepEqual(fit(three), { height: three, scrolls: false });
  const cap = PAD + LINE * COMPOSER_MAX_ROWS;
  assert.deepEqual(fit(cap), { height: Math.ceil(cap), scrolls: false });
  assert.deepEqual(fit(cap + 1), { height: cap, scrolls: true });
});

test("a short viewport caps the box before the row limit does, at a whole line", () => {
  const viewport = 300;
  const byViewport = viewport * COMPOSER_VIEWPORT_SHARE;
  assert.ok(byViewport < LINE * COMPOSER_MAX_ROWS + PAD);
  const fitted = fitComposer({ content: 10_000, line: LINE, padding: PAD, viewport, maxRows: COMPOSER_MAX_ROWS });
  assert.equal(fitted.scrolls, true);
  assert.ok(fitted.height <= byViewport);
  assert.ok(Math.abs((fitted.height - PAD) % LINE) < 1e-6);
});

test("a box that scrolls is a whole number of lines tall, so no line is cut", () => {
  // The bug this guards: a box scrolled to its last line stops at
  // `content - height`. Unless that is a whole number of line boxes the draft
  // shows a half-glyph slice along the top edge instead of a clean cut.
  for (const content of [LINE * 9 + PAD, LINE * 20 + PAD, LINE * 120 + PAD]) {
    const fitted = fit(content);
    assert.equal(fitted.scrolls, true);
    assert.ok(Math.abs((fitted.height - PAD) % LINE) < 1e-6, `height ${fitted.height}`);
    // Setup: the scroll offset the browser will settle on is whole lines too.
    const offset = Math.max(0, content - fitted.height);
    assert.ok(Math.abs(offset % LINE) < 1e-6, `content ${content}`);
  }
});

test("a viewport smaller than one line still keeps the box one line tall", () => {
  const tiny = fitComposer({ content: 10_000, line: LINE, padding: PAD, viewport: 20, maxRows: COMPOSER_MAX_ROWS });
  assert.deepEqual(tiny, { height: Math.ceil(LINE + PAD), scrolls: true });
});

/* ------------------------------------------------------------ the keyboard */

test("a portrait phone gives the keyboard back in full", () => {
  // 390x844 iPhone with the software keyboard up: the visual viewport is
  // 424px tall and nothing else is covered, so the shell loses exactly 420px.
  assert.equal(keyboardInset(844, 424), 420);
});

test("a short landscape phone gives back the whole keyboard, not 60% of it", () => {
  // 844x390 held sideways with a 250px keyboard: a ratio cap stopped at 234px
  // and left the send row 8px underneath the keyboard. The floor is the
  // console, not a share of the window, so the lift is the full 250px.
  assert.equal(keyboardInset(390, 140), 250);
});

test("no keyboard, or a retracting one, leaves the shell alone", () => {
  assert.equal(keyboardInset(844, 844), 0);
  assert.equal(keyboardInset(844, 900), 0);
});

test("a viewport the browser over-reports stops at the console floor", () => {
  // A collapsed or pinch-zoomed viewport can claim the whole window; the
  // console keeps its composer plus strip and a little transcript, so the
  // lift is the window minus that floor rather than the whole window.
  assert.equal(keyboardInset(844, 0), 704);
  assert.equal(844 - keyboardInset(844, 0), KEYBOARD_STACK_MIN);
  assert.equal(keyboardInset(100, 0), 0);
});

test("nonsense measurements never move the shell", () => {
  assert.equal(keyboardInset(Number.NaN, 400), 0);
  assert.equal(keyboardInset(844, Number.POSITIVE_INFINITY), 0);
});

test("a send that landed says nothing", () => {
  assert.equal(sendTrouble("sent", "w2:p1"), null);
});

test("a paste that never arrived keeps the draft and offers the whole send again", () => {
  // The message did not leave the box, so the operator must not lose it; the
  // note says which pane it was for and the button repeats the send.
  assert.deepEqual(sendTrouble("unreached", "w2:p1"), {
    keepsDraft: true,
    note: "could not reach w2:p1, message kept",
    action: "retry",
  });
});

test("a paste whose Enter was lost is already in the pane, so only the key is offered", () => {
  // Measured against herdr 0.9.0: paste and Enter are two requests. Reporting
  // this as unsent and retrying the text would type the message twice.
  assert.deepEqual(sendTrouble("unsubmitted", "w6:p3"), {
    keepsDraft: false,
    note: "in w6:p3, Enter did not land",
    action: "enter",
  });
});

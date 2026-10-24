import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ACTIONS,
  applyCompletion,
  clearDraft,
  draftKey,
  mentionItems,
  mentionQuery,
  readDraft,
  scoreMatches,
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

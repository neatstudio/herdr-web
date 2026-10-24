import assert from "node:assert/strict";
import test from "node:test";

import { inlineSpans, parseList } from "./markdown.ts";

/* ----------------------------------------------------------------- inline */

test("an underscore inside an identifier is text, not italics", () => {
  const text = "The memory_test.go TestReleaseAndCancel: claimed := ...";
  const spans = inlineSpans(text);
  assert.ok(
    spans.every((span) => span.kind === "text"),
    `expected only text spans, got ${JSON.stringify(spans)}`,
  );
  assert.equal(spans.map((span) => span.text).join(""), text);
});

test("snake_case words keep their underscores", () => {
  const text = "call read_pane_now before the retry";
  const spans = inlineSpans(text);
  assert.ok(
    spans.every((span) => span.kind === "text"),
    `expected only text spans, got ${JSON.stringify(spans)}`,
  );
  assert.equal(spans.map((span) => span.text).join(""), text);
});

test("underscore emphasis still works at word boundaries", () => {
  assert.deepEqual(inlineSpans("this is _quiet_ text"), [
    { kind: "text", text: "this is " },
    { kind: "em", text: "quiet" },
    { kind: "text", text: " text" },
  ]);
  assert.deepEqual(inlineSpans("(_quiet_)"), [
    { kind: "text", text: "(" },
    { kind: "em", text: "quiet" },
    { kind: "text", text: ")" },
  ]);
});

test("double underscores stay bold, even inside a word", () => {
  assert.deepEqual(inlineSpans("keep __bold__ here"), [
    { kind: "text", text: "keep " },
    { kind: "strong", text: "bold" },
    { kind: "text", text: " here" },
  ]);
  assert.deepEqual(inlineSpans("snake__bold__case"), [
    { kind: "text", text: "snake" },
    { kind: "strong", text: "bold" },
    { kind: "text", text: "case" },
  ]);
});

test("code spans, links and stars are unaffected", () => {
  assert.deepEqual(inlineSpans("run `go test` now"), [
    { kind: "text", text: "run " },
    { kind: "code", text: "go test" },
    { kind: "text", text: " now" },
  ]);
  assert.deepEqual(inlineSpans("see [docs](https://x.test/a)"), [
    { kind: "text", text: "see " },
    { kind: "link", text: "docs", href: "https://x.test/a" },
  ]);
  assert.deepEqual(inlineSpans("an *aside* here"), [
    { kind: "text", text: "an " },
    { kind: "em", text: "aside" },
    { kind: "text", text: " here" },
  ]);
});

/* ------------------------------------------------------------------- list */

test("a wrapped list line joins its item, it never nests a list item", () => {
  const lines = ["- first line", "  wrapped tail", "- second"];
  assert.deepEqual(parseList(lines, 0), {
    ordered: false,
    items: [
      { depth: 0, text: "first line wrapped tail" },
      { depth: 0, text: "second" },
    ],
    end: 3,
  });
});

test("ordered lists, indentation depth and the end index are preserved", () => {
  const lines = ["1. alpha", "2. beta", "   wrapped", "   still same item", "", "after"];
  assert.deepEqual(parseList(lines, 0), {
    ordered: true,
    items: [
      { depth: 0, text: "alpha" },
      { depth: 0, text: "beta wrapped still same item" },
    ],
    end: 4,
  });
});

test("a nested list line is its own item with a depth", () => {
  const lines = ["- outer", "  - inner", "  - inner two"];
  assert.deepEqual(parseList(lines, 0), {
    ordered: false,
    items: [
      { depth: 0, text: "outer" },
      { depth: 1, text: "inner" },
      { depth: 1, text: "inner two" },
    ],
    end: 3,
  });
});

test("fences, quotes and blank lines end a list item", () => {
  const lines = ["- item", "```", "- not a list line", "```", "> quote"];
  assert.deepEqual(parseList(lines, 0), {
    ordered: false,
    items: [{ depth: 0, text: "item" }],
    end: 1,
  });
});

test("a non-list line is not parsed as a list", () => {
  assert.equal(parseList(["plain prose"], 0), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { markdownToPlain, turnCopyText } from "./answerText.ts";
import type { ChatTurn } from "./conversation.ts";

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "t1",
    user: null,
    thoughts: [],
    work: [],
    answer: "",
    recap: null,
    ...over,
  };
}

test("a turn the agent never answered still copies what was typed", () => {
  const pending = turn({ user: "run the suite, but only answerText", answer: "" });
  assert.equal(turnCopyText(pending, "markdown"), "run the suite, but only answerText");
  assert.equal(turnCopyText(pending, "text"), "run the suite, but only answerText");
});

test("markdown is the answer exactly as it arrived", () => {
  const answer = "## Fixed\n\nRan `npm test`: **299 pass**.\n\n```sh\nnpm test\n```";
  assert.equal(turnCopyText(turn({ answer }), "markdown"), answer);
});

test("plain text keeps the words and drops the syntax", () => {
  const answer = [
    "## Fixed",
    "",
    "Ran `npm test`: **299 pass**, see [the log](https://example.test/log).",
    "",
    "```sh",
    "npm test --watch=false",
    "```",
  ].join("\n");
  assert.equal(
    turnCopyText(turn({ answer }), "text"),
    [
      "Fixed",
      "",
      "Ran npm test: 299 pass, see the log (https://example.test/log).",
      "",
      "npm test --watch=false",
    ].join("\n"),
  );
});

test("a fenced block is copied byte for byte, even if it is markdown", () => {
  // The code is the payload: stripping emphasis inside it would hand the
  // operator a different program from the one the agent printed.
  const answer = ["```md", "# not a heading", "**not bold**", "```"].join("\n");
  assert.equal(markdownToPlain(answer), "# not a heading\n**not bold**");
});

test("the operator's own words lose nothing", () => {
  // They typed this; `**` was part of what they meant.
  const copy = turn({ user: "why is **this** here?", answer: "Because `x` was null." });
  assert.equal(turnCopyText(copy, "markdown"), "why is **this** here?\n\nBecause `x` was null.");
  assert.equal(turnCopyText(copy, "text"), "why is **this** here?\n\nBecause x was null.");
});

test("a quote loses its marker and keeps its sentence", () => {
  assert.equal(markdownToPlain("> recap: main is at 4afa186"), "recap: main is at 4afa186");
});

test("a link whose label is its target is not printed twice", () => {
  assert.equal(markdownToPlain("see https://example.test/a"), "see https://example.test/a");
  assert.equal(markdownToPlain("[https://example.test/a](https://example.test/a)"), "https://example.test/a");
});

test("a snake_case name is not emphasis, so plain text keeps its underscores", () => {
  assert.equal(markdownToPlain("call memory_test.go then"), "call memory_test.go then");
});

test("an empty turn copies nothing at all", () => {
  assert.equal(turnCopyText(turn(), "markdown"), "");
  assert.equal(turnCopyText(turn(), "text"), "");
});

test("the recap comes last, after the answer", () => {
  const copy = turn({ user: "ship it", answer: "Shipped.", recap: "recap: main is at 4afa186" });
  assert.equal(turnCopyText(copy, "text"), "ship it\n\nShipped.\n\nrecap: main is at 4afa186");
});

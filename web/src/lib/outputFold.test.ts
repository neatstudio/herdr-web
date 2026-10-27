import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLD_AT_SHORT_FENCES,
  SHORT_FENCE_LINES,
  fenceSource,
  planOutput,
  type FencePiece,
} from "./outputFold.ts";

/*
 * The fixtures are the shape a Claude Code pane hands over, not a live read:
 * the TUI writes the language on the *closing* fence line, leaves a blank row
 * inside short blocks, and puts one line of prose between them. Text is written
 * here so a pane on this machine cannot move a test.
 */

const said = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `point ${index + 1}`);

/** `blocks` short fences, each holding one line, separated by one prose row. */
function shortRun(blocks: number): string {
  const lines: string[] = ["Here is what I found."];
  for (let index = 0; index < blocks; index += 1) {
    lines.push("", "```", `value ${index + 1}`, "```text");
  }
  lines.push("");
  return lines.join("\n");
}

const fences = (text: string): FencePiece[] =>
  planOutput(text).pieces.filter((piece): piece is FencePiece => piece.kind === "fence");

test("text without fences is one prose piece", () => {
  const text = "只是几行话。\n\n第二段。\n";
  const plan = planOutput(text);
  assert.equal(plan.pieces.length, 1);
  assert.equal(plan.pieces[0].kind, "prose");
  assert.equal(plan.pieces[0].text, text);
  assert.equal(plan.shortFences, 0);
  assert.equal(plan.foldable, false);
});

test("a fence keeps its exact source, its language and its first line", () => {
  const text = "Run it:\n\n```ts\nnpm test\n```\n";
  const [fence] = fences(text);
  assert.equal(fence.text, "```ts\nnpm test\n```\n");
  assert.equal(fence.language, "ts");
  assert.equal(fence.body, "npm test");
  assert.equal(fence.lines, 1);
  assert.equal(fence.peek, "npm test");
  assert.equal(fence.short, true);
});

test("the language is read off the closing fence when the opening one is bare", () => {
  // What the measured Claude Code pane actually prints.
  const text = "```\nthis console\n```text\n";
  const [fence] = fences(text);
  assert.equal(fence.language, "text");
  assert.equal(fence.body, "this console");
});

test("pieces concatenate back to the source, fenced or not", () => {
  const text = shortRun(3) + "and then:\n\n```\nlast\n```\n";
  const plan = planOutput(text);
  assert.equal(
    plan.pieces.map((piece) => piece.text).join(""),
    text,
  );
});

test("two short blocks are not a list of panels", () => {
  const plan = planOutput(shortRun(FOLD_AT_SHORT_FENCES - 1));
  assert.equal(plan.shortFences, FOLD_AT_SHORT_FENCES - 1);
  assert.equal(plan.foldable, false);
  assert.equal(fences(shortRun(FOLD_AT_SHORT_FENCES - 1)).length, FOLD_AT_SHORT_FENCES - 1);
});

test("three short blocks in one answer fold", () => {
  const plan = planOutput(shortRun(FOLD_AT_SHORT_FENCES));
  assert.equal(plan.shortFences, FOLD_AT_SHORT_FENCES);
  assert.equal(plan.foldable, true);
});

test("a long block is not short, and does not count toward the fold", () => {
  const body = said(SHORT_FENCE_LINES + 1).join("\n");
  const text = `Talk.\n\n\`\`\`\n${body}\n\`\`\`\n`;
  const plan = planOutput(text);
  assert.equal(plan.shortFences, 0);
  assert.equal(plan.foldable, false);
  const [fence] = fences(text);
  assert.equal(fence.short, false);
  assert.equal(fence.lines, SHORT_FENCE_LINES + 1);
});

test("a long block stays whole inside a folding answer", () => {
  const body = said(SHORT_FENCE_LINES + 1).join("\n");
  const text = `${shortRun(FOLD_AT_SHORT_FENCES)}\`\`\`go\n${body}\n\`\`\`\n`;
  const plan = planOutput(text);
  assert.equal(plan.foldable, true);
  assert.equal(plan.shortFences, FOLD_AT_SHORT_FENCES);
  const all = fences(text);
  assert.equal(all.length, FOLD_AT_SHORT_FENCES + 1);
  assert.equal(all.at(-1)?.short, false);
});

test("blank rows inside a fence are not content lines", () => {
  const text = "```\n\nvalue\n\n```\n";
  const [fence] = fences(text);
  assert.equal(fence.lines, 1);
  assert.equal(fence.peek, "value");
});

test("an empty fence is silence, not a panel", () => {
  const text = "before\n\n```\n\n```\n\nafter\n";
  const plan = planOutput(text);
  assert.equal(plan.pieces.filter((piece) => piece.kind === "silence").length, 1);
  assert.equal(plan.shortFences, 0);
  assert.equal(plan.foldable, false);
  assert.equal(
    plan.pieces.map((piece) => piece.text).join(""),
    text,
  );
});

test("an unterminated fence stays prose", () => {
  const text = "look:\n\n```ts\nnpm test\n";
  const plan = planOutput(text);
  assert.equal(fences(text).length, 0);
  assert.equal(plan.pieces.length, 1);
  assert.equal(plan.pieces[0].kind, "prose");
  assert.equal(plan.pieces[0].text, text);
});

test("the preview is one row and is cut short", () => {
  const long = "x".repeat(200);
  const [fence] = fences(`\`\`\`\n${long}\n\`\`\`\n`);
  assert.ok(fence.peek.length < long.length);
  assert.ok(fence.peek.endsWith("…"));
});

test("prose keeps its place between the blocks", () => {
  const plan = planOutput("```\none\n```\nbetween\n```\ntwo\n```\n");
  // The trailing newline keeps its own (empty) prose piece, so the sources of
  // all the pieces still add up to the input.
  assert.deepEqual(
    plan.pieces.map((piece) => piece.kind),
    ["fence", "prose", "fence", "prose"],
  );
  const prose = plan.pieces[1];
  assert.equal(prose.kind === "prose" ? prose.text : "", "between\n");
});

test("the replay fence carries the language the TUI wrote on the close", () => {
  const [fence] = fences("```\nthis console\n```text\n");
  assert.ok(fence);
  assert.equal(fence.language, "text");
  // Re-fenced canonically: the language moves to the opening line, so
  // `Markdown` closes the block instead of printing the marker as content.
  assert.equal(fenceSource(fence), "```text\nthis console\n```\n");
});

test("a block already written the canonical way replays unchanged", () => {
  const text = "```bash\ncurl -s example.test\n```\n";
  const [fence] = fences(text);
  assert.ok(fence);
  assert.equal(fenceSource(fence), text);
});

test("the replay keeps the body byte for byte, blank rows and all", () => {
  const [fence] = fences("```\nfirst\n\nthird\n```\n");
  assert.ok(fence);
  assert.equal(fenceSource(fence), "```\nfirst\n\nthird\n```\n");
});

test("a body without its trailing newline still replays as a block", () => {
  // `planOutput` only ever hands over whole lines (an empty fence becomes a
  // `silence` piece instead), but the type does not say so, and a missing
  // newline would fuse the body into the closing marker.
  const piece: FencePiece = {
    kind: "fence",
    text: "```ts\nnpm test\n```\n",
    language: "ts",
    body: "npm test",
    lines: 1,
    short: true,
    peek: "npm test",
  };
  assert.equal(fenceSource(piece), "```ts\nnpm test\n```\n");
});

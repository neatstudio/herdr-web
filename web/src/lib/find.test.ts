import assert from "node:assert/strict";
import test from "node:test";

import { FIND_MISS, findInk, findLabel } from "./find.ts";

test("findLabel reads as a position out of a total", () => {
  assert.equal(findLabel({ index: 0, count: 1 }), "1/1");
  assert.equal(findLabel({ index: 2, count: 17 }), "3/17");
  assert.equal(findLabel({ index: 16, count: 17 }), "17/17");
});

test("findLabel never shows a negative or out-of-range position", () => {
  // xterm reports -1 while a hit exists but none is active.
  assert.equal(findLabel({ index: -1, count: 4 }), "1/4");
  assert.equal(findLabel({ index: 9, count: 4 }), "4/4");
  // Nothing matched, or the bar is empty.
  assert.equal(findLabel(FIND_MISS), "0/0");
  assert.equal(findLabel({ index: -1, count: 0 }), "0/0");
  // Defensive: NaN/Infinity can only come from a broken result event.
  assert.equal(findLabel({ index: Number.NaN, count: Number.POSITIVE_INFINITY }), "0/0");
});

test("findInk gives xterm 6-digit hex, because decorations reject anything else", () => {
  const hex = /^#[0-9a-f]{6}$/;
  for (const theme of ["dark", "light"] as const) {
    const ink = findInk(theme);
    assert.match(ink.match, hex);
    assert.match(ink.active, hex);
    assert.match(ink.accent, hex);
    // The active match has to be distinguishable from the rest.
    assert.notEqual(ink.active, ink.match);
  }
});

test("findInk follows the console's accent per theme", () => {
  assert.equal(findInk("dark").accent, "#ff7a45");
  assert.equal(findInk("light").accent, "#a83d14");
});

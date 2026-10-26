import assert from "node:assert/strict";
import test from "node:test";

import { COMPACT_WIDTH, TOUCH_HEIGHT, TOUCH_WIDTH, compactFrame } from "./frame.ts";

test("a phone upright is compact whatever the pointer says", () => {
  // 320x568 is the smallest phone herdr-web runs on; 430x932 is an iPhone Pro
  // Max upright. Both are under the window width, and a mouse-driven window
  // squeezed that narrow wants the stacked layout for the same reason.
  assert.equal(compactFrame(320, 568, true), true);
  assert.equal(compactFrame(430, 932, true), true);
  assert.equal(compactFrame(COMPACT_WIDTH, 900, false), true);
});

test("a desktop window keeps the stage", () => {
  assert.equal(compactFrame(721, 900, false), false);
  assert.equal(compactFrame(1024, 768, false), false);
  assert.equal(compactFrame(1440, 900, false), false);
  // Coarse but roomy: an iPad held sideways is a tablet, and the stage fits.
  assert.equal(compactFrame(768, 1024, true), true);
  assert.equal(compactFrame(1024, 768, true), false);
  assert.equal(compactFrame(1180, 820, true), false);
});

test("a phone held sideways is compact even when it is wider than the touch width", () => {
  // These are the frames the width-only rule missed: 932x430 is an iPhone 14
  // Pro Max, 915x412 a Galaxy S23 Ultra. 844x390 already folded and must keep
  // folding.
  assert.equal(compactFrame(844, 390, true), true);
  assert.equal(compactFrame(915, 412, true), true);
  assert.equal(compactFrame(932, 430, true), true);
  // The height arm is what catches them, so it must not be width-blind: the
  // same short frame driven by a mouse (a small laptop window, a resize test)
  // keeps the stage.
  assert.equal(compactFrame(932, 430, false), false);
});

test("the two touch clamps meet where the constants say", () => {
  assert.equal(compactFrame(TOUCH_WIDTH, 700, true), true);
  assert.equal(compactFrame(TOUCH_WIDTH + 1, 700, true), false);
  assert.equal(compactFrame(TOUCH_WIDTH + 1, TOUCH_HEIGHT, true), true);
  assert.equal(compactFrame(TOUCH_WIDTH + 1, TOUCH_HEIGHT + 1, true), false);
});

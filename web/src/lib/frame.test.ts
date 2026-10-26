import assert from "node:assert/strict";
import test from "node:test";

import { COMPACT_WIDTH, TOUCH_SIDE, compactFrame } from "./frame.ts";

test("a phone upright is compact whatever the pointer says", () => {
  // 320x568 is the smallest phone herdr-web runs on; 430x932 is an iPhone Pro
  // Max upright. Both are under the window width, and a mouse-driven window
  // squeezed that narrow wants the stacked layout for the same reason.
  assert.equal(compactFrame(320, 568, true), true);
  assert.equal(compactFrame(390, 844, true), true);
  assert.equal(compactFrame(430, 932, true), true);
  assert.equal(compactFrame(COMPACT_WIDTH, 900, false), true);
});

test("a desktop window keeps the stage", () => {
  assert.equal(compactFrame(721, 900, false), false);
  assert.equal(compactFrame(1024, 768, false), false);
  assert.equal(compactFrame(1440, 900, false), false);
  // A mouse-driven window is never called a phone for being short: 932x430 is
  // the phone that must fold, but a resized laptop window of that shape is
  // still a stage.
  assert.equal(compactFrame(932, 430, false), false);
});

test("a tablet keeps the stage in either posture", () => {
  // iPad mini 744x1133, iPad 10.9 820x1180, iPad Air 1180x820, iPad Pro
  // 1024x1366: all coarse, all roomier than any phone, all the desktop stage.
  // The portrait ones are the ones the width-only rule used to fold, which
  // made rotating the tablet rebuild the whole console.
  assert.equal(compactFrame(744, 1133, true), false);
  assert.equal(compactFrame(820, 1180, true), false);
  assert.equal(compactFrame(1180, 820, true), false);
  assert.equal(compactFrame(768, 1024, true), false);
  assert.equal(compactFrame(1024, 1366, true), false);
  assert.equal(compactFrame(1366, 1024, true), false);
});

test("rotation cannot change the frame of one device", () => {
  const postures: [number, number][] = [
    [390, 844],
    [430, 932],
    [932, 430],
    [820, 1180],
    [744, 1133],
    [1024, 1366],
  ];
  for (const [width, height] of postures) {
    assert.equal(
      compactFrame(width, height, true),
      compactFrame(height, width, true),
      `${width}x${height}`,
    );
  }
});

test("a phone held sideways is compact even when it is wider than the compact width", () => {
  // These are the frames a width-only rule misses: 932x430 is an iPhone 14 Pro
  // Max, 915x412 a Galaxy S23 Ultra. 844x390 already folded and must keep
  // folding.
  assert.equal(compactFrame(844, 390, true), true);
  assert.equal(compactFrame(915, 412, true), true);
  assert.equal(compactFrame(932, 430, true), true);
  // A phone is short on one side, not both: the same frame with the sides
  // sorted does not become a tablet.
  assert.equal(compactFrame(430, 932, true), true);
});

test("the short-side clamp meets where the constant says", () => {
  // Width has to stay above the compact clamp or the first arm decides.
  const wide = COMPACT_WIDTH + 200;
  assert.equal(compactFrame(wide, TOUCH_SIDE, true), true);
  assert.equal(compactFrame(wide, TOUCH_SIDE + 1, true), false);
  // Just over the clamp is a tablet whichever side it is on, as long as the
  // width is past the compact clamp too.
  assert.equal(compactFrame(wide + 100, TOUCH_SIDE + 1, true), false);
  assert.equal(compactFrame(TOUCH_SIDE + 300, TOUCH_SIDE + 1, true), false);
});

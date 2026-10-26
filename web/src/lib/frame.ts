/*
 * Which frames get the phone layout. This lives apart from App so the rule can
 * be read, changed and tested in one place: the phone layout is not a taste, it
 * is the answer to "can the desktop stage fit here".
 *
 * The desktop stage gives every pane of a tab its own terminal tile, keeps the
 * workspaces and agents rails, and draws an AUTO/WRAP/EXACT/FIT bar over the
 * pane. That is right for a window and wrong for a thumb — but "wrong" arrives
 * at a different size depending on which way the phone is held:
 *
 * - Upright, a phone is 320-430 wide, and 720 is already generous: no current
 *   phone comes near it, and a squeezed desktop window below it wants the
 *   stacked layout too.
 * - Sideways, an iPhone 14 Pro Max is 932x430 and a Galaxy S23 Ultra is 915x412.
 *   Both are wider than the 900px the touch rule used to stop at, so they were
 *   handed the desktop stage: 178px tiles, a 150px terminal, the rails and the
 *   render bar inside 430px of height. The rule that actually identifies them
 *   is height, not width — a phone held sideways is shorter than any window
 *   anyone types into. Touching that is what the second clamp is for.
 *
 * 500px sits between those phones (375-440 tall sideways) and a tablet held
 * sideways (768 tall on an iPad mini, 834 on an Air), which keeps the desktop
 * stage on the tablet.
 */

/** Narrower than this, any pointer: a window squeezed to phone width. */
export const COMPACT_WIDTH = 720;

/** Narrower than this, and touching: the touch stylesheet folds here. */
export const TOUCH_WIDTH = 900;

/** Shorter than this, and touching: a phone on its side, never a tablet. */
export const TOUCH_HEIGHT = 500;

/**
 * Whether this frame gets the phone layout: the lens instead of the tab stage,
 * the folded rails, and the finger-sized composer.
 *
 * `coarse` is the "(pointer: coarse)" signal. Width and height are CSS pixels,
 * so they have to come from the viewport rather than from a device's spec
 * sheet, which is why App feeds it `innerWidth`/`innerHeight` and re-runs it on
 * resize.
 */
export function compactFrame(width: number, height: number, coarse: boolean): boolean {
  if (width <= COMPACT_WIDTH) {
    return true;
  }
  return coarse && (width <= TOUCH_WIDTH || height <= TOUCH_HEIGHT);
}

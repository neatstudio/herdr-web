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
 *   stacked layout too. This clamp is about width, because a window squeezed
 *   narrow is the same problem whatever is pointing at it.
 * - Sideways, an iPhone 14 Pro Max is 932x430 and a Galaxy S23 Ultra is 915x412.
 *   Both are wider than the 900px a width-only touch rule stops at, so they were
 *   handed the desktop stage: 178px tiles, a 150px terminal, the rails and the
 *   render bar inside 430px of height.
 *
 * The measurement that separates a phone from a tablet is the *short* side, not
 * the width. Every phone herdr-web runs on is 480px or less across its narrow
 * axis whichever way it is turned; the smallest tablet anyone brings is an iPad
 * mini at 744. Measuring height alone caught a landscape phone but missed the
 * portrait side of the same phone-shaped decision, and width alone put half the
 * tablets on the phone layout: an 820x1180 iPad in portrait is under the 900px
 * touch width, so it got the lens and the finger composer, and turning it
 * sideways — same device, same hand — rebuilt the console as the desktop stage.
 * A layout that flips when the tablet is rotated is a bug in the rule, not a
 * feature of the postures. The short side says "phone" once per device.
 *
 * 500px sits between the phones (320-480 on the short side) and the tablets
 * (744 and up), so the clamp is read on whichever side is narrower.
 */

/** Narrower than this, any pointer: a window squeezed to phone width. */
export const COMPACT_WIDTH = 720;

/** The longest a phone's short side gets; tablets start at 744. */
export const TOUCH_SIDE = 500;

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
  return coarse && Math.min(width, height) <= TOUCH_SIDE;
}

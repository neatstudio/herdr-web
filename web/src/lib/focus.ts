/*
 * One place that owns the prompt's focus, so the rules are testable without a
 * browser: switching pane puts the caret in the prompt, and a bare Tab or
 * Enter anywhere on the page gets it back there.
 */

/** The prompt, by the id the shell and the tests both use. */
export const PROMPT_ID = "herdr-input";

/** Elements that already mean something when Tab or Enter reaches them. */
const INTERACTIVE = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);

/** Whether Tab or Enter should be taken over for the prompt. */
export function shouldClaimKey(
  key: string,
  active: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (key !== "Tab" && key !== "Enter") {
    return false;
  }
  if (active === null) {
    return true;
  }
  if (active.isContentEditable === true) {
    return false;
  }
  const tag = (active.tagName ?? "").toUpperCase();
  // The page itself, or a plain element such as the transcript, hands the key
  // to the prompt; anything interactive keeps its own keys, so tabbing to a
  // button and pressing Enter still presses that button.
  return !INTERACTIVE.has(tag);
}

/**
 * A caret in the prompt is only wanted where a keyboard is the main input.
 * On a phone it would raise the on-screen keyboard over the transcript every
 * time a pane is opened.
 */
export function keyboardIsPrimary(
  match: (query: string) => boolean = (query) =>
    typeof window !== "undefined" && window.matchMedia(query).matches,
): boolean {
  return match("(hover: hover) and (pointer: fine)");
}

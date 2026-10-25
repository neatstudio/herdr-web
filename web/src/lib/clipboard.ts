/**
 * Clipboard writes for the two buttons that copy agent text.
 *
 * `navigator.clipboard` only exists in a secure context, and the console is
 * normally opened over plain HTTP on a tailnet address, so a missing API is the
 * common case rather than the edge case: fall back to a hidden textarea and the
 * legacy copy command. Returns whether the text made it onto the clipboard.
 */

/** How long a copy button says "copied" before it goes back to being a button. */
export const COPY_ACK_MS = 1500;

export async function copyText(text: string): Promise<boolean> {
  if (text === "") {
    return false;
  }
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no clipboard API here, or the browser refused */
  }
  return legacyCopy(text);
}

/** The pre-async copy path: works on http, and inside a click the browser still trusts. */
function legacyCopy(text: string): boolean {
  const active = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.opacity = "0";
  document.body.appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    copied = document.execCommand("copy");
  } catch {
    /* the legacy command can be refused too */
  } finally {
    field.remove();
    // Take focus back: the reader was probably typing when they clicked copy.
    if (active instanceof HTMLElement) {
      active.focus({ preventScroll: true });
    }
  }
  return copied;
}

/*
 * Theme controller: one stored preference (auto | light | dark) applied to
 * <html data-theme>. index.html applies the same rule before first paint, so
 * this module only has to keep it in sync afterwards.
 */

export type ThemeChoice = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "herdr-web-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "auto" || value === "light" || value === "dark";
}

/** Resolve a choice against the OS preference. Pure: tests pass `prefersLight`. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === "auto") {
    return prefersLight ? "light" : "dark";
  }
  return choice;
}

export function readStoredChoice(storage: Pick<Storage, "getItem"> | null): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_KEY);
    return isThemeChoice(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function storeChoice(storage: Pick<Storage, "setItem"> | null, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_KEY, choice);
  } catch {
    /* private mode: the choice just will not persist */
  }
}

export const THEME_CHOICES: ThemeChoice[] = ["auto", "light", "dark"];

export function applyTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  const resolved = resolveTheme(choice, prefersLight);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

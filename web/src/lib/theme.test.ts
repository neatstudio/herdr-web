import assert from "node:assert/strict";
import test from "node:test";

import * as theme from "./theme.ts";

test("resolveTheme follows the OS only in auto", () => {
  assert.equal(theme.resolveTheme("auto", true), "light");
  assert.equal(theme.resolveTheme("auto", false), "dark");
  assert.equal(theme.resolveTheme("light", false), "light");
  assert.equal(theme.resolveTheme("dark", true), "dark");
});

test("readStoredChoice falls back to auto for junk and missing values", () => {
  const store = (value: string | null) => ({ getItem: () => value });
  assert.equal(theme.readStoredChoice(store("light")), "light");
  assert.equal(theme.readStoredChoice(store("dark")), "dark");
  assert.equal(theme.readStoredChoice(store("auto")), "auto");
  assert.equal(theme.readStoredChoice(store("purple")), "auto");
  assert.equal(theme.readStoredChoice(store(null)), "auto");
  assert.equal(theme.readStoredChoice(null), "auto");
});

test("storage failures never break startup", () => {
  const throwing = {
    getItem: () => {
      throw new Error("private mode");
    },
    setItem: () => {
      throw new Error("private mode");
    },
  };
  assert.equal(theme.readStoredChoice(throwing), "auto");
  // Must not throw.
  theme.storeChoice(throwing, "light");
  theme.storeChoice(null, "dark");
});

test("storeChoice writes the value the reader expects", () => {
  let written: [string, string] | null = null;
  theme.storeChoice(
    {
      setItem: (key, value) => {
        written = [key, value];
      },
    },
    "light",
  );
  assert.deepEqual(written, [theme.THEME_KEY, "light"]);
});

test("isThemeChoice rejects everything but the three states", () => {
  assert.equal(theme.isThemeChoice("auto"), true);
  assert.equal(theme.isThemeChoice("light"), true);
  assert.equal(theme.isThemeChoice("dark"), true);
  assert.equal(theme.isThemeChoice("system"), false);
  assert.equal(theme.isThemeChoice(undefined), false);
});

test("nextTheme cycles auto, light, dark and wraps", () => {
  assert.equal(theme.nextTheme("auto"), "light");
  assert.equal(theme.nextTheme("light"), "dark");
  assert.equal(theme.nextTheme("dark"), "auto");
});

test("display mode defaults to auto and survives junk", () => {
  const store = (value: string | null) => ({ getItem: () => value });
  assert.equal(theme.readStoredDisplay(store("exact")), "exact");
  assert.equal(theme.readStoredDisplay(store("fit")), "fit");
  assert.equal(theme.readStoredDisplay(store("auto")), "auto");
  assert.equal(theme.readStoredDisplay(store("wrap")), "wrap");
  assert.equal(theme.readStoredDisplay(store("sideways")), "auto");
  assert.equal(theme.readStoredDisplay(null), "auto");
});

test("display preference writes the key the reader expects", () => {
  let written: [string, string] | null = null;
  theme.storeDisplay(
    {
      setItem: (key, value) => {
        written = [key, value];
      },
    },
    "exact",
  );
  assert.deepEqual(written, [theme.DISPLAY_KEY, "exact"]);
});

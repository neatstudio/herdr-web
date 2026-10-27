import assert from "node:assert/strict";
import { test } from "node:test";

import {
  READING_DEFAULT,
  READING_KEY,
  applyReading,
  formatReading,
  isDefaultReading,
  isReadMeasure,
  isReadSize,
  normaliseReading,
  parseReading,
  readStoredReading,
  readingVars,
  storeReading,
  type Reading,
} from "./reading.ts";

/** The same shape `theme.test.ts` gives the storage helpers: no DOM needed. */
function store(initial: Record<string, string> = {}) {
  const cells = new Map(Object.entries(initial));
  return {
    cells,
    getItem(key: string): string | null {
      return cells.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      cells.set(key, value);
    },
  };
}

test("the default choice writes no css variables at all", () => {
  // This is the invariant that protects every pinned phone measurement: an
  // operator who never opens the settings must compute exactly what they did
  // before the settings existed.
  assert.deepEqual(readingVars(READING_DEFAULT), {});
  assert.equal(isDefaultReading(READING_DEFAULT), true);
  assert.equal(isDefaultReading({ size: "small", measure: "default" }), false);
});

test("each non-default size moves the text tokens and nothing else", () => {
  const small = readingVars({ size: "small", measure: "default" });
  assert.equal(small["--ui-body"], "12.5px");
  assert.equal(small["--ui-code"], "10.5px");
  // Rows, targets and head heights are thumb geometry, not reading geometry.
  assert.equal("--ui-row" in small, false);

  const large = readingVars({ size: "large", measure: "default" });
  assert.equal(large["--ui-body"], "16.5px");
  // A size change never touches the measure, and vice versa.
  assert.equal("--ui-lane" in large, false);
});

test("measure only moves the lane, and keeps the phone's side inset in px", () => {
  const narrow = readingVars({ size: "default", measure: "narrow" });
  assert.deepEqual(Object.keys(narrow), ["--ui-lane"]);
  // 40px of side inset on a phone lane: 350px of text instead of 366.
  assert.match(narrow["--ui-lane"], /100% - 40px/);
  assert.match(readingVars({ size: "default", measure: "wide" })["--ui-lane"], /1080px/);
});

test("both knobs combine", () => {
  const both = readingVars({ size: "small", measure: "wide" });
  assert.equal(both["--ui-body"], "12.5px");
  assert.match(both["--ui-lane"], /1080px/);
});

test("the choice round-trips through one storage cell", () => {
  const storage = store();
  const choice: Reading = { size: "large", measure: "narrow" };
  storeReading(storage, choice);
  assert.equal(storage.cells.get(READING_KEY), "large/narrow");
  assert.deepEqual(readStoredReading(storage), choice);
  assert.equal(formatReading(choice), "large/narrow");
});

test("an empty or unreadable cell falls back to the default, not to an error", () => {
  assert.deepEqual(readStoredReading(store()), READING_DEFAULT);
  assert.deepEqual(readStoredReading(null), READING_DEFAULT);
  assert.deepEqual(readStoredReading(store({ [READING_KEY]: "huge/weird" })), READING_DEFAULT);
  // A partial record keeps the half that is valid.
  assert.deepEqual(parseReading("small"), { size: "small", measure: "default" });
  assert.deepEqual(parseReading("/wide"), { size: "default", measure: "wide" });
  assert.deepEqual(parseReading("small/narrow/extra"), { size: "small", measure: "narrow" });
  assert.deepEqual(parseReading(undefined), READING_DEFAULT);
});

test("storage failures never escape: the console keeps working", () => {
  const broken = {
    getItem(): string | null {
      throw new Error("SecurityError");
    },
    setItem(): void {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual(readStoredReading(broken), READING_DEFAULT);
  assert.doesNotThrow(() => storeReading(broken, { size: "large", measure: "wide" }));
});

test("guards reject anything that is not one of the offered values", () => {
  assert.equal(isReadSize("small"), true);
  assert.equal(isReadSize("huge"), false);
  assert.equal(isReadSize(undefined), false);
  assert.equal(isReadMeasure("wide"), true);
  assert.equal(isReadMeasure("narrow"), true);
  assert.equal(isReadMeasure("tall"), false);
  assert.deepEqual(normaliseReading({ size: "small", measure: "tall" }), {
    size: "small",
    measure: "default",
  });
  assert.deepEqual(normaliseReading(null), READING_DEFAULT);
});

test("applyReading writes properties, clears them on default, and tags the root", () => {
  const props = new Map<string, string>();
  const root = {
    style: {
      setProperty(name: string, value: string): void {
        props.set(name, value);
      },
      removeProperty(name: string): string {
        const had = props.get(name) ?? "";
        props.delete(name);
        return had;
      },
    },
    dataset: {} as DOMStringMap,
  };

  applyReading({ size: "small", measure: "narrow" }, root as unknown as HTMLElement);
  assert.equal(props.get("--ui-body"), "12.5px");
  assert.match(props.get("--ui-lane") ?? "", /640px/);
  assert.equal(root.dataset.readSize, "small");
  assert.equal(root.dataset.readMeasure, "narrow");

  // Going back to default must leave no inline properties behind: a stale
  // inline `--ui-body` would outrank the stylesheet forever.
  applyReading(READING_DEFAULT, root as unknown as HTMLElement);
  assert.deepEqual([...props.keys()], []);
  assert.equal(root.dataset.readSize, "default");
  assert.equal(root.dataset.readMeasure, "default");
});

test("applyReading tolerates a missing document", () => {
  assert.doesNotThrow(() => applyReading({ size: "large", measure: "wide" }, null));
});

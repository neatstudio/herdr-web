import assert from "node:assert/strict";
import test from "node:test";

import { lensKey, defaultLens, readStoredLens, storeLens, type Lens } from "./lens.ts";

/** A Map-backed stand-in for localStorage, with an optional quota failure. */
function memory(failOnWrite = false): Pick<Storage, "getItem" | "setItem"> {
  const cells = new Map<string, string>();
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => {
      if (failOnWrite) {
        throw new Error("QuotaExceededError");
      }
      cells.set(key, value);
    },
  };
}

test("a pane with an agent opens as a transcript", () => {
  assert.equal(defaultLens(true), "chat");
});

test("a pane with no agent opens as a terminal", () => {
  assert.equal(defaultLens(false), "terminal");
});

test("the stored key is namespaced per pane", () => {
  assert.equal(lensKey("w6:p3"), "herdr:lens:w6:p3");
  assert.notEqual(lensKey("w6:p3"), lensKey("w6:p7"));
});

test("a stored choice is read back only for the pane that stored it", () => {
  const storage = memory();
  storeLens(storage, "w6:p3", "terminal");
  assert.equal(readStoredLens(storage, "w6:p3"), "terminal");
  assert.equal(readStoredLens(storage, "w6:p7"), null);
});

test("a console with no storage still switches lenses", () => {
  assert.equal(readStoredLens(null, "w6:p3"), null);
  assert.doesNotThrow(() => storeLens(null, "w6:p3", "chat"));
});

test("a value that is not a lens is ignored", () => {
  const storage = memory();
  storage.setItem(lensKey("w6:p3"), "wide");
  assert.equal(readStoredLens(storage, "w6:p3"), null);
});

test("a full quota drops the preference instead of failing the click", () => {
  const storage = memory(true);
  assert.doesNotThrow(() => storeLens(storage, "w6:p3", "terminal"));
});

test("a hostile storage cannot break the stage", () => {
  const hostile: Pick<Storage, "getItem"> = {
    getItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readStoredLens(hostile, "w6:p3"), null);
});

test("both lenses round-trip", () => {
  const storage = memory();
  const lenses: Lens[] = ["chat", "terminal"];
  for (const lens of lenses) {
    storeLens(storage, "w6:p3", lens);
    assert.equal(readStoredLens(storage, "w6:p3"), lens);
  }
});

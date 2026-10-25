import assert from "node:assert/strict";
import test from "node:test";

import { readStoredPane, resolveStoredPane, storePane } from "./selection.ts";

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

test("a fresh console has no stored pane", () => {
  assert.equal(readStoredPane(memory()), null);
});

test("the pane being read is read back after a reload", () => {
  const storage = memory();
  storePane(storage, "w6:p3");
  assert.equal(readStoredPane(storage), "w6:p3");
});

test("the last click wins", () => {
  const storage = memory();
  storePane(storage, "w6:p3");
  storePane(storage, "w6:p7");
  assert.equal(readStoredPane(storage), "w6:p7");
});

test("a console with no storage still opens a pane", () => {
  assert.equal(readStoredPane(null), null);
  storePane(null, "w6:p3"); // must not throw
  assert.equal(readStoredPane(null), null);
});

test("a blocked write keeps the console usable", () => {
  const storage = memory(true);
  storePane(storage, "w6:p3"); // must not throw
  assert.equal(readStoredPane(storage), null);
});

test("an empty stored value is no selection", () => {
  const storage = memory();
  storePane(storage, "");
  assert.equal(readStoredPane(storage), null);
});

test("a stored pane is restored only while herdr still reports it", () => {
  assert.equal(resolveStoredPane("w6:p3", ["w6:p3", "w6:p7"]), "w6:p3");
  assert.equal(resolveStoredPane("w6:p3", ["w6:p7"]), null);
  assert.equal(resolveStoredPane(null, ["w6:p3"]), null);
  assert.equal(resolveStoredPane("w6:p3", []), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BAR_KEYS,
  KEY_BAR_KEYS,
  KEY_MENU_COLUMNS,
  KEY_MENU_KEYS,
  PICKER_BAR_KEYS,
  KEY_REPEAT_DELAY,
  KEY_REPEAT_INTERVAL,
  clearLatches,
  createKeyRepeat,
  emptyLatches,
  isArmed,
  keyNameFor,
  latchesAfterPress,
  strokeFor,
  toggleLatch,
  type KeyBarKey,
  type KeyTimers,
} from "./keybar.ts";

function byId(id: string): KeyBarKey {
  const key = KEY_BAR_KEYS.find((candidate) => candidate.id === id);
  assert.ok(key !== undefined, `no key ${id}`);
  return key;
}

function fromMenu(id: string): KeyBarKey {
  const key = KEY_MENU_KEYS.find((candidate) => candidate.id === id);
  assert.ok(key !== undefined, `no key ${id} in the menu`);
  return key;
}

/** A virtual clock: timers fire in order, and `advance` never sleeps. */
function fakeTimers(): { timers: KeyTimers; advance: (ms: number) => void } {
  let now = 0;
  let sequence = 0;
  const queue = new Map<number, { at: number; run: () => void }>();

  const timers: KeyTimers = {
    setTimeout: (callback, ms) => {
      sequence += 1;
      queue.set(sequence, { at: now + ms, run: callback });
      return sequence;
    },
    clearTimeout: (handle) => {
      queue.delete(handle as number);
    },
  };

  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      let best: { id: number; at: number; run: () => void } | null = null;
      for (const [id, entry] of queue) {
        if (entry.at > until) {
          continue;
        }
        if (best === null || entry.at < best.at || (entry.at === best.at && id < best.id)) {
          best = { id, at: entry.at, run: entry.run };
        }
      }
      if (best === null) {
        break;
      }
      queue.delete(best.id);
      now = best.at;
      best.run();
    }
    now = until;
  };

  return { timers, advance };
}

test("the bar has eleven keys and none of them repeat by accident", () => {
  assert.equal(KEY_BAR_KEYS.length, 11);
  assert.deepEqual(
    KEY_BAR_KEYS.map((key) => key.id),
    ["esc", "tab", "ctrl", "alt", "shift", "up", "down", "left", "right", "ctrl-c", "enter"],
  );
  assert.equal(new Set(KEY_BAR_KEYS.map((key) => key.id)).size, KEY_BAR_KEYS.length);
  assert.deepEqual(
    KEY_BAR_KEYS.filter((key) => key.repeat).map((key) => key.id),
    ["tab", "up", "down", "left", "right"],
  );
  for (const key of KEY_BAR_KEYS) {
    assert.ok(key.label.length > 0, `${key.id} has no label`);
    assert.ok(key.ariaLabel.length > 0, `${key.id} has no spoken name`);
  }
});

test("the picker bar carries only the keys a picker reads", () => {
  assert.deepEqual(
    PICKER_BAR_KEYS.map((key) => key.id),
    ["esc", "up", "down", "left", "right", "enter"],
  );
  // Every button in the picker bar sends itself; none of them latches.
  for (const key of PICKER_BAR_KEYS) {
    assert.equal(key.modifier, undefined, `${key.id} latches`);
  }
  const latches = emptyLatches();
  assert.deepEqual(
    PICKER_BAR_KEYS.map((key) => keyNameFor(key, latches)),
    ["esc", "Up", "Down", "Left", "Right", "Enter"],
  );
});

test("the visible row is the six keys a thumb needs, and it fits a phone", () => {
  assert.deepEqual(
    BAR_KEYS.map((key) => key.id),
    ["esc", "tab", "ctrl", "ctrl-c", "up", "enter"],
  );
  // Every key on the row is the bar's own key object, not a copy: a test that
  // edits a stroke in one place must not leave the other layer stale.
  for (const key of BAR_KEYS) {
    assert.ok(KEY_BAR_KEYS.includes(key), `${key.id} is not a bar key`);
  }
  // 36px per key, 4px gaps and the 36px menu button: 6*36 + 6*4 + 36 = 276,
  // which is under 320px even before the bar's 16px of padding.
  assert.ok(BAR_KEYS.length * 36 + BAR_KEYS.length * 4 + 36 + 16 <= 320);
});

test("the menu holds the whole vocabulary, four to a row", () => {
  assert.equal(KEY_MENU_KEYS.length, 16);
  assert.equal(KEY_MENU_KEYS.length % KEY_MENU_COLUMNS, 0);
  assert.deepEqual(
    KEY_MENU_KEYS.map((key) => key.id),
    [
      "esc",
      "tab",
      "backspace",
      "enter",
      "ctrl",
      "alt",
      "shift",
      "ctrl-c",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
    ],
  );
  assert.equal(new Set(KEY_MENU_KEYS.map((key) => key.id)).size, KEY_MENU_KEYS.length);
  // Nothing may disappear between the row and the menu.
  for (const key of BAR_KEYS) {
    assert.ok(KEY_MENU_KEYS.includes(key), `${key.id} is missing from the menu`);
  }
  for (const key of KEY_MENU_KEYS) {
    assert.ok(key.label.length > 0, `${key.id} has no label`);
    assert.ok(key.ariaLabel.length > 0, `${key.id} has no spoken name`);
  }
});

test("the keys a phone keyboard lacks reach the terminal with their own names", () => {
  const latches = emptyLatches();
  assert.equal(keyNameFor(fromMenu("backspace"), latches), "Backspace");
  assert.equal(keyNameFor(fromMenu("home"), latches), "Home");
  assert.equal(keyNameFor(fromMenu("end"), latches), "End");
  assert.equal(keyNameFor(fromMenu("pageup"), latches), "PageUp");
  assert.equal(keyNameFor(fromMenu("pagedown"), latches), "PageDown");
  // A latched modifier is a prefix, not a replacement: ctrl+End is valid too.
  // herdr lowercases a named key once a modifier is spelled out: `ctrl+home`.
  assert.equal(keyNameFor(fromMenu("home"), toggleLatch(latches, "ctrl")), "ctrl+home");
  assert.equal(keyNameFor(fromMenu("backspace"), toggleLatch(latches, "alt")), "alt+backspace");
  // Only the keys that a terminal autorepeats hold down; the page keys do not.
  assert.deepEqual(
    KEY_MENU_KEYS.filter((key) => key.repeat).map((key) => key.id),
    ["tab", "backspace", "up", "down", "left", "right"],
  );
});

test("with nothing latched each key sends its plain herdr name", () => {
  const latches = emptyLatches();
  assert.equal(keyNameFor(byId("esc"), latches), "esc");
  assert.equal(keyNameFor(byId("tab"), latches), "Tab");
  assert.equal(keyNameFor(byId("enter"), latches), "Enter");
  assert.equal(keyNameFor(byId("up"), latches), "Up");
  assert.equal(keyNameFor(byId("down"), latches), "Down");
  assert.equal(keyNameFor(byId("left"), latches), "Left");
  assert.equal(keyNameFor(byId("right"), latches), "Right");
  assert.equal(keyNameFor(byId("ctrl-c"), latches), "ctrl+c");
});

test("a modifier button latches instead of sending", () => {
  const latches = emptyLatches();
  assert.equal(keyNameFor(byId("ctrl"), latches), null);
  assert.equal(keyNameFor(byId("alt"), latches), null);
  assert.equal(keyNameFor(byId("shift"), latches), null);
  assert.equal(isArmed(byId("ctrl"), latches), false);
  assert.equal(isArmed(byId("ctrl"), toggleLatch(latches, "ctrl")), true);
  assert.equal(isArmed(byId("up"), toggleLatch(latches, "ctrl")), false);
});

test("a latched modifier prefixes the next key and nobody else", () => {
  const ctrl = toggleLatch(emptyLatches(), "ctrl");
  assert.equal(keyNameFor(byId("ctrl-c"), ctrl), "ctrl+c");
  assert.equal(keyNameFor(byId("up"), ctrl), "ctrl+up");
  assert.equal(keyNameFor(byId("left"), ctrl), "ctrl+left");
  assert.equal(keyNameFor(byId("tab"), ctrl), "ctrl+tab");

  const shift = toggleLatch(emptyLatches(), "shift");
  assert.equal(keyNameFor(byId("tab"), shift), "shift+tab");
  assert.equal(keyNameFor(byId("up"), shift), "shift+up");

  const alt = toggleLatch(emptyLatches(), "alt");
  assert.equal(keyNameFor(byId("right"), alt), "alt+right");
  assert.equal(keyNameFor(byId("esc"), alt), "alt+esc");
});

test("the ^C key stays Ctrl+C even while Ctrl is latched", () => {
  const ctrlAndShift = latchesAfterPress(latchesAfterPress(emptyLatches(), byId("ctrl")), byId("shift"));
  const stroke = strokeFor(byId("ctrl-c"), ctrlAndShift);
  assert.equal(stroke.key, "c");
  assert.equal(stroke.ctrlKey, true);
  assert.equal(stroke.shiftKey, true);
  assert.equal(keyNameFor(byId("ctrl-c"), ctrlAndShift), "ctrl+shift+c");
});

test("two modifiers together spell both, in protocol order", () => {
  const both = latchesAfterPress(latchesAfterPress(emptyLatches(), byId("alt")), byId("ctrl"));
  assert.equal(keyNameFor(byId("right"), both), "ctrl+alt+right");
  assert.equal(strokeFor(byId("right"), both).ctrlKey, true);
  assert.equal(strokeFor(byId("right"), both).altKey, true);
});

test("a latch spends itself on the next key, and modifiers toggle off", () => {
  let latches = emptyLatches();
  latches = latchesAfterPress(latches, byId("ctrl"));
  assert.equal(latches.ctrl, true);
  latches = latchesAfterPress(latches, byId("up"));
  assert.deepEqual(latches, emptyLatches());
  assert.equal(keyNameFor(byId("up"), latches), "Up");

  latches = latchesAfterPress(latches, byId("shift"));
  latches = latchesAfterPress(latches, byId("shift"));
  assert.equal(isArmed(byId("shift"), latches), false);
});

test("clearLatches drops every latch at once", () => {
  const latches = { ctrl: true, alt: true, shift: true };
  assert.deepEqual(clearLatches(), { ctrl: false, alt: false, shift: false });
  assert.deepEqual(emptyLatches(), { ctrl: false, alt: false, shift: false });
  assert.notEqual(clearLatches(), clearLatches());
  assert.deepEqual(Object.keys(latches).sort(), ["alt", "ctrl", "shift"]);
});

test("a held key does not repeat before the delay", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const repeat = createKeyRepeat(() => {
    ticks += 1;
  }, clock.timers);

  repeat.start();
  assert.equal(repeat.active, true);
  clock.advance(KEY_REPEAT_DELAY - 1);
  assert.equal(ticks, 0);
  clock.advance(1);
  assert.equal(ticks, 1);
  repeat.stop();
  assert.equal(repeat.active, false);
});

test("a held key repeats every interval until it is released", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const repeat = createKeyRepeat(() => {
    ticks += 1;
  }, clock.timers);

  repeat.start();
  clock.advance(KEY_REPEAT_DELAY);
  assert.equal(ticks, 1);
  clock.advance(KEY_REPEAT_INTERVAL * 3);
  assert.equal(ticks, 4);
  repeat.stop();
  clock.advance(KEY_REPEAT_INTERVAL * 4);
  assert.equal(ticks, 4);
});

test("releasing before the delay means the key never fires", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const repeat = createKeyRepeat(() => {
    ticks += 1;
  }, clock.timers);

  repeat.start();
  clock.advance(KEY_REPEAT_DELAY - 10);
  repeat.stop();
  clock.advance(KEY_REPEAT_INTERVAL * 10);
  assert.equal(ticks, 0);
});

test("pressing again restarts the repeat instead of doubling it", () => {
  const clock = fakeTimers();
  let ticks = 0;
  const repeat = createKeyRepeat(() => {
    ticks += 1;
  }, clock.timers);

  repeat.start();
  clock.advance(KEY_REPEAT_DELAY - 5);
  repeat.start();
  clock.advance(KEY_REPEAT_DELAY);
  assert.equal(ticks, 1);
  clock.advance(KEY_REPEAT_INTERVAL);
  assert.equal(ticks, 2);
  repeat.stop();
});

test("the default timers run on the real event loop", async () => {
  const repeat = createKeyRepeat(() => undefined);
  repeat.start();
  assert.equal(repeat.active, true);
  repeat.stop();
  assert.equal(repeat.active, false);
});

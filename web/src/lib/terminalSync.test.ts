import assert from "node:assert/strict";
import test from "node:test";

import { TerminalSync } from "./terminalSync.ts";

const CSI = "\u001b[";
const ERASE = `${CSI}2K`;
const ERASE_BELOW = `${CSI}J`;
const RESET = `${CSI}0m`;

test("first frame writes the whole snapshot from the top left", () => {
  const sync = new TerminalSync();
  assert.equal(sync.push("one\ntwo\nthree"), "one\r\ntwo\r\nthree");
  assert.deepEqual(sync.state(), { committed: ["one", "two"], remainder: "three" });
});

test("an empty snapshot never paints anything", () => {
  const sync = new TerminalSync();
  assert.equal(sync.push(""), "");
  assert.deepEqual(sync.state(), { committed: [], remainder: "" });
  assert.equal(sync.push("a"), "a");
  assert.equal(sync.push(""), "");
  assert.deepEqual(sync.state(), { committed: [], remainder: "a" });
});

test("the same snapshot again costs no bytes", () => {
  const sync = new TerminalSync();
  assert.equal(sync.push("one\ntwo\nthree"), "one\r\ntwo\r\nthree");
  assert.equal(sync.push("one\ntwo\nthree"), "");
});

test("re-serialised padding does not count as a change", () => {
  const sync = new TerminalSync();
  assert.equal(sync.push("one\ntwo\nthree"), "one\r\ntwo\r\nthree");
  // The daemon pads every line to the pane width and re-emits a reset.
  assert.equal(sync.push("one  \r\ntwo\t\t\r\nthree   " + RESET), "");
});

test("line endings, resets and bare carriage returns are stripped", () => {
  const sync = new TerminalSync();
  assert.equal(sync.push("alpha  \r\nbeta" + RESET), "alpha\r\nbeta");
  const returns = new TerminalSync();
  assert.equal(returns.push("ab\rcd"), "abcd");
  assert.deepEqual(returns.state(), { committed: [], remainder: "abcd" });
  const blank = new TerminalSync();
  assert.equal(blank.push("\r"), "");
  assert.deepEqual(blank.state(), { committed: [], remainder: "" });
});

test("a new line at the bottom is appended below the cursor", () => {
  const sync = new TerminalSync();
  sync.push("one\ntwo\nthree");
  assert.equal(sync.push("one\ntwo\nthree\nfour"), `\r\n${ERASE}four`);
  assert.deepEqual(sync.state(), { committed: ["one", "two", "three"], remainder: "four" });
});

test("only the changed tail is rewritten, in place", () => {
  const sync = new TerminalSync();
  sync.push("one\ntwo\nthree");
  assert.equal(sync.push("one\ntwo\nTHREE"), `\r${ERASE}THREE`);
});

test("a change inside the head repaints the frame, never edits history", () => {
  const sync = new TerminalSync();
  sync.push("one\ntwo\nthree");
  // Contract §6.4: without a viewport window the differ cannot know whether
  // the head is still on screen, so it appends a fresh frame instead.
  assert.equal(sync.push("one\nTWO\nthree"), `\r\n${ERASE}one\r\n${ERASE}TWO\r\n${ERASE}three`);
});

test("a shorter frame repaints in the contract's default mode", () => {
  const sync = new TerminalSync();
  sync.push("one\ntwo\nthree");
  assert.equal(sync.push("one\ntwo"), `\r\n${ERASE}one\r\n${ERASE}two`);
  assert.deepEqual(sync.state(), { committed: ["one"], remainder: "two" });
});

test("a repaint that loses the head starts a fresh frame, never edits history", () => {
  const sync = new TerminalSync();
  sync.push("a\nb\nc");
  assert.equal(sync.push("X\nb\nc"), `\r\n${ERASE}X\r\n${ERASE}b\r\n${ERASE}c`);
  assert.deepEqual(sync.state(), { committed: ["X", "b"], remainder: "c" });
});

test("a viewport window appends the rows that scrolled in, keeping history", () => {
  const sync = new TerminalSync({ rows: 4 });
  assert.equal(sync.push("a\nb\nc\nd"), "a\r\nb\r\nc\r\nd");
  assert.deepEqual(sync.state(), { committed: ["a", "b", "c"], remainder: "d" });
  assert.equal(sync.push("b\nc\nd\ne"), `\r\n${ERASE}e`);
  assert.deepEqual(sync.state(), { committed: ["b", "c", "d"], remainder: "e" });
});

test("the first frame still writes the whole snapshot when the window is smaller", () => {
  const sync = new TerminalSync({ rows: 2 });
  assert.equal(sync.push("1\n2\n3\n4"), "1\r\n2\r\n3\r\n4");
  assert.deepEqual(sync.state(), { committed: ["3"], remainder: "4" });
});

test("a repaint inside the window is rewritten in place", () => {
  const sync = new TerminalSync({ rows: 4 });
  sync.push("a\nb\nc\nd");
  sync.push("b\nc\nd\ne");
  assert.equal(
    sync.push("b\nX\nd\ne"),
    `${CSI}2A\r${ERASE}X\r\n${ERASE}d\r\n${ERASE}e`,
  );
});

test("a shrink inside the window erases what is left over", () => {
  const sync = new TerminalSync({ rows: 4 });
  sync.push("a\nb\nc\nd");
  // The last row changed: one row up, rewrite it, drop what was below.
  assert.equal(sync.push("a\nb\nX"), `${CSI}1A\r${ERASE}X${ERASE_BELOW}`);
  // A real prefix: step back onto the last shared row and erase below it.
  const prefix = new TerminalSync({ rows: 4 });
  prefix.push("a\nb\nc\nd");
  assert.equal(prefix.push("a\nb"), `${CSI}2A\r${ERASE}b${ERASE_BELOW}`);
});

test("cols reflow wraps long lines into addressable rows", () => {
  const sync = new TerminalSync({ cols: 10 });
  assert.equal(sync.push("abcdefghijklm"), `abcdefghij${RESET}\r\nklm${RESET}`);
  assert.deepEqual(sync.state(), { committed: [`abcdefghij${RESET}`], remainder: `klm${RESET}` });
});

test("cols reflow reopens the style a row was cut in", () => {
  const sync = new TerminalSync({ cols: 10 });
  assert.equal(
    sync.push(`${CSI}31mabcdefghijkl`),
    `${CSI}31mabcdefghij${RESET}\r\n${CSI}31mkl${RESET}`,
  );
});

test("cols reflow counts a wide character as two cells", () => {
  const sync = new TerminalSync({ cols: 10 });
  assert.equal(sync.push("中文中文中文"), `中文中文中${RESET}\r\n文${RESET}`);
});

test("cols reflow expands a tab to the next tab stop", () => {
  const sync = new TerminalSync({ cols: 16 });
  assert.equal(sync.push("a\tb"), `a       b${RESET}`);
});

test("cols reflow scrolls row by row when whole lines roll over", () => {
  const sync = new TerminalSync({ cols: 4, rows: 8 });
  sync.push("abcd\nefgh\nijkl\nmnop");
  assert.deepEqual(sync.state(), {
    committed: [`abcd${RESET}`, `efgh${RESET}`, `ijkl${RESET}`],
    remainder: `mnop${RESET}`,
  });
  assert.equal(sync.push("efgh\nijkl\nmnop\nqrst"), `\r\n${ERASE}qrst${RESET}`);
});

test("a scroll never happens when the window changed size", () => {
  const sync = new TerminalSync({ rows: 8 });
  sync.push("abcd\nefgh");
  // Two rows to three rows is a repaint, not a scroll: the append path needs
  // the same window height or it would over-scroll.
  const grew = sync.push("efgh\nijkl\nmnop");
  assert.equal(grew, `${CSI}1A\r${ERASE}efgh\r\n${ERASE}ijkl\r\n${ERASE}mnop`);
});

test("a long trailing partial line is capped to its tail", () => {
  const sync = new TerminalSync({ maxRemainder: 4 });
  assert.equal(sync.push("0123456789"), "6789");
  assert.deepEqual(sync.state(), { committed: [], remainder: "6789" });
});

test("reset forgets the screen so the next push repaints it", () => {
  const sync = new TerminalSync();
  sync.push("a\nb");
  sync.reset();
  assert.deepEqual(sync.state(), { committed: [], remainder: "" });
  assert.equal(sync.push("a\nb"), "a\r\nb");
});

test("a width change resets the differ, a height change only trims the window", () => {
  const sync = new TerminalSync({ cols: 10, rows: 4 });
  sync.push("abcdefghijkl");
  sync.setGeometry(20, 4);
  assert.deepEqual(sync.state(), { committed: [], remainder: "" });
  assert.equal(sync.push("abcdefghijkl"), `abcdefghijkl${RESET}`);

  const height = new TerminalSync({ rows: 4 });
  height.push("1\n2\n3\n4");
  height.setGeometry(0, 2);
  assert.deepEqual(height.state(), { committed: ["3"], remainder: "4" });
});

test("a 400 KB / 1000-line snapshot stays cheap and a repaint stays small", () => {
  const lines: string[] = [];
  for (let i = 0; i < 1000; i += 1) {
    lines.push(`${CSI}38;5;114m${String(i).padStart(4, "0")} ${"·".repeat(380)}${RESET}  `);
  }
  const snapshot = lines.join("\r\n");
  assert.ok(snapshot.length > 380_000);

  const sync = new TerminalSync({ cols: 46, rows: 40 });
  const started = performance.now();
  const first = sync.push(snapshot);
  const firstMs = performance.now() - started;
  const rows = first.split("\r\n").length;
  assert.ok(rows > 1000, `a 380-cell line has to wrap: got ${rows} rows`);
  assert.ok(firstMs < 1500, `first frame took ${firstMs.toFixed(1)} ms`);

  // The next poll has the same screen: no bytes at all.
  assert.equal(sync.push(snapshot), "");
  assert.equal(sync.state().committed.length, 39);

  // A repaint of the last line writes the tail, not the snapshot.
  const next = snapshot.replace(/(\r\n)[^\r\n]*$/, `$1${CSI}32mchanged${RESET}`);
  const delta = sync.push(next);
  assert.ok(delta.length < 8000, `repaint wrote ${delta.length} bytes`);
  assert.ok(delta.length < snapshot.length / 20, "repaint must not resend the snapshot");
});

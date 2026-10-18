import assert from "node:assert/strict";
import test from "node:test";

import { ansiLineToHtml, colour256, stripAnsi } from "./ansi.ts";

const ESC = "\u001b";

test("plain lines pass through and empty padding collapses", () => {
  assert.equal(ansiLineToHtml("hello world"), "hello world");
  assert.equal(ansiLineToHtml(""), "");
  // A terminal pads to its width; that padding is not content.
  assert.equal(ansiLineToHtml("prompt%        "), "prompt%");
  assert.equal(ansiLineToHtml("prompt%\r"), "prompt%");
  assert.equal(ansiLineToHtml("   "), "");
});

test("html is escaped before any styling is applied", () => {
  assert.equal(ansiLineToHtml("a&b<c>d"), "a&amp;b&lt;c&gt;d");
  assert.equal(
    ansiLineToHtml(`${ESC}[31m<script>${ESC}[0m`),
    '<span style="color:var(--ansi-1)">' + "&lt;script&gt;</span>",
  );
});

test("base colours, bold and reset", () => {
  assert.equal(
    ansiLineToHtml(`${ESC}[32mok${ESC}[0m plain`),
    '<span style="color:var(--ansi-2)">ok</span> plain',
  );
  assert.equal(
    ansiLineToHtml(`${ESC}[1;33mwarn${ESC}[0m`),
    '<span style="color:var(--ansi-3);font-weight:700">warn</span>',
  );
  assert.equal(ansiLineToHtml(`${ESC}[1mx${ESC}[22my`), '<span style="font-weight:700">x</span>y');
  assert.equal(ansiLineToHtml(`${ESC}[4mlink${ESC}[24m`), '<span style="text-decoration:underline">link</span>');
  assert.equal(ansiLineToHtml(`${ESC}[2mdim${ESC}[22m`), '<span style="opacity:.65">dim</span>');
});

test("bright colours and backgrounds", () => {
  assert.equal(ansiLineToHtml(`${ESC}[91mtodo${ESC}[0m`), '<span style="color:var(--ansi-9)">todo</span>');
  assert.equal(
    ansiLineToHtml(`${ESC}[44mbar${ESC}[49m`),
    '<span style="background-color:var(--ansi-4)">bar</span>',
  );
});

test("256-colour codes map to the xterm cube and greys", () => {
  // The daemon's zsh prompt uses exactly this form.
  assert.equal(ansiLineToHtml(`${ESC}[38;5;6madmin${ESC}[0m`), '<span style="color:var(--ansi-6)">admin</span>');
  assert.equal(colour256(196), "rgb(255,0,0)");
  assert.equal(colour256(16), "rgb(0,0,0)");
  assert.equal(colour256(21), "rgb(0,0,255)");
  assert.equal(colour256(232), "rgb(8,8,8)");
  assert.equal(colour256(255), "rgb(238,238,238)");
  assert.equal(colour256(9), "var(--ansi-9)");
  assert.equal(colour256(256), "");
  assert.equal(colour256(-1), "");
  assert.equal(colour256(1.5), "");
  assert.equal(
    ansiLineToHtml(`${ESC}[48;5;196mred bg${ESC}[0m`),
    '<span style="background-color:rgb(255,0,0)">red bg</span>',
  );
});

test("truecolor codes are supported", () => {
  assert.equal(
    ansiLineToHtml(`${ESC}[38;2;10;20;30mrgb${ESC}[0m`),
    '<span style="color:rgb(10,20,30)">rgb</span>',
  );
  // Out-of-range channels are clamped, not trusted.
  assert.equal(
    ansiLineToHtml(`${ESC}[38;2;300;-5;30mrgb${ESC}[0m`),
    '<span style="color:rgb(255,0,30)">rgb</span>',
  );
});

test("reverse video swaps the colours and falls back to theme ink and paper", () => {
  // Reverse with a red foreground means red background, default ink text.
  assert.equal(
    ansiLineToHtml(`${ESC}[7;31mrev${ESC}[0m`),
    '<span style="color:var(--ink);background-color:var(--ansi-1)">rev</span>',
  );
  assert.equal(
    ansiLineToHtml(`${ESC}[7mrev${ESC}[0m`),
    '<span style="color:var(--ink);background-color:var(--paper)">rev</span>',
  );
});

test("unknown and non-SGR sequences are dropped, never emitted", () => {
  assert.equal(ansiLineToHtml(`${ESC}[99mkept${ESC}[0m`), "kept");
  assert.equal(ansiLineToHtml(`${ESC}[5mblink${ESC}[0m`), "blink");
  // Cursor moves and erases: text survives, the control sequence does not.
  assert.equal(ansiLineToHtml(`${ESC}[2K${ESC}[Htext`), "text");
  assert.equal(ansiLineToHtml(`${ESC}[31mred${ESC}[39mdefault`), '<span style="color:var(--ansi-1)">red</span>default');
  // A stray escape byte never reaches the DOM, whatever it is followed by.
  assert.equal(ansiLineToHtml(`a${ESC}b`), "ab");
  assert.equal(ansiLineToHtml(`${ESC}]0;title\u0007text`), `${ESC}]0;title\u0007text`.replace(ESC, ""));
});

test("stripAnsi returns readable text", () => {
  assert.equal(stripAnsi(`${ESC}[38;5;6madmin${ESC}[0m ${ESC}[38;5;4m/tmp${ESC}[0m`), "admin /tmp");
  assert.equal(stripAnsi("line\r\n"), "line\n");
});

test("a realistic zsh prompt line renders every segment", () => {
  const line = `${ESC}[0m${ESC}[38;5;6madmin${ESC}[0m ${ESC}[0m${ESC}[38;5;4m/tmp${ESC}[0m ${ESC}[0m${ESC}[38;5;2m%${ESC}[0m echo hi`;
  const html = ansiLineToHtml(line);
  assert.ok(html.includes(">admin</span>"), html);
  assert.ok(html.includes(">/tmp</span>"), html);
  assert.ok(html.includes(">%</span> echo hi"), html);
  assert.ok(!html.includes(ESC), "no escape bytes in the output");
});

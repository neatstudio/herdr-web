import assert from "node:assert/strict";
import test from "node:test";

import {
  ansiCacheStats,
  ansiLineToHtml,
  ANSI_CACHE_CAPACITY,
  clearAnsiCache,
  colour256,
  canvasTone,
  inkOn,
  stripAnsi,
} from "./ansi.ts";

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
    '<span style="color:var(--ansi-ink-on-dark);background-color:var(--ansi-4)">bar</span>',
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
    '<span style="color:var(--ansi-ink-on-dark);background-color:rgb(255,0,0)">red bg</span>',
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
  // The directory in the prompt is a path, so it is a link now.
  assert.ok(html.includes('<a class="path" data-path="/tmp" href="#">/tmp</a>'), html);
  assert.ok(html.includes(">%</span> echo hi"), html);
  assert.ok(!html.includes(ESC), "no escape bytes in the output");
});

test("only paths become links, and prose around them stays plain", () => {
  const html = ansiLineToHtml("wrote /tmp/a.png and/or 2/3 see https://x/y");
  assert.ok(html.includes('data-path="/tmp/a.png"'), html);
  assert.equal(html.match(/data-path=/g)?.length, 1, html);
  // Escaping still happens, inside the link too.
  const quoted = ansiLineToHtml("cat /tmp/a&b.png");
  assert.ok(quoted.includes("&amp;"), quoted);
  assert.ok(!quoted.includes("<script"), quoted);
});

test("padding is dropped when nothing is painting it", () => {
  // A plain shell line padded to the terminal width must not become an
  // invisible run of spaces that widens the transcript.
  assert.equal(ansiLineToHtml(`prompt% ${" ".repeat(60)}`), "prompt%");
  assert.equal(ansiLineToHtml(`${ESC}[32mok${ESC}[0m${" ".repeat(40)}`), '<span style="color:var(--ansi-2)">ok</span>');
});

test("padding survives when it is painting a background", () => {
  // This is how full-screen apps fill a row: the trailing spaces carry the
  // canvas colour, so dropping them would break the canvas at the row edge.
  const line = `${ESC}[48;2;20;20;20mtext${" ".repeat(20)}${ESC}[0m`;
  const html = ansiLineToHtml(line);
  assert.ok(html.includes("text" + " ".repeat(20)), html);
  assert.ok(html.includes("background-color:rgb(20,20,20)"), html);
});

test("a background with no foreground gets a contrasting ink", () => {
  // Full-screen apps set a canvas and rely on the terminal's default text
  // colour. Inheriting the page ink printed near-black on near-black, which
  // is exactly the light-theme bug this guards.
  const html = ansiLineToHtml(`${ESC}[48;2;20;20;20m   canvas   ${ESC}[0m`);
  assert.ok(html.includes("color:var(--ansi-ink-on-dark)"), html);
  assert.ok(html.includes("background-color:rgb(20,20,20)"), html);
  // A light background takes dark ink instead.
  const light = ansiLineToHtml(`${ESC}[48;2;240;240;240m  light  ${ESC}[0m`);
  assert.ok(light.includes("color:var(--ansi-ink-on-light)"), light);
  // An explicit foreground always wins over the fallback.
  const explicit = ansiLineToHtml(`${ESC}[38;2;10;200;10;48;2;20;20;20m  x  ${ESC}[0m`);
  assert.ok(explicit.includes("color:rgb(10,200,10)"), explicit);
});

test("inkOn measures absolute colours and knows the palette split", () => {
  assert.equal(inkOn("rgb(0,0,0)"), "var(--ansi-ink-on-dark)");
  assert.equal(inkOn("rgb(255,255,255)"), "var(--ansi-ink-on-light)");
  assert.equal(inkOn("rgb(20,20,20)"), "var(--ansi-ink-on-dark)");
  assert.equal(inkOn("rgb(200,200,200)"), "var(--ansi-ink-on-light)");
  // Palette references: base 0 is a dark background, 7 and 15 are light ones.
  assert.equal(inkOn("var(--ansi-0)"), "var(--ansi-ink-on-dark)");
  assert.equal(inkOn("var(--ansi-7)"), "var(--ansi-ink-on-light)");
  assert.equal(inkOn("var(--ansi-15)"), "var(--ansi-ink-on-light)");
});

test("canvasTone reports the painted colour and how much of the pane it covers", () => {
  const canvas = `${ESC}[48;2;20;20;20m${" ".repeat(120)}${ESC}[0m`;
  const text = `${ESC}[48;2;20;20;20m  some content  ${ESC}[0m`;
  const full = canvasTone([canvas, canvas, text]);
  assert.equal(full.colour, "rgb(20,20,20)");
  assert.equal(full.share, 1);

  // Ordinary shell output has no background at all.
  assert.deepEqual(canvasTone(["prompt% ls", "file.txt"]), { colour: null, share: 0 });
  assert.deepEqual(canvasTone([]), { colour: null, share: 0 });

  // A single highlighted word is not even a candidate.
  assert.deepEqual(canvasTone([`${ESC}[48;2;60;0;0mFAIL${ESC}[0m`, "plain", "plain"]), {
    colour: null,
    share: 0,
  });
});

test("a highlight band inside ordinary output is not a canvas", () => {
  // The shape `grep --color` and `diff` produce: a long red background across a
  // minority of lines, among plain output. Painting the pane in that colour
  // would turn a highlight into a wall.
  const plain = "drwxr-xr-x@ 37 admin staff 1.2K Oct 17 22:01 api";
  const highlighted = `${ESC}[48;5;1m${"x".repeat(100)}${ESC}[0m`;
  const lines = Array.from({ length: 200 }, (_, index) => (index % 7 === 0 ? highlighted : plain));
  const tone = canvasTone(lines);
  assert.equal(tone.colour, "var(--ansi-1)");
  // Far too little coverage to be a canvas: it is a highlight band.
  assert.ok(tone.share < 0.2, `share was ${tone.share}`);
});

test("a canvas still wins once it covers most of the pane", () => {
  // The same colour, but painted on nearly every line, is a canvas again.
  const canvas = `${ESC}[48;2;20;20;20m${" ".repeat(120)}${ESC}[0m`;
  const lines = Array.from({ length: 10 }, (_, index) =>
    index === 9 ? "a single plain line" : canvas,
  );
  const tone = canvasTone(lines);
  assert.equal(tone.colour, "rgb(20,20,20)");
  assert.equal(tone.share, 0.9);
});

test("paper mode mirrors a dark content canvas and its text", () => {
  // A full-screen app's near-black canvas is a dark block on the light page;
  // it becomes a light canvas, and its default ink flips with it.
  assert.equal(
    ansiLineToHtml(`${ESC}[48;2;20;20;20m   canvas   ${ESC}[0m`, "paper"),
    '<span style="color:var(--ansi-ink-on-light);background-color:rgb(235,235,235)">' +
      "   canvas   </span>",
  );
  // Light grey body text darkens instead of vanishing into the light canvas.
  assert.equal(
    ansiLineToHtml(`${ESC}[38;2;200;200;200mtext${ESC}[0m`, "paper"),
    '<span style="color:rgb(55,55,55)">text</span>',
  );
});

test("carbon mode mirrors a light background the other way", () => {
  assert.equal(
    ansiLineToHtml(`${ESC}[48;2;235;235;235m light bg ${ESC}[0m`, "carbon"),
    '<span style="color:var(--ansi-ink-on-dark);background-color:rgb(20,20,20)">' +
      " light bg </span>",
  );
  // Mid-tone colours read on either canvas, so inverting lightness is a no-op
  // within rounding.
  assert.equal(
    ansiLineToHtml(`${ESC}[38;2;128;128;128mtext${ESC}[0m`, "carbon"),
    '<span style="color:rgb(127,127,127)">text</span>',
  );
});

test("palette references are untouched in paper mode", () => {
  // Each theme already tunes the 16 base colours for its own paper; inverting
  // them would fight the theme.
  assert.equal(
    ansiLineToHtml(`${ESC}[38;5;2mok${ESC}[0m`, "paper"),
    '<span style="color:var(--ansi-2)">ok</span>',
  );
  assert.equal(
    ansiLineToHtml(`${ESC}[44mbar${ESC}[49m`, "paper"),
    '<span style="color:var(--ansi-ink-on-dark);background-color:var(--ansi-4)">bar</span>',
  );
});

test("the default mode is content, byte for byte", () => {
  const line = `${ESC}[1;48;2;20;20;20m${ESC}[38;2;200;200;200mhi ${" ".repeat(12)}${ESC}[0m plain`;
  const html = ansiLineToHtml(line);
  assert.equal(html, ansiLineToHtml(line, "content"));
  assert.ok(html.includes("color:rgb(200,200,200)"), html);
  assert.ok(html.includes("background-color:rgb(20,20,20)"), html);
  assert.ok(html.includes("font-weight:700"), html);
});

test("the canvas colour survives every mode, because the caller adapts it", () => {
  // The mode no longer decides whether there is a canvas: the caller mirrors
  // the colour for the page theme (canvasBackdrop), so the tone itself is
  // reported once and adapted afterwards.
  const canvas = `${ESC}[48;2;20;20;20m${" ".repeat(120)}${ESC}[0m`;
  const text = `${ESC}[48;2;20;20;20m  some content  ${ESC}[0m`;
  assert.equal(canvasTone([canvas, canvas, text]).colour, "rgb(20,20,20)");
});

test("a real full-screen TUI line renders readably on paper", () => {
  // The shape a coding agent emits: reset, canvas, chrome, light grey body
  // text, then padding that carries the canvas to the row edge.
  const line =
    `${ESC}[0m${ESC}[48;2;20;20;20m  ${ESC}[38;2;200;200;200mBuild finished in 1.2s` +
    `${" ".repeat(40)}${ESC}[0m`;
  const html = ansiLineToHtml(line, "paper");
  assert.ok(!html.includes(ESC), html);
  assert.ok(html.includes("background-color:rgb(235,235,235)"), html);
  assert.ok(html.includes("color:rgb(55,55,55)"), html);
  assert.ok(!html.includes("rgb(20,20,20)"), html);
  assert.ok(!html.includes("rgb(200,200,200)"), html);
  assert.ok(html.includes("Build finished in 1.2s"), html);
});

test("rendering the same line twice in one mode is a hit", () => {
  clearAnsiCache();
  const line = `${ESC}[1;48;2;20;20;20m  build${ESC}[0m ok`;
  const first = ansiLineToHtml(line, "content");
  assert.deepEqual(ansiCacheStats(), { size: 1, hits: 0, misses: 1 });
  const second = ansiLineToHtml(line, "content");
  assert.equal(second, first);
  // A hit reuses the entry instead of adding a second one for the same line.
  assert.deepEqual(ansiCacheStats(), { size: 1, hits: 1, misses: 1 });
  assert.ok(first.includes("background-color:rgb(20,20,20)"), first);
});

test("the cache key includes the canvas mode", () => {
  clearAnsiCache();
  const line = `${ESC}[48;2;20;20;20m   canvas   ${ESC}[0m`;
  const content = ansiLineToHtml(line, "content");
  const paper = ansiLineToHtml(line, "paper");
  // Each mode alone still decides the markup: no cross-mode collision.
  assert.equal(
    content,
    '<span style="color:var(--ansi-ink-on-dark);background-color:rgb(20,20,20)">' +
      "   canvas   </span>",
  );
  assert.equal(
    paper,
    '<span style="color:var(--ansi-ink-on-light);background-color:rgb(235,235,235)">' +
      "   canvas   </span>",
  );
  // Two cold calls, two entries: the mode is part of the key.
  assert.deepEqual(ansiCacheStats(), { size: 2, hits: 0, misses: 2 });
});

test("the cache is bounded and evicts the oldest line first", () => {
  clearAnsiCache();
  const lineFor = (index: number): string => `distinct line ${index}`;
  const pushed = ANSI_CACHE_CAPACITY + 5;
  for (let index = 0; index < pushed; index += 1) {
    ansiLineToHtml(lineFor(index));
  }
  const filled = ansiCacheStats();
  assert.ok(filled.size <= ANSI_CACHE_CAPACITY, `size ${filled.size} exceeds the cap`);
  assert.equal(filled.size, ANSI_CACHE_CAPACITY);
  assert.equal(filled.misses, pushed);
  assert.equal(filled.hits, 0);

  // The first line is gone; asking for it re-renders instead of going stale.
  assert.equal(ansiLineToHtml(lineFor(0)), "distinct line 0");
  const afterEvicted = ansiCacheStats();
  assert.equal(afterEvicted.misses, pushed + 1);
  assert.equal(afterEvicted.size, ANSI_CACHE_CAPACITY);
});

test("clearAnsiCache resets size, hits and misses", () => {
  clearAnsiCache();
  ansiLineToHtml("one");
  ansiLineToHtml("two");
  ansiLineToHtml("one");
  assert.deepEqual(ansiCacheStats(), { size: 2, hits: 1, misses: 2 });
  clearAnsiCache();
  assert.deepEqual(ansiCacheStats(), { size: 0, hits: 0, misses: 0 });
});

test("canvasTone is not memoised per line", () => {
  // It takes the whole array once per paint, not one line per call.
  clearAnsiCache();
  const canvas = `${ESC}[48;2;20;20;20m${" ".repeat(120)}${ESC}[0m`;
  canvasTone([canvas, canvas, `${ESC}[48;2;20;20;20m  text  ${ESC}[0m`]);
  assert.deepEqual(ansiCacheStats(), { size: 0, hits: 0, misses: 0 });
});

test("a realistic TUI line renders identically before and after caching", () => {
  // The shape a full-screen app emits: reset, its own canvas, light grey text,
  // then spaces that carry the canvas to the row edge.
  clearAnsiCache();
  const line =
    `${ESC}[0m${ESC}[48;2;20;20;20m${ESC}[38;2;200;200;200m  Build finished in 1.2s` +
    `${" ".repeat(120)}${ESC}[0m`;
  const cold = ansiLineToHtml(line, "content");
  const warm = ansiLineToHtml(line, "content");
  assert.equal(warm, cold);
  assert.deepEqual(ansiCacheStats(), { size: 1, hits: 1, misses: 1 });
  assert.ok(cold.includes("background-color:rgb(20,20,20)"), cold);
  assert.ok(cold.includes("color:rgb(200,200,200)"), cold);
  assert.ok(cold.includes("Build finished in 1.2s"), cold);
  assert.ok(cold.includes(" ".repeat(120)), cold);
  assert.ok(!cold.includes(ESC), cold);
});

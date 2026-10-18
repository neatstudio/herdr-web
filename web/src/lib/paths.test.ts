import assert from "node:assert/strict";
import test from "node:test";

import { expandHome, fetchFileMeta, findPaths, rawFileUrl } from "./paths.ts";

/** Paths of the matches, checking that start/end really index the input. */
function slices(text: string): string[] {
  const matches = findPaths(text);
  for (const match of matches) {
    assert.equal(text.slice(match.start, match.end), match.path, text);
  }
  return matches.map((match) => match.path);
}

test("absolute and home-rooted paths are found, in order", () => {
  assert.deepEqual(slices("/a/b"), ["/a/b"]);
  assert.deepEqual(slices("/tmp/chart.png"), ["/tmp/chart.png"]);
  assert.deepEqual(slices("~/shots/a.png"), ["~/shots/a.png"]);
  assert.deepEqual(slices("wrote /tmp/chart.png (12 KB)"), ["/tmp/chart.png"]);
  assert.deepEqual(slices("/a/b and ~/shots/a.png"), ["/a/b", "~/shots/a.png"]);
});

test("start and end index the input exactly", () => {
  const text = "look at /tmp/chart.png (12 KB) and ~/shots/a.png";
  const matches = findPaths(text);
  assert.deepEqual(
    matches.map((match) => match.path),
    ["/tmp/chart.png", "~/shots/a.png"],
  );
  assert.deepEqual(
    matches.map((match) => [match.start, match.end]),
    [
      [8, 22],
      [35, 48],
    ],
  );
  // Order and non-overlap are what lets a caller wrap the line in one pass.
  assert.ok(matches[0].end <= matches[1].start);
});

test("a segment may contain dots, dashes, underscores, @, +, %, : and =", () => {
  assert.deepEqual(slices("/tmp/a-b_c.d@e+f%g:h=i"), ["/tmp/a-b_c.d@e+f%g:h=i"]);
  assert.deepEqual(slices("see /Users/me/My-Dir/v1.2_final+x%20@2:1=x.txt"), [
    "/Users/me/My-Dir/v1.2_final+x%20@2:1=x.txt",
  ]);
});

test("trailing prose punctuation is not part of the path", () => {
  assert.deepEqual(slices("/tmp/a.png, /tmp/b.png;"), ["/tmp/a.png", "/tmp/b.png"]);
  assert.deepEqual(slices("/tmp/a.png. /tmp/b.png: /tmp/c.png)"), [
    "/tmp/a.png",
    "/tmp/b.png",
    "/tmp/c.png",
  ]);
  assert.deepEqual(slices('"/tmp/a.png" and `/tmp/b.png`'), ["/tmp/a.png", "/tmp/b.png"]);
  // A trailing slash only marks a directory.
  assert.deepEqual(slices("in /tmp/dir/ now"), ["/tmp/dir"]);
});

test("a closing paren survives only when the path opened it", () => {
  // Names really do carry parens; the pair is kept whole.
  assert.deepEqual(slices("/tmp/report(final)"), ["/tmp/report(final)"]);
  assert.deepEqual(slices("/tmp/shots(1)/a.png"), ["/tmp/shots(1)/a.png"]);
  // A paren the path did not open is the sentence's.
  assert.deepEqual(slices("see (/tmp/x.png) now"), ["/tmp/x.png"]);
  // A remark that never closes is not part of the name either.
  assert.deepEqual(slices("wrote /tmp/parenthetical(12 KB)"), ["/tmp/parenthetical"]);
});

test("a slash inside a word, a URL or a fraction is not a path start", () => {
  for (const text of [
    "and/or",
    "https://x/y",
    "https://example.com/tmp/x",
    "file:///tmp/x",
    "//x/y",
    "a/b/c",
    "2/3",
  ]) {
    assert.deepEqual(findPaths(text), [], text);
  }
  // Only the real path in the line is reported.
  assert.deepEqual(slices("see and/or /tmp/x"), ["/tmp/x"]);
});

test("a bare slash, a slash before space and a lone tilde are not paths", () => {
  for (const text of ["/", "/ x", "/\n", "~", "~ x", "and / or"]) {
    assert.deepEqual(findPaths(text), [], text);
  }
  // Two characters is too little to be a path: `/x` alone is prose.
  assert.deepEqual(findPaths("/x"), []);
  assert.deepEqual(findPaths("~/"), []);
});

test("plain text with no path yields nothing", () => {
  assert.deepEqual(findPaths(""), []);
  assert.deepEqual(findPaths("nothing to see here"), []);
});

test("expandHome uses a home only when one is given", () => {
  assert.equal(expandHome("~/shots/a.png", "/home/agent"), "/home/agent/shots/a.png");
  assert.equal(expandHome("~/shots", "/home/agent/"), "/home/agent/shots");
  assert.equal(expandHome("~", "/home/agent"), "/home/agent");
  assert.equal(expandHome("/tmp/x", "/home/agent"), "/tmp/x");
  // The browser does not know the server's home, so it never invents one.
  assert.equal(expandHome("~/shots/a.png"), "~/shots/a.png");
  assert.equal(expandHome("~other/x", "/home/agent"), "~other/x");
});

test("rawFileUrl encodes the path as data", () => {
  assert.equal(rawFileUrl("/tmp/chart.png"), "/api/v1/herdr/file/raw?path=%2Ftmp%2Fchart.png");
  assert.equal(rawFileUrl("/tmp/a b.png"), "/api/v1/herdr/file/raw?path=%2Ftmp%2Fa%20b.png");
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

/** Run `check` with a stubbed fetch, restoring the real one afterwards. */
async function withFetch<T>(
  stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
  check: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await check();
  } finally {
    globalThis.fetch = original;
  }
}

test("fetchFileMeta maps an image response", async () => {
  const seen: string[] = [];
  const meta = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse({
        path: "/tmp/chart.png",
        name: "chart.png",
        bytes: 12288,
        kind: "image",
      });
    },
    () => fetchFileMeta("/tmp/chart.png"),
  );
  assert.deepEqual(meta, {
    kind: "image",
    path: "/tmp/chart.png",
    name: "chart.png",
    bytes: 12288,
  });
  // The path is data, not a route, so encodeURIComponent is the whole contract.
  assert.deepEqual(seen, [
    `/api/v1/herdr/file?path=${encodeURIComponent("/tmp/chart.png")}`,
  ]);
});

test("fetchFileMeta maps a text response", async () => {
  const meta = await withFetch(
    async () =>
      jsonResponse({
        path: "/tmp/notes.txt",
        name: "notes.txt",
        bytes: 40,
        kind: "text",
        text: "hello\nworld\n",
        truncated: true,
      }),
    () => fetchFileMeta("/tmp/notes.txt"),
  );
  assert.deepEqual(meta, {
    kind: "text",
    path: "/tmp/notes.txt",
    name: "notes.txt",
    bytes: 40,
    text: "hello\nworld\n",
    truncated: true,
  });
});

test("fetchFileMeta maps an other response and a missing path", async () => {
  const other = await withFetch(
    async () => jsonResponse({ path: "/tmp/blob.bin", name: "blob.bin", bytes: 9, kind: "other" }),
    () => fetchFileMeta("/tmp/blob.bin"),
  );
  assert.deepEqual(other, { kind: "other", path: "/tmp/blob.bin", name: "blob.bin", bytes: 9 });

  // herdr can run the pane on another machine, so 404 is an answer, not a bug.
  const missing = await withFetch(
    async () => jsonResponse({}, 404),
    () => fetchFileMeta("/tmp/gone.png"),
  );
  assert.deepEqual(missing, { kind: "missing", path: "/tmp/gone.png" });
});

test("fetchFileMeta turns a non-200 into an error", async () => {
  const meta = await withFetch(
    async () => jsonResponse({}, 500),
    () => fetchFileMeta("/tmp/boom.png"),
  );
  assert.deepEqual(meta, { kind: "error", path: "/tmp/boom.png", message: "HTTP 500" });
});

test("fetchFileMeta turns a network failure into an error", async () => {
  const meta = await withFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    () => fetchFileMeta("/tmp/x.png"),
  );
  assert.deepEqual(meta, { kind: "error", path: "/tmp/x.png", message: "Failed to fetch" });
});

test("fetchFileMeta refuses a ~ path without asking the bridge", async () => {
  let requested = false;
  const meta = await withFetch(
    async () => {
      requested = true;
      return jsonResponse({});
    },
    () => fetchFileMeta("~/shots/a.png"),
  );
  assert.equal(requested, false);
  assert.equal(meta.kind, "error");
  assert.equal(meta.path, "~/shots/a.png");
});

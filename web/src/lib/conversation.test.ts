import assert from "node:assert/strict";
import test from "node:test";

import { deriveConversation, statusWord } from "./conversation.ts";
import { splitTables } from "./table.ts";

/* ------------------------------------------------------------------ ansi */

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

/** A pane line filled with the user-turn background. */
function band(text: string): string {
  return `${ESC}48;2;15;18;22m${text}${RESET}`;
}

/** Ordinary agent ink: the default foreground, no attributes. */
function ink(text: string): string {
  return `${ESC}38;2;232;236;244m${text}${RESET}`;
}

/** Reasoning: small, italic, grey. */
function dim(text: string): string {
  return `${ESC}38;2;156;163;176m${ESC}3m${text}${RESET}`;
}

/** Grey but upright: how Gemini paints its thought timing row. */
function grey(text: string): string {
  return `${ESC}38;5;7m${text}${RESET}`;
}

/** A box, every row on the same background fill. */
function box(rows: readonly string[]): string {
  return rows.map((row) => band(row.padEnd(64))).join("\n");
}

/** Antigravity echoes what was submitted, bold, behind a bare caret. */
function agyEcho(text: string): string {
  return `${ESC}1m${ESC}38;5;4m> ${text}${RESET}`;
}

/** One row of the Antigravity splash: half-block art with a label beside it. */
function agySplash(art: string, label: string): string {
  return `${ESC}38;2;240;114;54m${art}${RESET}        ${grey(label)}`;
}

const AGY_RULE = "─".repeat(60);

function snapshot(lines: readonly string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ cases */

test("an empty snapshot has no transcript", () => {
  assert.deepEqual(deriveConversation(""), { turns: [], lines: 0 });
});

test("one exchange folds reasoning, work and a recap into one turn", () => {
  const text = snapshot([
    band(" 帮我看一下这个 bug"),
    ink("我会先看一下代码。"),
    dim("先找入口，再核对接线。"),
    dim("看看 server/bridge.go。"),
    box([
      "+--- ~ Edit: go server/bridge.go [+2/-1] ---+",
      "| 12 -  old line",
      "| 12 +  new line",
      "+------------------------------------------+",
    ]),
    ink("改好了，可以重试。"),
    dim("※ recap: 修好了 bridge 的接线"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.lines, 10);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "帮我看一下这个 bug");
  assert.deepEqual(turn.thoughts, ["先找入口，再核对接线。\n看看 server/bridge.go。"]);
  assert.deepEqual(turn.work, [
    {
      kind: "edit",
      title: "Edit server/bridge.go",
      detail: ["12 -  old line", "12 +  new line"],
    },
  ]);
  assert.equal(turn.answer, "我会先看一下代码。\n改好了，可以重试。");
  assert.equal(turn.recap, "修好了 bridge 的接线");
});

test("a command queued mid-answer does not cut the answer in half", () => {
  // devin echoes the command the operator typed while the answer was still
  // streaming, together with the panel it printed, right where the stream is.
  // The answer carries on afterwards, so the echo is an interjection.
  const text = snapshot([
    band(" 继续检验。看看项目有没有跑偏"),
    ink("我先看最初的设计目标，再对照现在的代码。"),
    band(" /usage"),
    ink(" Daily   ■■■■■■■■■■■■■■■■■■■■  65% used  · resets in 9h 47m"),
    ink(" Weekly  ■■■■■■■■■■■■■■■■■■■■  33% used  · resets Oct 25, 8:00 AM (UTC)"),
    "",
    ink(" This session"),
    ink(" Activity  1 turn · 22 tool calls · 0 files · 6 commands"),
    ink(" Tokens    108k in · 2.1k out  (~110k per turn)"),
    ink(" Model     Claude Opus 5.5 Medium"),
    "",
    ink("未提交的改动都看过了，项目的主线没有跑偏。"),
    ink(" ---EOF--*"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "继续检验。看看项目有没有跑偏");
  assert.equal(
    turn.answer,
    "我先看最初的设计目标，再对照现在的代码。\n未提交的改动都看过了，项目的主线没有跑偏。",
  );
});

test("the panel a slash command prints is the answer to it", () => {
  const text = snapshot([
    band(" /usage"),
    ink(" Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m"),
    ink(" Weekly  ■■■■■■■■■■■■■■■■■■■■  50% used  · resets Oct 25, 8:00 AM (UTC)"),
    "",
    ink(" This session"),
    ink(" Activity  2 turns · 41 tool calls · 0 files · 19 commands"),
    ink(" Tokens    254k in · 5.1k out  (~129k per turn)"),
    ink(" Model     Claude Opus 5.5 Medium"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "/usage");
  assert.equal(
    turn.answer,
    [
      "Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m",
      "Weekly  ■■■■■■■■■■■■■■■■■■■■  50% used  · resets Oct 25, 8:00 AM (UTC)",
      "",
      "This session",
      "Activity  2 turns · 41 tool calls · 0 files · 19 commands",
      "Tokens    254k in · 5.1k out  (~129k per turn)",
      "Model     Claude Opus 5.5 Medium",
    ].join("\n"),
  );
});

test("a command typed after the answer finished opens its own turn", () => {
  const text = snapshot([
    band(" 继续检验。"),
    ink("看完了，结论在下面。"),
    ink(" ---EOF--*"),
    band(" /usage"),
    ink(" Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].answer, "看完了，结论在下面。");
  assert.equal(conversation.turns[1].user, "/usage");
  assert.equal(
    conversation.turns[1].answer,
    "Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m",
  );
});

test("without an end marker a command band still opens a turn", () => {
  // Only devin prints `---EOF--*`. A client that does not print it gives the
  // reader no way to tell a queued command from the next question, so the band
  // has to stay a turn boundary — the old rule, unchanged.
  const text = snapshot([
    band(" 继续检验。"),
    ink("看完了，结论在下面。"),
    band(" /usage"),
    ink(" Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].answer, "看完了，结论在下面。");
  assert.equal(conversation.turns[1].user, "/usage");
});

test("each user band opens a new turn", () => {
  const text = snapshot([
    band(" first"),
    ink("one"),
    band(" second"),
    ink("two"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].user, "first");
  assert.equal(conversation.turns[0].answer, "one");
  assert.equal(conversation.turns[1].user, "second");
  assert.equal(conversation.turns[1].answer, "two");
  assert.deepEqual(
    conversation.turns.map((turn) => turn.id),
    ["turn-0", "turn-1"],
  );
});

/**
 * devin's answers are plain prose, but an inline code mention carries a chip
 * background on a few glyphs (`48;2;0;43;54`). That rectangle is tiny and sits
 * mid-line; only a fill that starts before the text and covers the row is a
 * user message.
 */
test("an inline code chip does not turn an answer paragraph into a user turn", () => {
  const chip = (before: string, code: string, after: string): string =>
    `${before}${ESC}38;2;220;220;170m${ESC}48;2;0;43;54m ${code} ${RESET}${after}`;
  const text = snapshot([
    band(" 帮我看一下这个项目"),
    chip(" 仓库里有 README 和 ", "Fetures.md", "，没有独立的 SPECS。"),
    chip(" 工作区还有未提交的改动，我会保留它们。", "git status", " 已经确认。"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "帮我看一下这个项目");
  assert.match(turn.answer, /仓库里有 README 和\s+Fetures\.md/);
  assert.match(turn.answer, /我会保留它们/);
});

/**
 * devin paints that same chip inside a drawn table cell. The row then carries a
 * background, and the orphan-box reader — there for a box whose opener was cut
 * off above the scrollback window — moved it out of the answer. The table
 * arrived with the row missing and its wrapped continuation standing in as a
 * row of its own, so a two-column table rendered three cells
 * (`["", "行", "4 个文件"]`). A drawn row carries three or more border glyphs;
 * box body carries exactly two. Keep the row in the answer.
 */
test("a chip inside a drawn table cell does not lift the row out", () => {
  const chip = (code: string): string =>
    `${ESC}38;2;220;220;170m${ESC}48;2;0;43;54m ${code} ${RESET}`;
  const text = snapshot([
    band(" 看下这个项目的拆分"),
    ink(" ┌────────────────┬──────────────────────┐"),
    ink(" │ 问题           │ 证据                 │"),
    ink(" ├────────────────┼──────────────────────┤"),
    ink(` │ 单个文件太大   │ ${chip("server.go")} 2222 行 │`),
    ink(" │                │ 按职责拆成 4 个文件  │"),
    ink(" └────────────────┴──────────────────────┘"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "看下这个项目的拆分");
  const tables = splitTables(turn.answer).flatMap((segment) =>
    segment.kind === "table" ? [segment.table] : [],
  );
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].head, ["问题", "证据"]);
  assert.deepEqual(tables[0].rows, [["单个文件太大", "server.go  2222 行 按职责拆成 4 个文件"]]);
  assert.equal(turn.work.length, 0);
});

/**
 * A long inline code run wraps, so its fill lands on the next row from column
 * zero and covers most of it (`91%` on devin's `w6:p7`). "Most of the row" let
 * that row open a user turn: three tails of one answer surfaced as operator
 * bubbles while the answer above them stayed prose. A chip run always ends in
 * plain ink, so the fill never covers every glyph; a real band has nothing
 * after it.
 */
test("a wrapped inline code run does not open a user turn mid-answer", () => {
  const chip = (code: string): string =>
    `${ESC}38;2;220;220;170m${ESC}48;2;0;43;54m ${code} ${RESET}`;
  const text = snapshot([
    band(" 看下 fleet 和账本的信任边界"),
    ink(" Problem：peer 名单投毒 → 触发 token 转发和更新源劫持；heartbeat 每"),
    ink(" 30s 向所有 claimed addr POST → 持续 SSRF。"),
    `${chip("tConsoles() / knownPeerHost / fleetSources")}${ink(" 。")}`,
    ink(" If we skip it：入口都靠它开门。"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "看下 fleet 和账本的信任边界");
  assert.match(turn.answer, /claimed addr POST/);
  assert.match(turn.answer, /tConsoles\(\) \/ knownPeerHost/);
  assert.match(turn.answer, /If we skip it/);
  // The wrapped row must not be pulled into the user message before it either.
  assert.doesNotMatch(turn.user ?? "", /tConsoles/);
});

/**
 * devin fills the row it echoes as `❭ <first line>` and pads it to the pane
 * width; the wrapped continuation rows keep the fill but not the marker. The
 * marker must be stripped and the whole run kept: dropping the marked row as
 * chrome promoted the rest of the message to an agent answer.
 */
test("a filled prompt echo opens the user turn and loses its marker", () => {
  const text = snapshot([
    band("❭ 看下 README 和交接文档，"),
    band("有没有写清楚 SPECS 的范围"),
    ink("我先读一遍文档。"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "看下 README 和交接文档，\n有没有写清楚 SPECS 的范围");
  assert.equal(turn.answer, "我先读一遍文档。");
});

/**
 * devin wraps one submitted message over two filled rows and numbers the
 * second one `2、`. The item is a block start like `2.` is, otherwise the two
 * questions arrive glued together (`…逻辑问题2、之前写了…`).
 */
test("a numbered item in a wrapped message starts its own line", () => {
  const text = snapshot([
    band("❭ 1、深度Review当前项目，看看是否有性能和安全问题，同时判断思路有没有逻辑问题"),
    band("2、之前写了这么久都没有考虑有SPECS吗"),
    ink("我先读文档。"),
  ]);
  const turn = deriveConversation(text).turns[0];
  assert.equal(
    turn.user,
    "1、深度Review当前项目，看看是否有性能和安全问题，同时判断思路有没有逻辑问题\n2、之前写了这么久都没有考虑有SPECS吗",
  );
});

test("scrolled-in noise before the first user band has no user of its own", () => {
  const text = snapshot([ink("Earlier output."), band(" next question"), ink("answer")]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].answer, "Earlier output.");
  assert.equal(conversation.turns[1].user, "next question");
});

test("status bars, wall clocks and box controls never become prose", () => {
  const text = snapshot([
    band(" run the tests"),
    ink("[Wall: 0.14s | Timeout: 60s]"),
    ink("| 2m > [max] DeepSeek V4.1 Flash > ~/server/herdr-web > $2.62 >"),
    ink("╰──────────────────────────────────────────────"),
    ink("  … (15 earlier lines, showing 10 of 25) [Ctrl+O: Expand]"),
    ink("answer prose"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].answer, "answer prose");
});

/**
 * When a pane goes idle the client paints its own furniture under the answer:
 * a page marker, its splash, a fresh shell prompt, a rule, a mode footer.
 * None of it is something the agent said.
 */
test("client furniture under the answer never becomes prose", () => {
  const text = snapshot([
    band(" 改完后记得提交"),
    ink("改完了，已经提交，工作区是干净的。"),
    ink(" ---EOF--*"),
    ink("\u2800\u28F4\u28FE\u28F6\u2844"),
    ink("\u2800\u285B\u28BF\u285F\u28BB\u28F6\u28FE\u28F6\u2844  Devin CLI"),
    ink(" ⏺ ~/server/herdr-web"),
    ink("──────────────────────────────────────────"),
    ink("SWE-2 Max · bypass                    Context: 174k / 262k tokens (66%)"),
    ink("devin -r southern-bedbug"),
    ink("resumes this session · devin -r lists recent sessions"),
    // A separator drawn on the user-turn fill, with the subject baked into it.
    band("──────────────── 深度分析当前项目 ────────"),
    // omp's input box: a handoff hint and the model/permission footer.
    dim("🤝 HNDF: Add zerostack agent kind support"),
    dim("pi > [max] DeepSeek V4.1"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, "改完后记得提交");
  assert.equal(conversation.turns[0].answer, "改完了，已经提交，工作区是干净的。");
});

/**
 * omp paints the job it is on at the right edge of the row above its status
 * line — `🕵️ SPWN: Reduce token usage` — and it restores a conversation with
 * `Resumed session` one blank row under the answer. Both sat below the recap
 * and became the last thing the transcript said. The padding is the measured
 * one: 155 columns on a 200-column pane row.
 */
test("the right-aligned mode pill and the resume notice never become prose", () => {
  const pad = " ".repeat(155);
  const text = snapshot([
    band(" 顺手把 token 降下来"),
    ink("降下来了，单测也过了。"),
    ink(""),
    ink("Resumed session"),
    ink(""),
    ink(pad + "🕵️ SPWN: Reduce token usage, add jev decisions"),
    ink(
      " pi > [max] DeepSeek V4.1 Flash > [D] ~/server/wwwroot/xpier/xteam > @ main *12 > $0.73 >------45%------|------1M-",
    ),
    ink("╰─"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].answer, "降下来了，单测也过了。");
});

/**
 * When the job has no mode omp paints the bare title above its footer instead
 * of a badge pill — `Fix Ansible inventory tilde paths`, the same string herdr
 * shows in the tab strip. The shape rule cannot see it, so this one rides on
 * the position: right-aligned, on the row directly above the composer footer.
 */
test("the bare title omp paints above its footer never becomes prose", () => {
  const text = snapshot([
    band(" 修一下 ansible 的路径"),
    ink("改好了，join 还缺凭证。"),
    ink(""),
    ink(" ".repeat(110) + "Fix Ansible inventory tilde paths"),
    ink(
      " pi > [max] DeepSeek V4.1 Flash 1017 (AMR) > [D] ~/remote >--------------------------------35%",
    ),
    ink("╰─"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].answer, "改好了，join 还缺凭证。");
});

/**
 * The badge shape alone is not a signal: agents end reviews with
 * `✅ PASS: ...` at the margin, and list prose reaches deeper than a pill's
 * right edge would. Only the two together — an ALL-CAPS badge behind an emoji
 * *and* right alignment — mean furniture.
 */
test("an emoji badge the agent wrote at the margin stays prose", () => {
  const text = snapshot([
    band(" 跑一下门禁"),
    ink("✅ PASS: tsc, unit tests and the two spec files are green"),
    ink("    🚦 SHIP: indented under a list, not padded to the margin"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(
    conversation.turns[0].answer,
    [
      "✅ PASS: tsc, unit tests and the two spec files are green",
      "🚦 SHIP: indented under a list, not padded to the margin",
    ].join("\n"),
  );
});

/**
 * Position only means furniture with the client's footer under it. A
 * right-aligned line anywhere else is something the agent drew.
 */
test("a right-aligned title with no composer footer stays prose", () => {
  const text = snapshot([
    band(" 看看清单"),
    ink(" ".repeat(110) + "Fix Ansible inventory tilde paths"),
    ink("上面那行是我故意右对齐的。"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(
    conversation.turns[0].answer,
    ["Fix Ansible inventory tilde paths", "上面那行是我故意右对齐的。"].join("\n"),
  );
});

/**
 * Gemini draws its reasoning as a grey marker row rather than italic small
 * print — `▸ Thought for 5s, 184 tokens` — so the styling test reads it as
 * answer prose, and the transcript claims the agent wrote its own timing line.
 * The glyph alone cannot be the signal (`●` also opens a work row), so the
 * rule demands the word behind it.
 */
test("a grey gemini thought row folds into the work fold", () => {
  const text = snapshot([
    band(" 安装这个插件"),
    grey("▸ Thought for 5s, 184 tokens"),
    grey("○ Thought for 32.3s (working out the rules)"),
    grey("● Ran 7 commands (2.1s)"),
    ink("装好了，配置已经写进去。"),
  ]);
  const turn = deriveConversation(text).turns[0];
  assert.deepEqual(turn.thoughts, [
    "Thought for 5s, 184 tokens\nThought for 32.3s (working out the rules)",
  ]);
  assert.equal(turn.answer, "装好了，配置已经写进去。");
  // `● Ran` is work, not reasoning: the marker is shared, the word is not.
  assert.equal(turn.work.length, 1);
});

/**
 * The key hint sits under the input caret and is the last row in the pane; with
 * no rule it became the last line of the answer.
 */
test("the input box key hint is furniture, not the end of the answer", () => {
  const text = snapshot([
    band(" 好了吗"),
    ink("好了，工作区是干净的。"),
    ink("? for shortcuts"),
    ink("esc to interrupt"),
  ]);
  assert.equal(deriveConversation(text).turns[0].answer, "好了，工作区是干净的。");
});

/**
 * A bare `>` between two rules is the empty input box. It used to arrive as an
 * empty blockquote hanging off the end of the transcript; a `>` with words
 * after it is still a quote the agent wrote.
 */
test("an empty caret is furniture, a quote with words stays prose", () => {
  const text = snapshot([
    band(" 贴一下报错"),
    ink("关键就是这一行："),
    ink("> cannot find symbol: class Pane"),
    ink(">"),
  ]);
  const answer = deriveConversation(text).turns[0].answer;
  assert.match(answer, /^> cannot find symbol: class Pane$/m);
  assert.equal(answer.endsWith(">"), false);
});

test("glyph and bracket rows classify by what the agent did", () => {
  const text = snapshot([
    band(" run the tests"),
    " [*] Read server/bridge.go:60-150",
    " [x] Write server/jobs.go",
    " [!!] Diagnostics (1 error)",
    "  Esc Reading Server struct",
    " [*] Updated todo list (4 items)",
  ]);
  const conversation = deriveConversation(text);
  assert.deepEqual(
    conversation.turns[0].work.map((row) => [row.kind, row.title]),
    [
      ["read", "Read server/bridge.go:60-150"],
      ["edit", "Write server/jobs.go"],
      ["other", "Diagnostics (1 error) · failed"],
      ["other", "Reading Server struct"],
      ["other", "Updated todo list (4 items)"],
    ],
  );
});

test("an untitled box is the command and its output", () => {
  const text = snapshot([
    band(" run the tests"),
    box([
      "+--------------------------------+",
      "| $ go test ./server            |",
      "| ok  server  0.4s               |",
      "+--------------------------------+",
    ]),
  ]);
  const conversation = deriveConversation(text);
  assert.deepEqual(conversation.turns[0].work, [
    { kind: "command", title: "go test ./server", detail: ["ok  server  0.4s"] },
  ]);
});

test("an ascii table in the answer stays prose, not a tool box", () => {
  const text = snapshot([
    band(" give me the table"),
    ink("Here it is:"),
    ink("+---+---+"),
    ink("| a | b |"),
    ink("+---+---+"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns[0].work.length, 0);
  assert.equal(
    conversation.turns[0].answer,
    "Here it is:\n+---+---+\n| a | b |\n+---+---+",
  );
});

test("a pane with no ansi at all still becomes a document", () => {
  const text = "Plain output from an agent that does not colour.\nSecond line.\n";
  const conversation = deriveConversation(text);
  assert.equal(conversation.lines, 2);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(
    conversation.turns[0].answer,
    "Plain output from an agent that does not colour.\nSecond line.",
  );
});

test("a diff stat in a box title is not part of the title", () => {
  const text = snapshot([
    band(" edit it"),
    box([
      "+--- ~ Edit: md docs/specs/SPEC-06-urban-plan.md [+1] ---+",
      "| one line changed",
      "+--------------------------------------------------------+",
    ]),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns[0].work[0].kind, "edit");
  assert.equal(conversation.turns[0].work[0].title, "Edit docs/specs/SPEC-06-urban-plan.md");
});

/* ------------------------------------------- a window cut in mid-box */

/**
 * The live defect, with the right-hand column padding trimmed to one space:
 * omp pane `w6:p3`, the first 127 rows of a 1000-row `pane.read` window. The
 * window opens in the middle of a `+f Write` box — its opener and title are
 * above the cut — then runs through prose and three ordinary `~ Edit` boxes.
 * Background-filled body rows used to become user turns; only the leading
 * border glyph separates them from a real band (both share one background
 * colour).
 */
const CUT_BOX: readonly string[] = [
  "|+316│ →  → return \"local\" |",
  "|+317│ → } |",
  "|+318│ → return strings.TrimSpace(host) |",
  "|+319│} |",
  "|+320│ |",
  "|+321│// sharedTaskID ties a job to its shared-ledger task. A dispatched task already |",
  "|+322│// has an id; a directly started job gets one derived from its pane. |",
  "|+323│func sharedTaskID(request jobRequest, paneID string) string { |",
  "|+324│ → if id := strings.TrimSpace(request.TaskID); id != \"\" { |",
  "|+325│ →  → return id |",
  "|+326│ → } |",
  "|+327│ → return \"job-\" + paneID |",
  "|+328│} |",
  "|+329│ |",
  "|+330│// startSharedTask creates and claims the dev lease for a job. A failure here is |",
  "|+331│// logged rather than failing the start: the agent is already running, and the |",
  "|+332│// local ledger still records it; the board can catch up on the next attempt. |",
  "|+333│func (s *Server) startSharedTask(ctx context.Context, request jobRequest, taskID, label string) error { |",
  "|+334│ → if s.sharedLedger == nil || taskID == \"\" { |",
  "|+335│ →  → return nil |",
  "|+336│ → } |",
  "|+337│ → task, err := s.sharedLedger.Get(ctx, taskID) |",
  "|+338│ → if errors.Is(err, sharedledger.ErrNotFound) { |",
  "|+339│ →  → task, err = s.sharedLedger.Create(ctx, sharedledger.Task{ |",
  "|+340│ →  →  → ID: taskID, Title: label, Prompt: request.Prompt, Cwd: request.Cwd, |",
  "|+341│ →  →  → Branch: request.Branch, Kind: request.Kind, Weight: request.Weight, |",
  "|+342│ →  → }) |",
  "|+343│ →  → if err != nil { |",
  "|+344│ →  →  → return err |",
  "|+345│ →  → } |",
  "|+346│ → } else if err != nil { |",
  "|… (41 more lines) [Ctrl+O: Expand] |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_PROSE_A: readonly string[] = [
  "",
  " I see the startSharedTask has a typo: sharedledger.Task? I wrote sharedledger.Task? The content: task, err = s.sharedLedger.Create(ctx, sharedledger.Task{ — yes. The Task type is in sharedledger;",
  " fine.",
  " - The startSharedTask has sharedledger.Task; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The localNodeID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The cancelSharedTask; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Now modify the two branches. Use edit exact strings. The zerostack branch:...",
  " Change:...",
  " - The agent branch same.",
  " - The taskID variable; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Edit both.",
  "",
];
const CUT_EDIT_A: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+6/-2] -----------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "| 181│      if err := s.runInPane(ctx, paneID, command); err != nil { |",
  "| 182│         writeBadGateway(w, \"herdr_job_failed\", err) |",
  "| 183│         return |",
  "| 184│      } |",
  "|-185│ →  → s.ledger.started(created.Workspace.WorkspaceID, paneID, kind, label, strings.TrimSpace(request.TaskID)) |",
  "|   +│ →  → s.ledger.started(created.Workspace.WorkspaceID, paneID, kind, label, sharedTaskID(request, paneID)) |",
  "|+186│ →  → taskID := sharedTaskID(request, paneID) |",
  "|+187│ →  → if err := s.startSharedTask(ctx, request, taskID, label); err != nil { |",
  "|+188│ →  →  → fmt.Fprintf(os.Stderr, \"herdr-web: shared task %s: %v\\n\", taskID, err) |",
  "|+189│ →  → } |",
  "| 186│      writeJSON(w, http.StatusOK, jobStarted{ |",
  "| 187│         OK:          true, |",
  "| 189│         WorkspaceID: created.Workspace.WorkspaceID, |",
  "| 190│         PaneID:      paneID, |",
  "|-191│·········TaskID:      strings.TrimSpace(request.TaskID), |",
  "|+195│·········TaskID:      taskID, |",
  "| 192│         Branch:      strings.TrimSpace(request.Branch), |",
  "| 193│      }) |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_GAP: readonly string[] = [
  "",
];
const CUT_EDIT_B: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+6/-2] -----------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "|  89│   if r.Method != http.MethodPost { |",
  "|… |",
  "| 213│   if err := s.client().Call(ctx, \"agent.prompt\", |",
  "| 214│      map[string]any{\"target\": paneID, \"text\": request.Prompt}, nil); err != nil { |",
  "|… |",
  "| 217│   } |",
  "| 218│ |",
  "|-219│ → s.ledger.started(created.Workspace.WorkspaceID, paneID, request.Kind, label, strings.TrimSpace(request.TaskID)) |",
  "|   +│ → s.ledger.started(created.Workspace.WorkspaceID, paneID, request.Kind, label, sharedTaskID(request, paneID)) |",
  "|+220│ → taskID := sharedTaskID(request, paneID) |",
  "|+221│ → if err := s.startSharedTask(ctx, request, taskID, label); err != nil { |",
  "|+222│ →  → fmt.Fprintf(os.Stderr, \"herdr-web: shared task %s: %v\\n\", taskID, err) |",
  "|+223│ → } |",
  "| 220│   writeJSON(w, http.StatusOK, jobStarted{ |",
  "| 221│      OK:          true, |",
  "| 223│      WorkspaceID: created.Workspace.WorkspaceID, |",
  "| 224│      PaneID:      paneID, |",
  "|-225│······TaskID:      strings.TrimSpace(request.TaskID), |",
  "|+229│······TaskID:      taskID, |",
  "| 226│      Branch:      strings.TrimSpace(request.Branch), |",
  "| 227│   }) |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_PROSE_B: readonly string[] = [
  "",
  " The zerostack branch has s.ledger.started(..., sharedTaskID(request, paneID)) then taskID := ...; fine. The user; the spec; the user. The user; the spec; the user. Stop.",
  "",
  " Now modify handleJobStatus:",
  " - After the status computed, before writeJSON:...",
  " - The event.WorkspaceID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The s.ledger.stopped; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The attestSharedTask; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The taskID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The status done/error; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Edit. The user; the spec; the user. The user; the spec; the user. Stop.",
  "",
];
const CUT_EDIT_EDGE: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+11] -------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "| 501│   if commandJob { |",
  "|… |",
  "| 511│   } else if statusErr != nil && read.Text == \"\" { |",
  "|… |",
  "| 514│   } else if status == \"\" { |",
  "| 515│      status = \"unknown\" |",
  "| 516│   } |",
  "|+517│ → if isJob && (status == \"done\" || status == \"error\") { |",
  "|+518│ →  → taskID := event.TaskID |",
  "|+519│ →  → if taskID == \"\" { |",
  "|+520│ →  →  → taskID = sharedTaskID(jobRequest{}, paneID) |",
  "|+521│ →  → } |",
  "|+522│ →  → if err := s.attestSharedTask(ctx, taskID); err != nil { |",
  "|+523│ →  →  → fmt.Fprintf(os.Stderr, \"herdr-web: attest shared task %s: %v\\n\", taskID, err) |",
  "|+524│ →  → } |",
  "|+525│ →  → // Completion releases the execution slot; the workspace/result stays. |",
  "|+526│ →  → s.ledger.stopped(event.WorkspaceID) |",
  "|+527│ → } |",
  "| 517│   writeJSON(w, http.StatusOK, map[string]any{ |",
  "| 518│      \"ok\":     true, |",
  "|… |",
  "| 523│   }) |",
];

function cutBoxSnapshot(): string {
  return snapshot([
    ...CUT_BOX.map(band),
    ...CUT_PROSE_A,
    ...CUT_EDIT_A.map(band),
    ...CUT_GAP,
    ...CUT_EDIT_B.map(band),
    ...CUT_PROSE_B,
    ...CUT_EDIT_EDGE.map(band),
  ]);
}


test("a box body cut off by the window top is work, not a user turn", () => {
  const conversation = deriveConversation(cutBoxSnapshot());
  assert.equal(conversation.turns.filter((turn) => turn.user !== null).length, 0);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  const rows = conversation.turns[0].work;
  assert.ok(rows.length >= 3, `expected work rows, saw ${rows.length}`);
  assert.equal(rows[0].kind, "other");
  assert.equal(rows[0].title, "Earlier output");
  assert.equal(rows[0].detail.length, 31);
  assert.equal(rows[0].detail[0], '+316│ →  → return "local"');
  assert.ok(!conversation.turns[0].answer.includes("|+316│"));
});

test("rows of a box with no visible opener extend the previous work row", () => {
  const conversation = deriveConversation(
    snapshot([
      ink("✓ Read lines 1-9 in ./server/a.go"),
      band("|  1│ package a"),
      band("|  2│ func x() {}"),
    ]),
  );
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].work.length, 1);
  assert.deepEqual(conversation.turns[0].work[0].detail, [" 1│ package a", " 2│ func x() {}"]);
});

test("a background-filled box rule is never a user turn", () => {
  const rule = `+${"-".repeat(40)}+`;
  const conversation = deriveConversation(snapshot([band(rule), band("| tail of a box")]));
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].work[0].kind, "other");
  assert.equal(conversation.turns[0].work[0].title, "Earlier output");
});

test("a unicode border and a diff gutter are box body too", () => {
  const conversation = deriveConversation(
    snapshot([band("│ ╎ body"), band("|+12│ diff row"), band("| -3│ removed")]),
  );
  assert.equal(conversation.turns.filter((turn) => turn.user !== null).length, 0);
  assert.equal(conversation.turns[0].work[0].detail.length, 3);
});

/* ---------------------------------------------------------------- recap */

test("a recap keeps the rows it wraps onto", () => {
  // omp wraps `※ recap:` at the pane width; half a sentence is not a recap.
  const conversation = deriveConversation(
    snapshot([
      ink("改完了。"),
      dim("※ recap: Goal is zerostack support; the shared ledger, pipeline roles,"),
      dim("merge queue, and orchestrator are committed and tested."),
    ]),
  );
  const turn = conversation.turns[0];
  assert.equal(
    turn.recap,
    "Goal is zerostack support; the shared ledger, pipeline roles, merge queue, and orchestrator are committed and tested.",
  );
  assert.equal(turn.answer, "改完了。");
  assert.deepEqual(turn.thoughts, []);
});

test("a recap stops at prose that follows it", () => {
  const conversation = deriveConversation(
    snapshot([dim("※ recap: 文档已同步"), ink("下一条消息。")]),
  );
  const turn = conversation.turns[0];
  assert.equal(turn.recap, "文档已同步");
  assert.equal(turn.answer, "下一条消息。");
});

/* ---------------------------------------------------------------- status */

test("a blocked agent is called blocked, not running", () => {
  // "running" next to a parked prompt reads as a stall that never ends.
  assert.equal(statusWord("blocked"), "blocked");
  assert.equal(statusWord("working"), "running");
  assert.equal(statusWord("idle"), "idle");
  assert.equal(statusWord("done"), "done");
});

test("a status nobody reported is called unknown", () => {
  assert.equal(statusWord(null), "unknown");
  assert.equal(statusWord(""), "unknown");
});

/**
 * A fenced block is copied and folded by the chat renderer, so its inner
 * indentation has to survive: every other prose row is trimmed, which would
 * flatten a Python or YAML block into a left margin.
 */
test("a fenced code block keeps its indentation", () => {
  const text = snapshot([
    band(" ❯ paste the config"),
    ink("Here it is:"),
    ink("```yaml"),
    ink("server:"),
    ink("  port: 5001"),
    ink("  hosts:"),
    ink("    - 127.0.0.1"),
    ink("```"),
    ink("And the python one:"),
    ink("```python"),
    ink("def ship(job):"),
    ink("    if job is None:"),
    ink("        return 0"),
    ink("```"),
  ]);
  const conversation = deriveConversation(text);
  const turn = conversation.turns[0];
  assert.match(turn.answer, /\n  port: 5001\n/);
  assert.match(turn.answer, /\n    - 127\.0\.0\.1\n/);
  assert.match(turn.answer, /\n    if job is None:\n/);
  assert.match(turn.answer, /\n        return 0/);
});

test("prose around a fence is still trimmed", () => {
  const text = snapshot([
    band(" ❯ hi"),
    ink("    a deeply indented paragraph"),
    ink("```"),
    ink("  code"),
    ink("```"),
  ]);
  const turn = deriveConversation(text).turns[0];
  assert.match(turn.answer, /^a deeply indented paragraph/m);
  assert.match(turn.answer, /\n  code/);
});

/*
 * Antigravity CLI opens every `pane.read` window on a five-row splash: the
 * half-block logo with the version, the account, the model and the cwd beside
 * it, then `> what was submitted` in bold accent ink. The splash used to be the
 * first paragraph of the answer, and the question itself vanished because the
 * client fills no band for it.
 */
test("the antigravity splash is not prose and its caret echo opens the turn", () => {
  const text = snapshot([
    "",
    agySplash("▄▀▀▄", "Antigravity CLI 1.4.7"),
    agySplash("▀▀▀▀▀▀", "gouki.xiao@gmail.com (Google AI Pro)"),
    agySplash("▀▀▀▀▀▀▀▀", "Gemini 3.8 Flash (High)"),
    agySplash("▄▀▀    ▀▀▄", "~/server/herdr-web"),
    agySplash("▄▀▀      ▀▀▄", ""),
    "",
    grey(AGY_RULE),
    agyEcho("安装 https://github.com/DietrichGebert/ponytail"),
    "",
    grey("▸ Thought for 20s, 2.4k tokens"),
    grey("  Reviewed the plugin directory and its rule loading."),
    ink("已成功安装 ponytail。"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "安装 https://github.com/DietrichGebert/ponytail");
  assert.equal(turn.answer.trim(), "已成功安装 ponytail。");
  assert.equal(turn.answer.includes("Antigravity"), false);
  assert.equal(turn.answer.includes("Google AI Pro"), false);
  // The wrapped rows under the timing row are the thought, not the answer.
  assert.equal(turn.thoughts.length, 1);
  assert.match(turn.thoughts[0], /Reviewed the plugin directory/);
});

test("a second caret echo mid-transcript opens its own turn", () => {
  const text = snapshot([
    agySplash("▄▀▀▄", "Antigravity CLI 1.4.2"),
    grey(AGY_RULE),
    agyEcho("第一个问题"),
    ink("第一个回答。"),
    "",
    grey(AGY_RULE),
    agyEcho("第二个问题"),
    ink("第二个回答。"),
  ]);
  const turns = deriveConversation(text).turns;
  assert.deepEqual(
    turns.map((turn) => turn.user),
    ["第一个问题", "第二个问题"],
  );
});

test("half-block art that names no client stays in the answer", () => {
  const text = snapshot([
    ink("看一下这个进度条："),
    grey("▄▀▀▀▀      ▀▀▄▄"),
    ink("过了三分之一。"),
    ink("> 这是引用，不是回显"),
  ]);
  const conversation = deriveConversation(text);
  const turn = conversation.turns[0];
  assert.equal(turn.user, null);
  assert.match(turn.answer, /▄▀▀▀▀      ▀▀▄▄/);
  assert.match(turn.answer, /^> 这是引用，不是回显$/m);
});

test("a bold caret row inside a fence is shell, not a prompt echo", () => {
  const text = snapshot([
    agySplash("▄▀▀▄", "Antigravity CLI 1.4.7"),
    grey(AGY_RULE),
    agyEcho("把输出存到文件里"),
    ink("```sh"),
    `${ESC}1m> out.txt${RESET}`,
    ink("```"),
  ]);
  const turn = deriveConversation(text).turns[0];
  assert.equal(turn.user, "把输出存到文件里");
  assert.match(turn.answer, /^> out\.txt$/m);
});

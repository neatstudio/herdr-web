import assert from "node:assert/strict";
import test from "node:test";

import { proseWidth, reflowProse } from "./prose.ts";

/*
 * The fixtures are the shape a TUI hands over, not a live pane: a paragraph
 * cut mid-word at the wrap column, and a paragraph that ended on its own row
 * with no blank row after it. The text is written here so a width change in a
 * pane on this machine cannot move a test.
 */

test("a wrap inside a Chinese word is put back without a space", () => {
  const rows = ["前端静态检查已通过，后端不改动用户侧业务，避免破坏既有功", "能测试。"];
  assert.equal(reflowProse(rows.join("\n")), "前端静态检查已通过，后端不改动用户侧业务，避免破坏既有功能测试。");
});

test("a wrap between Latin words keeps the space", () => {
  const rows = ["the renderer decides the split point from the", "measured width of the lane."];
  assert.equal(reflowProse(rows.join("\n")), "the renderer decides the split point from the measured width of the lane.");
});

test("Latin next to Chinese keeps the space the language wants", () => {
  const rows = ["这里调用", "API 完成一轮渲染。"];
  assert.equal(reflowProse(rows.join("\n")), "这里调用 API 完成一轮渲染。");
  assert.equal(reflowProse(["the type check covers", "类型检查。"].join("\n")), "the type check covers 类型检查。");
});

test("full-width punctuation never gains a space beside it", () => {
  // A lead-in colon at the wrap column is still a wrap, so the two rows join
  // and the join must not leave a space between the colon and the token.
  assert.equal(
    reflowProse(["x".repeat(70) + "：", "go vet ./... 均无报错。"].join("\n")),
    "x".repeat(70) + "：go vet ./... 均无报错。",
  );
  assert.equal(reflowProse(["go vet ./...", "、前端类型检查均通过。"].join("\n")), "go vet ./...、前端类型检查均通过。");
});

test("a heading the terminal left without a blank row is its own paragraph", () => {
  const wrapRow = "这一行占满了终端的换行列，所以它不是这一段话的结尾，评审还发现几处风险只限于这次改动的范围。";
  const rows = [wrapRow, "项目深度评审结论", "", "建议先处理安全边界。"];
  assert.equal(reflowProse(rows.join("\n")), [wrapRow, "", "项目深度评审结论", "", "建议先处理安全边界。"].join("\n"));
});

test("a path split by the wrap loses neither half nor gains a space", () => {
  const rows = ["证据在 server.go:1780-1794 (file:///", "Users/gouki/server/ide/internal/server/server.go) 这一行。"];
  assert.ok(reflowProse(rows.join("\n")).includes("(file:///Users/gouki/"));
});

test("an ASCII full stop does not end a paragraph on its own", () => {
  // English wraps land on a period often enough that treating it as a
  // paragraph would split one paragraph into many.
  const rows = ["The renderer is done.", "The next sentence continues the idea."];
  assert.equal(reflowProse(rows.join("\n")), "The renderer is done. The next sentence continues the idea.");
});

test("a Chinese sentence that stopped short of the wrap column ends a paragraph", () => {
  // devin prints one paragraph per row; without the gap, ten of them run
  // together into a single wall on a phone.
  const rows = ["项目深度评审结论：", "先说最要紧的一条。", "下面按优先级排。"];
  assert.equal(reflowProse(rows.join("\n")), "项目深度评审结论：\n\n先说最要紧的一条。\n\n下面按优先级排。");
});

test("a Chinese sentence that ended at the wrap column is a wrap, not a paragraph", () => {
  // A row that filled its columns ran out of room: the sentence happened to
  // end there, the paragraph did not.
  const filler = "建议先处理安全边界，再继续发布当前改动，因为旧配置升级会覆盖用户明确关闭的选择。";
  const rows = [filler + "再补一句。", "第二段从这里开始。"];
  assert.ok(proseWidth(rows[0]) > 72, "fixture has to be wider than the floor");
  const out = reflowProse(rows.join("\n"));
  assert.equal(out, `${rows[0]}第二段从这里开始。`);
  assert.equal(out.split("\n\n").length, 1);
});

test("a space the model left before a full-width mark is not a word gap", () => {
  const rows = "静态检查已通过： go vet ./... 、前端 TypeScript ；该路径调用  RemoveAll 。";
  assert.equal(reflowProse(rows), "静态检查已通过：go vet ./...、前端 TypeScript；该路径调用  RemoveAll。");
});

test("a space between a Chinese word and an inline code span stays", () => {
  const rows = "项目没有 `.env.test` ，按约定不跑功能测试。";
  assert.equal(reflowProse(rows), "项目没有 `.env.test`，按约定不跑功能测试。");
});

test("a fenced or drawn row keeps the spaces beside full-width marks", () => {
  const rows = ["```", "echo 完成 。", "```", "│ 完成 。 │"];
  assert.equal(reflowProse(rows.join("\n")), rows.join("\n"));
});

test("a numbered item quoting the model keeps the gap its marker needs", () => {
  // `4. “…”` is a list item only while the space after `4.` survives; tidying it
  // away folds the item into the row above and Markdown stops numbering it.
  const rows = ["   3. 跨项目仓库归属校验不完整。", "   4. “合并并拉取本地”无法更新默认分支。"];
  assert.equal(reflowProse(rows.join("\n")), rows.join("\n"));
});

test("trailing spaces are a hard break, not a word gap", () => {
  // Two trailing spaces are how Markdown keeps a row break inside a paragraph,
  // so only the gap before the mark goes and the row still ends in two spaces.
  assert.equal(reflowProse("第一行 。  "), "第一行。  ");
});

test("blank rows stay blank and are never joined across", () => {
  const rows = ["第一段。", "", "第二段。"];
  assert.equal(reflowProse(rows.join("\n")), "第一段。\n\n第二段。");
});

test("list items, headings, quotes and rules keep their own line", () => {
  const rows = ["- 第一条", "- 第二条", "1. 有编号", "> 引用", "# 标题", "---", "正文。"];
  assert.equal(reflowProse(rows.join("\n")), rows.join("\n"));
});

test("a drawn table or diagram is never reflowed", () => {
  const rows = ["│ 大文件 │ server.go 2222 行 │", "│ 迭代快 │ 7 天 71 次提交   │", "├───────┼──────────────────┤"];
  assert.equal(reflowProse(rows.join("\n")), rows.join("\n"));
});

test("a fenced block is left byte for byte, including its wrap", () => {
  const rows = ["说明：", "```go", "func main() {", "\tfmt.Println(1)", "}", "```", "结尾。"];
  const out = reflowProse(rows.join("\n"));
  assert.ok(out.includes("```go\nfunc main() {\n\tfmt.Println(1)\n}\n```"));
  assert.equal(out.split("```").length, 3);
});

test("reflowing twice changes nothing", () => {
  const rows = [
    "项目深度评审结论",
    "本次只看了一个仓库，避免了破坏既有功",
    "能测试。",
    "下面是高优先级。",
    "- 第一条建议",
    "- 第二条建议",
  ].join("\n");
  const once = reflowProse(rows);
  assert.equal(reflowProse(once), once);
});

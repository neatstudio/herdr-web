import { expect, test, type Page } from "@playwright/test";

/*
 * A table the agent drew is not a diagram.
 *
 * Devin answers with box-drawing tables — `┌─┬─┐` on top, `│ cells │` per row —
 * and `Markdown` keeps anything drawn verbatim in a `<pre>`, which is right for
 * a tree and wrong for a table. On a phone one live answer measured 1464px of
 * `<pre>` inside a 366px lane: four fifths of every row was behind a sideways
 * swipe and no column name stayed in view. The table is now laid out as cells,
 * stacked into one card per row below 560px.
 *
 * The fixture is synthetic — the shape of a devin answer, text written for this
 * test. A raw live pane is not something to commit, and a client that truncates
 * a cell to the pane width is not the shape to pin.
 */

const READ = [
  "> 评估一下这个仓库，要不要拆",
  "下面是三个主要问题。",
  "┌────────┬──────────────┬──────────────┐",
  "│ 问题   │ 证据         │ 建议         │",
  "├────────┼──────────────┼──────────────┤",
  "│ 大文件 │ server.go    │ 按职责拆分。 │",
  "│        │ 2222 行      │ 可以拆成     │",
  "│        │              │ 4 个文件     │",
  "├────────┼──────────────┼──────────────┤",
  "│ 迭代快 │ 7 天 71 次   │ 留一天修 Bug │",
  "└────────┴──────────────┴──────────────┘",
  "先拆这两个模块。",
  "",
].join("\n");

async function installBridge(page: Page): Promise<void> {
  const pane = {
    id: "w2:p1",
    workspaceId: "w2",
    tabId: "w2:t1",
    focused: true,
    cwd: "/tmp/api",
    agentStatus: "idle",
    terminalTitle: "shell",
  };
  const workspace = {
    id: "w2",
    name: "api",
    windows: 1,
    attached: true,
    paneCount: 1,
    agentStatus: "idle",
  };
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/herdr/*", (route) => route.fulfill(json({})));
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill(
      json({
        enabled: true,
        socket: "/Users/op/.config/herdr/herdr.sock",
        status: "ok",
        version: "0.9.0",
        protocol: 22,
        protocolTested: true,
      }),
    ),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) => route.fulfill(json([workspace])));
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill(json({ workspace, panes: [pane] })),
  );
  await page.route("**/api/v1/herdr/panes", (route) => route.fulfill(json({ panes: [pane] })));
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill(
      json({
        paneId: pane.id,
        source: "recent",
        format: "ansi",
        text: READ,
        revision: 2,
        truncated: false,
        agentStatus: "idle",
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) => route.fulfill(json({ ok: true })));
  await page.route("**/api/v1/herdr/panes/*/input", (route) => route.fulfill(json({ ok: true })));
  await page.addInitScript(() => {
    window.localStorage.setItem("herdr:lens:w2:p1", "chat");
  });
}

/** True when the document itself can be dragged sideways. */
const pageScrollsSideways = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );

test.describe("a drawn table on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("rows stack into cards with the column name above each cell", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const table = page.locator(".chat__table");
    await expect(table).toHaveCount(1);
    // The header row is folded into the cells, so it is not drawn twice.
    await expect(page.locator(".chat__table thead")).toBeHidden();
    await expect(page.locator(".chat__table tbody tr")).toHaveCount(2);

    // A wrapped cell was re-joined, and it is fully readable without a swipe.
    await expect(page.locator('.chat__table td[data-label="证据"]').first()).toContainText(
      "server.go 2222 行",
    );
    await expect(page.locator(".chat__table")).toContainText("留一天修 Bug");
    await expect(page.locator(".chat__table")).toContainText("大文件");

    // Nothing was left behind as verbatim art, and the page does not scroll.
    await expect(page.locator(".chat__pre")).toHaveCount(0);
    expect(await pageScrollsSideways(page)).toBe(false);

    // The prose around the table still reads as prose.
    const prose = await page
      .locator(".chat__prose")
      .first()
      .innerText();
    expect(prose).toContain("下面是三个主要问题。");
    expect(prose).toContain("先拆这两个模块。");
  });
});

test.describe("a drawn table in a narrow frame", () => {
  test.use({ viewport: { width: 719, height: 844 }, hasTouch: false, isMobile: false });

  test("it is a real table with its header row in view", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const table = page.locator(".chat__table");
    await expect(table).toHaveCount(1);
    await expect(page.locator(".chat__table thead")).toBeVisible();
    await expect(page.locator(".chat__table th")).toHaveCount(3);
    await expect(page.locator(".chat__table th").nth(1)).toHaveText("证据");
    await expect(page.locator(".chat__table tbody tr")).toHaveCount(2);
    await expect(page.locator(".chat__table thead")).toContainText("问题");
    await expect(page.locator(".chat__table thead")).toContainText("建议");

    await expect(page.locator(".chat__pre")).toHaveCount(0);
    expect(await pageScrollsSideways(page)).toBe(false);
  });
});

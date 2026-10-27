import { expect, test, type Page } from "@playwright/test";

/*
 * An agent writes prose for its own terminal, and the terminal counts columns.
 *
 * devin wraps at 200 columns and cuts mid-word, so a Chinese sentence arrives
 * as `…避免破坏既有功` + `能测试。` and Markdown re-joins the two rows with a
 * space — inside a word: `功 能`. It also prints one paragraph per row without
 * a blank row after it, so ten of them ran together into one 3 000 px wall on a
 * 390px screen.
 *
 * The fixture is synthetic: the client's shape, text written for this test. A
 * raw live pane is not something to commit.
 */

const READ = [
  "\u001b[48;2;42;42;42m❭ 评审一下这个仓库\u001b[0m",
  " 先说结论。",
  " 本次只看了一个仓库，避免了破坏既有功",
  " 能测试。",
  "",
  " The renderer decides the split point from",
  " the measured width of the lane.",
  "",
  " 高优先级",
  " ```go",
  " func main() {",
  "     fmt.Println(1)",
  " }",
  " ```",
  " - 第一条建议",
  " - 第二条建议",
  "---EOF--",
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

/** Every line the transcript claims the agent wrote, one per paragraph. */
const linesOf = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".chat__prose"))
      .map((node) => node.innerText)
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

test.describe("phone transcript of an answer wrapped by a terminal", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a word cut by the wrap is put back together", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const lines = await linesOf(page);
    // The wrap is gone: one whole sentence on one line, no space inside 功能.
    expect(lines).toContain("本次只看了一个仓库，避免了破坏既有功能测试。");
    expect(lines.join("\n")).not.toMatch(/功\s+能/);
  });

  test("a Latin wrap keeps its space and a Chinese sentence still ends a paragraph", async ({
    page,
  }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const lines = await linesOf(page);
    expect(lines).toContain("The renderer decides the split point from the measured width of the lane.");
    // The sentence that stopped short of the wrap column was a paragraph end.
    expect(lines).toContain("先说结论。");
    expect(lines).toContain("高优先级");
  });

  test("a code block keeps the line breaks it was written with", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const body = await page.locator(".chat__code-body").innerText();
    expect(body).toContain("func main() {");
    expect(body.split("\n").length).toBe(3);
  });

  test("list items stay one item per row", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    await expect(page.locator(".markdown__list li")).toHaveCount(2);
    await expect(page.locator(".markdown__list li").first()).toHaveText("第一条建议");
  });
});

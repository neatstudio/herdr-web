import { expect, test, type Page } from "@playwright/test";

/*
 * Client furniture that used to arrive as the agent's own words.
 *
 * A visible snapshot ends at the input box, so its last rows are the client's
 * chrome, not prose. Gemini (`agy`) is the worst case because it paints its
 * reasoning in upright grey — `▸ Thought for 5s, 184 tokens` — which is not
 * italic, so the styling test in `web/src/lib/conversation.ts` calls it answer
 * prose. The transcript then ended with three lies at once: the agent quoting
 * its own timing line, an empty blockquote from the bare `>` caret, and
 * "? for shortcuts" as the final sentence of the answer.
 *
 * The fixture below is synthetic — shapes copied from the client, text written
 * for this test, because a raw live pane is not something to commit.
 */

const READ = [
  "\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580  Gemini 3.8 Flash (High)",
  "○ Thought for 32.3s (working out the rules)",
  "▸ Thought for 5s, 184 tokens",
  "● Ran 7 commands (2.1s)",
  "> 安装 ponytail",
  "已成功安装 ponytail。",
  "────────────────────────────────",
  ">",
  "────────────────────────────────",
  "? for shortcuts                  Gemini 3.8 Flash · high",
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

/** Every paragraph the transcript claims the agent wrote. */
const proseOf = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".chat__prose"))
      .map((node) => node.innerText)
      .join("\n"),
  );

test.describe("phone transcript against an input box at the bottom", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the input box's last rows are not the agent's words", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const prose = await proseOf(page);
    // The answer is there…
    expect(prose).toContain("已成功安装 ponytail。");
    // …and the three rows under it are not.
    expect(prose).not.toContain("for shortcuts");
    expect(prose).not.toContain("Gemini 3.8 Flash · high");
    expect(prose).not.toMatch(/Thought for \d/);

    // The quoted prompt is prose (a `>` with words after it), the bare caret is
    // not: exactly one blockquote survives, and it is the one with the command.
    await expect(page.locator(".markdown__quote")).toHaveCount(1);
    await expect(page.locator(".markdown__quote")).toContainText("安装 ponytail");
  });

  test("reasoning the agent only marked, never styled, still folds", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".work__head")).toHaveCount(1);

    // Nothing may be hidden without a trace: the timing rows are in the fold,
    // one level down, under their own row.
    await expect(page.locator(".work__detail-body")).toHaveCount(0);
    await page.locator(".work__head").click();
    await page.locator('.work__row[data-kind="thought"] > button').click();
    await expect(page.locator(".work__detail-body")).toContainText("Thought for 32.3s");
    await expect(page.locator(".work__detail-body")).toContainText("Thought for 5s, 184 tokens");
  });
});

test.describe("narrow desktop frame", () => {
  test.use({ viewport: { width: 700, height: 800 }, hasTouch: false, isMobile: false });

  test("the same chrome is dropped when the frame is a small desktop window", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const prose = await proseOf(page);
    expect(prose).toContain("已成功安装 ponytail。");
    expect(prose).not.toContain("for shortcuts");
  });
});

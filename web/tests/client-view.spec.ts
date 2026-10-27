import { expect, test, type Page } from "@playwright/test";

/*
 * `/usage` is answered by the client, not by the model: devin prints a label
 * column and a value column.
 *
 * Re-flowed as prose the rows join into one run-on paragraph — `Model Claude
 * Opus 5.5 Medium` ending up right after the token count — so the numbers lose
 * the labels that explain them. The panel is drawn verbatim instead, and it
 * wraps rather than scrolls: on a 390px lane the weekly row is twice the width
 * available, and the reset time is the whole reason the operator asked.
 */

const USAGE = [
  "\u001b[48;2;42;42;42m❭ /usage\u001b[0m",
  "",
  " Daily   ■■■■■■■■■■■■■■■■■■■■  100% used  · resets in 8h 42m",
  " Weekly  ■■■■■■■■■■■■■■■■■■■■  50% used  · resets Oct 25, 8:00 AM (UTC)",
  "",
  " This session",
  " Activity  2 turns · 41 tool calls · 0 files · 19 commands",
  " Tokens    254k in · 5.1k out  (~129k per turn)",
  " Model     Claude Opus 5.5 Medium",
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
        text: USAGE,
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

test.describe("the account panel a client prints for /usage", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("keeps its rows and its columns", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(1);

    const panel = page.locator(".chat__pre--flow");
    await expect(panel).toHaveCount(1);
    const rows = (await panel.innerText()).split("\n");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain("Daily");
    expect(rows[0]).toContain("100% used");
    expect(rows[1]).toContain("Weekly");
    expect(rows[6]).toMatch(/^Model\s+Claude Opus 5\.5 Medium$/);
    // The rows did not run together into a paragraph.
    expect(rows.join("\n")).not.toContain("Medium Activity");
  });

  test("the wide row wraps instead of scrolling its reset time away", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__pre--flow")).toHaveCount(1);

    const box = await page.locator(".chat__pre--flow").evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      whiteSpace: getComputedStyle(node).whiteSpace,
    }));
    expect(box.whiteSpace).toBe("pre-wrap");
    // Nothing is hidden behind a horizontal scroll: the row folded instead.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    await expect(page.locator(".chat__pre--flow")).toContainText("resets Oct 25, 8:00 AM (UTC)");
  });
});

import { expect, test, type Page } from "@playwright/test";

/*
 * The way back to the newest turn floats over the transcript, because there is
 * nowhere else for it to live: the lane is the only thing that scrolls.
 *
 * As `latest ↓` it was 97×44 on a 390px phone — a quarter of the 366px text
 * column sitting on the prose the operator had just scrolled back to read, and
 * the word only repeated what a `↓` in the corner already says. The pill is now
 * an arrow in a 44px circle wherever the lane is phone-width or the pointer is
 * coarse, and keeps its label where a gutter is wide enough to hold it. The tap
 * target does not shrink with the label.
 *
 * The fixture is synthetic — the client's prompt band and one answer per turn,
 * written for this test, repeated until the transcript is taller than the
 * frame. A raw live pane is not something to commit.
 */

const TURNS = 8;

const READ = [
  ...Array.from({ length: TURNS }, (_, index) => [
    `\u001b[48;2;42;42;42m❭ 第 ${index + 1} 个问题\u001b[0m`,
    "",
    ` 这是第 ${index + 1} 段的回答。这一段故意写得长一些，好让转录比一屏更高，`,
    " 滚动条才有东西可以滚，回到底部的按钮也才需要出现。",
    "",
  ]).flat(),
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

/** Scroll the lane back far enough that the polling rides along, not the view. */
async function scrollBack(page: Page): Promise<void> {
  await page.locator(".chat__lane").evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 480);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

const laneScroll = (page: Page) =>
  page.locator(".chat__lane").evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
  }));

test.describe("the way back to the newest turn on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("is an arrow the size of a thumb, not a 97px word", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(TURNS);

    // The transcript opens at the bottom, so there is nowhere to jump from.
    await expect(page.locator(".chat__jump")).toHaveCount(0);

    await scrollBack(page);
    const pill = page.getByRole("button", { name: "jump to the latest turn" });
    await expect(pill).toBeVisible();

    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    // 44×44: the label went, the touch target stayed.
    expect(Math.round(box!.width)).toBe(44);
    expect(Math.round(box!.height)).toBe(44);
    await expect(page.locator(".chat__jump-word")).toBeHidden();
    // It still has a name for a screen reader, since the glyph cannot.
    await expect(pill).toHaveAttribute("aria-label", "jump to the latest turn");
  });

  test("tapping it returns to the bottom and takes the arrow with it", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(TURNS);
    await scrollBack(page);

    const before = await laneScroll(page);
    expect(before.max - before.top).toBeGreaterThan(200);

    const pill = page.getByRole("button", { name: "jump to the latest turn" });
    await pill.tap();
    await expect(pill).toHaveCount(0);
    const after = await laneScroll(page);
    expect(after.max - after.top).toBeLessThan(48);
  });
});

test.describe("the way back to the newest turn with room to spare", () => {
  // 700px wide keeps the chat lens mounted on its own (the frame splits at 720)
  // and leaves a gutter beside the 676px lane for a label to sit in.
  test.use({ viewport: { width: 700, height: 900 } });

  test("keeps the word where there is a gutter for it", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__turn")).toHaveCount(TURNS);
    await scrollBack(page);

    const pill = page.getByRole("button", { name: "jump to the latest turn" });
    await expect(pill).toBeVisible();
    await expect(page.locator(".chat__jump-word")).toBeVisible();
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    // Wider than the bare circle: the word is painted.
    expect(box!.width).toBeGreaterThan(44);
    expect(Math.round(box!.height)).toBe(44);
  });
});

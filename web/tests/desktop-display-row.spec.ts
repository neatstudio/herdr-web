import { expect, test, type Page } from "@playwright/test";

/*
 * Where the AUTO/WRAP/EXACT/FIT switch sits on a wide pointer.
 *
 * It used to float 6px from the tile's top-right corner at 35% opacity, over a
 * transcript that is always tail-followed. The result was measurable on a
 * 1280x800 window: the bar covered y 142..162 while the first visible line
 * started at 148, so the faces read as part of the output and the line under
 * them showed through them. Reserving scroll padding does not fix it — an
 * `overflow: auto` box still paints its content inside the padding band once it
 * is scrolled — so the bar gets a real grid row instead, the way the narrow
 * frame already gives it one.
 *
 * These cases pin the two halves of that: on a fine pointer above 900px the bar
 * owns a row and no transcript line can share it; on a coarse 820px tablet the
 * documented full-width overlay (44px faces, 56px of scroll padding) is
 * unchanged. The transcript here is synthetic, not captured from a pane.
 */

const PANE = {
  id: "w2:p1",
  workspaceId: "w2",
  tabId: "w2:t1",
  focused: true,
  cwd: "/tmp/api",
  agentStatus: "idle",
  terminalTitle: "omp",
  agent: "omp",
  displayAgent: "omp",
};

const WORKSPACE = {
  id: "w2",
  name: "api",
  windows: 1,
  attached: true,
  paneCount: 1,
  agentStatus: "idle",
};

const LAYOUT = {
  tabId: "w2:t1",
  workspaceId: "w2",
  zoomed: false,
  area: { x: 0, y: 0, width: 200, height: 50 },
  focusedPaneId: "w2:p1",
  panes: [{ id: "w2:p1", focused: true, rect: { x: 0, y: 0, width: 200, height: 50 } }],
  splits: [],
};

/** 80 numbered lines, so the view has somewhere to scroll to. */
const TRANSCRIPT = Array.from(
  { length: 80 },
  (_, index) => `step ${String(index + 1).padStart(3, "0")}  a synthetic output line`,
).join("\n");

async function installBridge(page: Page): Promise<void> {
  await page.route("**/api/v1/herdr/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, status: "ok", version: "0.9.0", protocol: 22 }),
    }),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([WORKSPACE]),
    }),
  );
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspace: WORKSPACE, panes: [PANE] }),
    }),
  );
  await page.route("**/api/v1/herdr/panes", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ panes: [PANE] }),
    }),
  );
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        paneId: PANE.id,
        source: "recent",
        format: "ansi",
        text: TRANSCRIPT,
        revision: 2,
        truncated: false,
        agentStatus: "idle",
      }),
    }),
  );
  // The layout payload is not wrapped: the bridge writes the PaneLayout at the
  // top level, and parsePaneLayout reads it from there.
  await page.route("**/api/v1/herdr/panes/*/layout", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LAYOUT) }),
  );
  await page.route("**/api/v1/herdr/host/stat*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "/tmp", entries: [] }),
    }),
  );
}

/**
 * Transcript lines whose *visible* box overlaps the switch's box. A line's
 * layout rect keeps its place outside the scroll port — at the tail the first
 * entries sit at negative y — so measuring rects alone would report lines that
 * are clipped away. Clip to the scroll port first, the way the eye sees it.
 */
async function linesUnderTheSwitch(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar = document.querySelector(".scope__display");
    const scroll = document.querySelector(".scope__scroll");
    if (bar === null || scroll === null) throw new Error("the transcript is not on the page");
    const band = bar.getBoundingClientRect();
    const port = scroll.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".scope__line")).filter((line) => {
      const rect = line.getBoundingClientRect();
      const top = Math.max(rect.top, port.top);
      const bottom = Math.min(rect.bottom, port.bottom);
      return bottom > band.top + 0.5 && top < band.bottom - 0.5;
    }).length;
  });
}

test.describe("a window, a mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the layout switch keeps its own row above the transcript", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".scope__display")).toBeVisible();
    await expect(page.locator(".scope__line").first()).toBeVisible();

    const bar = await page.locator(".scope__display").boundingBox();
    const scroll = await page.locator(".scope__scroll").boundingBox();
    expect(bar).not.toBeNull();
    expect(scroll).not.toBeNull();

    // Its own row: the scroll box starts where the bar ends, so no line can sit
    // under it by construction, and the bar costs one line of height (24px).
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(scroll!.y + 0.5);
    expect(bar!.height).toBeLessThan(28);
    expect(scroll!.height).toBeGreaterThan(480);

    // In flow it no longer needs to be translucent to stay out of the way; a 35%
    // face over text was the garble, and hover never fixed a touchpad user.
    expect(await page.locator(".scope__display").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    // And nothing is hiding in the band: at the top, and tail-followed at the
    // bottom where the old padding-only reservation failed.
    expect(await linesUnderTheSwitch(page)).toBe(0);
    await page.locator(".scope__scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await linesUnderTheSwitch(page)).toBe(0);

    // Still the same control: clickable, keyboard reachable, pressed state live.
    await page.locator("#herdr-display-exact").click();
    await expect(page.locator(".scope__scroll")).toHaveAttribute("data-display", "exact");
    await expect(page.locator("#herdr-display-exact")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#herdr-display-auto")).toHaveAttribute("aria-pressed", "false");

    await page.locator("#herdr-display-fit").focus();
    await expect(page.locator("#herdr-display-fit")).toBeFocused();
  });
});

test.describe("a tablet, one finger", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });

  test("the full-width overlay and its reserved padding are untouched", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".scope__display")).toBeVisible();

    const bar = await page.locator(".scope__display").boundingBox();
    const scroll = await page.locator(".scope__scroll").boundingBox();
    expect(bar).not.toBeNull();
    expect(scroll).not.toBeNull();

    // Full width across the tile, four 44px faces: the documented touch layout.
    expect(bar!.width).toBeGreaterThanOrEqual(800);
    expect(bar!.height).toBeGreaterThanOrEqual(44);
    for (const mode of ["auto", "wrap", "exact", "fit"]) {
      const face = await page.locator(`#herdr-display-${mode}`).boundingBox();
      expect(face!.height).toBeGreaterThanOrEqual(44);
      expect(face!.width).toBeGreaterThanOrEqual(96);
    }

    // Overlay, not a row: the scroll box still starts at the tile top, level
    // with the bar, and pays for it in padding — the narrow-frame contract.
    expect(scroll!.y).toBeLessThanOrEqual(bar!.y + 0.5);
    const paddingTop = await page
      .locator(".scope__scroll")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop));
    expect(paddingTop).toBeGreaterThanOrEqual(bar!.height);

    // And the desktop row did not leak out at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(820);
  });
});

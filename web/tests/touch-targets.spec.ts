import { expect, test, type Page } from "@playwright/test";

/*
 * What a thumb can actually hit in the chrome.
 *
 * The masthead's daemon entry, the fleet entry and the phone's pane switch are
 * label-sized boxes: 20px tall, and 43px wide for the pane switch, on a screen
 * where the fingertip is ~9mm. They cannot look bigger — a 44px border around a
 * 10px label is a different design — so the smaller ones had their tap region
 * widened with a pseudo-element. That quietly did nothing: those controls carry
 * `overflow: hidden` (the cluster needs it for the daemon label's ellipsis, the
 * pane switch for a long workspace name), and a pseudo-element is clipped by
 * its own element, so a finger still landed on 20px of glass. The borderless
 * ones now grow their real box, which the 46px rows absorb for free.
 *
 * `elementFromPoint` is the measurement that matters: the box can say 44 while
 * a pointer at y+21 still hits something else. The last case is the failure
 * mode of a pseudo-element reach — over-reach that steals taps from the row
 * below — and the desktop case keeps the mouse layout honest.
 */

const PANE = {
  id: "w2:p1",
  workspaceId: "w2",
  tabId: "w2:t1",
  focused: true,
  cwd: "/tmp/api",
  agentStatus: "idle",
  terminalTitle: "shell",
};

const WORKSPACE = {
  id: "w2",
  name: "api",
  windows: 1,
  attached: true,
  paneCount: 1,
  agentStatus: "idle",
};

async function installBridge(page: Page): Promise<void> {
  await page.route("**/api/v1/herdr/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        socket: "/Users/op/.config/herdr/herdr.sock",
        status: "ok",
        version: "0.9.0",
        consoleVersion: "v0.3.1",
        protocol: 22,
        protocolTested: true,
      }),
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
        text: "ready\n",
        revision: 1,
        truncated: false,
        agentStatus: "idle",
      }),
    }),
  );
}

/**
 * How many vertical pixels around a control's centre still deliver a tap to it.
 * This is the number a fingertip experiences; the border box is not.
 */
async function reachY(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`${sel} is not on the page`);
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hits = (px: number, py: number) => {
      const at = document.elementFromPoint(px, py);
      return at !== null && (at === el || el.contains(at));
    };
    let up = 0;
    let down = 0;
    for (let d = 1; d < 80 && hits(x, y - d); d += 1) up = d;
    for (let d = 1; d < 80 && hits(x, y + d); d += 1) down = d;
    return up + down + 1;
  }, selector);
}

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return rect;
};

test.describe("a phone, one thumb", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every chrome control accepts a fingertip", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    // The three that were label boxes: daemon entry, fleet entry, pane switch.
    for (const selector of ["#herdr-host-open", "#herdr-fleet-open", "#herdr-picker-open"]) {
      expect(await reachY(page, selector), `${selector} reach`).toBeGreaterThanOrEqual(44);
    }

    // Two are borderless (transparent border, and `border: 0` in the head), so
    // the grown box must be the real one, not a skirt a parent can clip again.
    for (const selector of ["#herdr-host-open", "#herdr-fleet-open", "#herdr-picker-open"]) {
      expect((await box(page, selector)).height, `${selector} box`).toBeGreaterThanOrEqual(44);
    }

    // The drawn chip keeps its 22px box: it is a bordered control.
    expect((await box(page, "#herdr-theme-cycle")).height).toBeLessThan(30);
    expect(await reachY(page, "#herdr-theme-cycle")).toBeGreaterThanOrEqual(44);

    // Nothing above pays for the bigger targets: both rows are still 46px, and
    // the strip still starts exactly where the head ends.
    expect(Math.round((await box(page, ".masthead")).height)).toBe(46);
    expect(Math.round((await box(page, ".stage__head")).height)).toBe(46);
    expect(Math.round((await box(page, ".stage--lens > .strip")).y)).toBe(92);

    // And the row below is not stolen from: just under the head, a tap belongs
    // to the strip, not to the 44px control that ends 2px above it.
    const below = await page.evaluate(() => {
      const strip = document.querySelector(".stage--lens > .strip")!;
      const rect = strip.getBoundingClientRect();
      const at = document.elementFromPoint(rect.x + 40, rect.y + 4);
      return at !== null && strip.contains(at);
    });
    expect(below).toBe(true);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  });
});

test.describe("a desktop, a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the label-sized chrome", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    // Coarse-pointer rules must not follow a mouse: the 44px box would turn the
    // masthead's hover outline into a fence around a 10px word.
    expect((await box(page, "#herdr-host-open")).height).toBeLessThan(30);
    expect((await box(page, "#herdr-fleet-open")).height).toBeLessThan(30);
    expect(Math.round((await box(page, ".masthead")).height)).toBe(46);
    // The pane switch belongs to the phone head; the columns carry it here.
    await expect(page.locator("#herdr-picker-open")).toBeHidden();
  });
});

import { expect, test, type Page } from "@playwright/test";

/*
 * Where a palette lands once the soft keyboard is up.
 *
 * The `/` and `@` list floats above the composer and grows upward, capped at
 * 50vh on a touch screen. A phone keyboard is taller than that cap is short: on
 * a 320x568 phone with the keyboard up the card sits at y=234 and the cap was
 * 284px, so the list started at y=-57 and its first rows were painted above the
 * viewport — `overflow-y: auto` does not help there, because scrolling only
 * moves rows through the part of the box the screen can see, so the top matches
 * were unreachable. The card now publishes the room it has above itself and the
 * palette takes the smaller of that number and its own cap. These cases pin the
 * arithmetic, and the last one pins the refit when the keyboard opens while the
 * list is already on screen.
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
        status: "ok",
        version: "0.9.0",
        protocol: 22,
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

/** Raise the keyboard the way a phone reports it: a `--kb-inset` and a class. */
async function raiseKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((inset) => {
    document.documentElement.style.setProperty("--kb-inset", `${inset}px`);
    document.documentElement.classList.add("has-keyboard");
  }, px);
}

async function openPalette(page: Page): Promise<void> {
  // `click` works on both a thumb and a mouse; `tap` needs the touch context.
  await page.locator("#herdr-input").click();
  await page.keyboard.type("/");
  await expect(page.locator(".prompt__palette")).toBeVisible();
  // The card measures itself in an effect, so read it after a frame.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

type Layout = {
  palette: { top: number; bottom: number; height: number; scrollHeight: number; clientHeight: number };
  cardTop: number;
  firstTop: number;
  viewportHeight: number;
  overflowY: number;
};

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const palette = document.querySelector<HTMLElement>(".prompt__palette")!;
    const card = document.querySelector<HTMLElement>(".prompt")!;
    const first = document.querySelector<HTMLElement>(".prompt__opt")!;
    const rect = palette.getBoundingClientRect();
    return {
      palette: {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        scrollHeight: palette.scrollHeight,
        clientHeight: palette.clientHeight,
      },
      cardTop: Math.round(card.getBoundingClientRect().top),
      firstTop: Math.round(first.getBoundingClientRect().top),
      viewportHeight: window.innerHeight,
      overflowY: Math.round(rect.bottom - card.getBoundingClientRect().top),
    };
  });
}

test.describe("a palette above a phone keyboard", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  test("starts on screen instead of above it", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();
    await raiseKeyboard(page, 260);
    await openPalette(page);

    const seen = await layout(page);
    // The list hangs above the card, never above the top of the screen.
    expect(seen.palette.top, "palette top").toBeGreaterThanOrEqual(0);
    expect(seen.firstTop, "first match top").toBeGreaterThanOrEqual(0);
    expect(seen.palette.bottom).toBeLessThan(seen.cardTop);
    // Six 44px rows do not fit in the room left over, so the list must scroll:
    // the cap is a viewport, not a crop.
    expect(seen.palette.scrollHeight).toBeGreaterThan(seen.palette.clientHeight);
    // The rows it scrolls through all stay above the card.
    expect(seen.overflowY).toBeLessThanOrEqual(0);

    // The first match is reachable: the top of the list is at the top of the
    // screen, so scrolling back up brings it into view.
    const reachable = await page.evaluate(() => {
      const palette = document.querySelector<HTMLElement>(".prompt__palette")!;
      palette.scrollTop = 0;
      const first = document.querySelector<HTMLElement>(".prompt__opt")!;
      return Math.round(first.getBoundingClientRect().top);
    });
    expect(reachable).toBeGreaterThanOrEqual(0);
  });
});

test.describe("a palette on a sideways phone", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("keeps two rows of matches, still scrollable", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();
    await raiseKeyboard(page, 210);
    await openPalette(page);

    const seen = await layout(page);
    expect(seen.palette.top).toBeGreaterThanOrEqual(0);
    // 390 - 210 of keyboard = 180px of app, 106 of it the card above. 94 is all
    // that is left; two 44px rows and the gap above them.
    expect(seen.palette.height).toBeGreaterThanOrEqual(88);
    expect(seen.palette.height).toBeLessThanOrEqual(seen.cardTop);
    expect(seen.palette.scrollHeight).toBeGreaterThan(seen.palette.clientHeight);
    expect(seen.palette.bottom).toBeLessThan(seen.cardTop);
  });
});

test.describe("a keyboard raised under an open palette", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  test("pulls the list down with it", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();
    await openPalette(page);
    const before = await layout(page);
    expect(before.palette.top).toBeGreaterThan(0);

    // Opening the keyboard is a layout change, not a window resize: the card
    // watches the shell and re-measures.
    await raiseKeyboard(page, 260);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

    const after = await layout(page);
    expect(after.palette.top).toBeGreaterThanOrEqual(0);
    expect(after.palette.height).toBeLessThan(before.palette.height);
    expect(after.palette.bottom).toBeLessThan(after.cardTop);
  });
});

test.describe("a palette on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the screen-sized cap", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();
    await openPalette(page);

    const seen = await layout(page);
    // Six rows of 44 are shorter than 44vh, so nothing is clipped either way;
    // the desktop cap is untouched by the measured room above the card.
    expect(seen.palette.scrollHeight).toBe(seen.palette.clientHeight);
    expect(seen.palette.bottom).toBeLessThan(seen.cardTop);
  });
});

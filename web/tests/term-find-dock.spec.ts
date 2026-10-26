import { expect, test, type Page } from "@playwright/test";

/*
 * The terminal magnifier, docked in the key strip on a touch frame.
 *
 * It started life as a corner badge on the grid's own top-right — the place a
 * TUI keeps its status line. Measured on a 390x844 phone it cut the tail of two
 * paragraphs (`v0.6.14 ta[g]`), and on a 844x390 frame with the keyboard up the
 * grid is four rows tall while the badge is 44px, so it hid three of them.
 *
 * The fix renders the button as a sibling of `.term__host` so `terminal.css` can
 * dock it in the key strip: bottom-right in portrait, bottom-left sideways. The
 * assertions below are all geometry, because the failure this protects against
 * is a pixel overlap that no class name would report:
 *
 * - the disc sits inside the strip's band, clear of every face and of the lens
 *   switch that shares the row's right flank on a short landscape frame;
 * - the strip pays for the bay out of its own padding, so the faces keep their
 *   40px fingertip width (the 34px floor in `lib/keybar.test.ts` is the number
 *   that must not be reached);
 * - a phone too narrow to afford the bay (320px) keeps the corner badge;
 * - tapping the disc opens the bar without dropping the soft keyboard, which is
 *   why the button cancels `pointerdown` instead of letting focus leave the
 *   composer.
 */

const CAPTURE = [
  "herdr-web  v0.6.14",
  "",
  "  w6:p3   omp     idle",
  "  w6:p7   devin   idle",
  "",
  "$ herdr pane list",
  "",
].join("\n");

interface BridgeOptions {
  lens?: "chat" | "terminal";
  status?: "idle" | "blocked";
}

async function installBridge(
  page: Page,
  { lens = "terminal", status = "idle" }: BridgeOptions = {},
): Promise<void> {
  const pane = {
    id: "w2:p1",
    workspaceId: "w2",
    tabId: "w2:t1",
    focused: true,
    cwd: "/tmp/api",
    agentStatus: status,
    terminalTitle: "shell",
  };
  const workspace = {
    id: "w2",
    name: "api",
    windows: 1,
    attached: true,
    paneCount: 1,
    agentStatus: status,
  };
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  // Last route registered wins, so the fallback goes first.
  await page.route("**/api/v1/herdr/*", (route) => route.fulfill(json({})));
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill(
      json({
        enabled: true,
        socket: "/Users/op/.config/herdr/herdr.sock",
        status: "ok",
        version: "0.9.0",
        consoleVersion: "v0.3.1",
        protocol: 22,
        protocolTested: true,
      }),
    ),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) =>
    route.fulfill(json([workspace])),
  );
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill(json({ workspace, panes: [pane] })),
  );
  await page.route("**/api/v1/herdr/panes", (route) =>
    route.fulfill(json({ panes: [pane] })),
  );
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill(
      json({
        paneId: pane.id,
        source: "recent",
        format: "ansi",
        text: CAPTURE,
        revision: 1,
        truncated: false,
        agentStatus: status,
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) =>
    route.fulfill(json({ ok: true })),
  );
  await page.route("**/api/v1/herdr/panes/*/input", (route) =>
    route.fulfill(json({ ok: true })),
  );
  // A phone lands in the terminal lens on this frame by default only when held
  // sideways; pin it either way so the geometry does not depend on the default.
  await page.addInitScript((start) => {
    window.localStorage.setItem("herdr:lens:w2:p1", start);
  }, lens);
}

/**
 * Raise the keyboard by lying only about `visualViewport.height` — the one fact
 * a soft keyboard changes for the page. `PromptBar` sees the resize, publishes
 * `--kb-inset` and `has-keyboard`, and reflows; nothing here touches the class
 * the assertions read afterwards.
 */
async function keyboardUp(page: Page, inset: number): Promise<void> {
  await page.evaluate((px) => {
    const viewport = window.visualViewport;
    if (viewport === null) throw new Error("no visualViewport");
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, inset);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return style.getPropertyValue("--kb-inset").trim();
      }),
    )
    .toBe(`${inset}px`);
}

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return rect;
};

const padding = async (page: Page, side: "left" | "right") =>
  page.evaluate((edge) => {
    const strip = document.querySelector(".lens .keys");
    if (strip === null) throw new Error("no key strip");
    const style = getComputedStyle(strip);
    return Number.parseFloat(
      edge === "left" ? style.paddingLeft : style.paddingRight,
    );
  }, side);

/** The strip is the only band a docked disc may occupy. */
async function expectDockedInStrip(page: Page): Promise<void> {
  const strip = await box(page, ".lens .keys");
  const disc = await box(page, ".term__find-open");

  // Inside the band, the size of a face, and not one pixel above the strip's
  // top edge — the grid above is what the dock exists to uncover.
  expect(disc.y).toBeGreaterThanOrEqual(strip.y - 1);
  expect(disc.y + disc.height).toBeLessThanOrEqual(strip.y + strip.height + 1);
  expect(Math.round(disc.height)).toBe(40);
  expect(Math.round(disc.width)).toBe(44);
}

/** Every face keeps its fingertip width, and the disc clears the row. */
async function expectFacesClearOfDisc(page: Page): Promise<void> {
  const disc = await box(page, ".term__find-open");
  const faces = await page.locator(".lens .keys > *").all();
  expect(faces.length).toBeGreaterThan(3);

  for (const face of faces) {
    const rect = await face.boundingBox();
    if (rect === null) throw new Error("a key has no box");
    expect(Math.round(rect.width)).toBeGreaterThanOrEqual(40);
    expect(Math.round(rect.width)).toBeLessThanOrEqual(44);
    // Faces and the disc share a row, so they only have to miss horizontally.
    const overlap =
      Math.min(rect.x + rect.width, disc.x + disc.width) -
      Math.max(rect.x, disc.x);
    expect(overlap).toBeLessThanOrEqual(0);
    expect(
      Math.abs(rect.y + rect.height / 2 - (disc.y + disc.height / 2)),
    ).toBeLessThanOrEqual(3);
  }
}

test.describe("a phone upright", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("takes the magnifier out of the text and into the key strip", async ({
    page,
  }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await expect(page.locator(".term__find-open")).toBeVisible();

    await expectDockedInStrip(page);
    await expectFacesClearOfDisc(page);

    // The bay is paid for by the strip: 52px of right padding is the existing
    // 6px plus the disc and its 2px grip.
    expect(await padding(page, "right")).toBe(52);
    expect((await box(page, ".term__find-open")).x).toBe(390 - 2 - 44);

    // Nothing of the grid is hidden behind it any more: the host ends above the
    // strip and the disc starts inside it.
    const host = await box(page, ".term__host");
    const disc = await box(page, ".term__find-open");
    expect(host.y + host.height).toBeLessThanOrEqual(disc.y);

    // The keys menu replaces the row with a full-width panel, so the disc goes
    // with the row and comes back when the panel closes.
    await page.locator(".lens .keys__more").tap();
    await expect(page.locator(".keymenu__panel")).toBeVisible();
    await expect(page.locator(".term__find-open")).toBeHidden();
    await page.locator(".keymenu__hide").tap();
    await expect(page.locator(".keymenu__panel")).toBeHidden();
    await expect(page.locator(".term__find-open")).toBeVisible();
  });

  test("opens the bar and keeps the keyboard while it does", async ({
    page,
  }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".term__find-open")).toBeVisible();

    await page.locator("#herdr-input").tap();
    await keyboardUp(page, 300);

    const disc = await box(page, ".term__find-open");
    await page.touchscreen.tap(
      disc.x + disc.width / 2,
      disc.y + disc.height / 2,
    );

    // The bar is inside the host, so the disc's old corner is free for the field
    // and its two match buttons.
    await expect(page.locator(".term__find")).toBeVisible();
    const host = await box(page, ".term__host");
    const bar = await box(page, ".term__find");
    expect(bar.y).toBeGreaterThanOrEqual(host.y);
    expect(bar.y + bar.height).toBeLessThanOrEqual(host.y + host.height);

    // `pointerdown` was cancelled, so the composer still owns focus and the
    // keyboard is still up — on a four-row grid, losing it would be the whole
    // viewport.
    await expect(page.locator("html")).toHaveClass(/has-keyboard/);
    await expect(page.locator(".term__find-open")).toHaveCount(0);
  });

  test("a 320px phone keeps the corner badge instead", async ({ browser }) => {
    // Its own context: the geometry is the point, and the narrowest phone in use
    // cannot pay 52px of strip and still hold seven 40px faces.
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();

    const strip = await box(page, ".lens .keys");
    const disc = await box(page, ".term__find-open");
    // Above the strip, in the cell's top-right, as before.
    expect(disc.y + disc.height).toBeLessThanOrEqual(strip.y);
    expect(await padding(page, "right")).toBe(6);
    expect(Math.round(disc.width)).toBe(44);
    // And the strip still holds all seven faces without scrolling.
    const scroll = await page.evaluate(() => {
      const row = document.querySelector(".lens .keys");
      return row === null ? -1 : row.scrollWidth - row.clientWidth;
    });
    expect(scroll).toBeLessThanOrEqual(0);

    await context.close();
  });
});

test.describe("a phone on its side", () => {
  test.use({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });

  test("docks the magnifier on the left flank of the key row", async ({
    page,
  }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();

    await page.locator("#herdr-input").tap();
    await keyboardUp(page, 210);

    await expectDockedInStrip(page);
    await expectFacesClearOfDisc(page);

    // The disc takes the empty left flank, the lens switch keeps the right one.
    const disc = await box(page, ".term__find-open");
    const pill = await box(page, ".flip");
    expect(Math.round(disc.x)).toBe(2);
    expect(disc.x + disc.width).toBeLessThan(pill.x);
    expect(await padding(page, "left")).toBe(52);
    expect(await padding(page, "right")).toBe(6);

    // The grid above it is only four rows tall when the keyboard is up, and it
    // now gets all four.
    const host = await box(page, ".term__host");
    expect(host.y + host.height).toBeLessThanOrEqual(disc.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBe(390);

    // Tapping it opens the bar and leaves the keyboard alone.
    await page.touchscreen.tap(
      disc.x + disc.width / 2,
      disc.y + disc.height / 2,
    );
    await expect(page.locator(".term__find")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  });
});

test.describe("a squeezed window", () => {
  test.use({ viewport: { width: 640, height: 900 } });

  test("is a thumb frame without touch, so it docks too", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    // A phone-width window gets the phone layout whatever the pointer is, so the
    // dock has to follow the strip, not `(pointer: coarse)` alone.
    await expect(page.locator(".lens .keys")).toBeVisible();
    await expectDockedInStrip(page);
    expect(await padding(page, "right")).toBe(52);
  });
});

test.describe("a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("has no lens, so nothing to dock", async ({ page }) => {
    await installBridge(page, { lens: "chat" });
    await page.goto("/");
    await expect(page.locator(".stage")).toBeVisible();
    await expect(page.locator(".term")).toHaveCount(0);
    await expect(page.locator(".term__find-open")).toHaveCount(0);
  });
});

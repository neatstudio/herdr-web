import { expect, test, type Page } from "@playwright/test";

/*
 * Flipping the session lens while the phone is on its side and being typed into.
 *
 * On a short coarse screen the tab strip steps aside for the keyboard, and the
 * header goes with it: measured 844x390 with a 210px keyboard, the stage head
 * (`display: none`) leaves `.lens__switch` at 0x0. That left no way at all to
 * reach the terminal while typing — the switch only existed in chrome that had
 * just been hidden to buy transcript height.
 *
 * So the switch reappears as a floating pill on the key row's own line, inside
 * `.lens`, out of flow. It costs 0px of height (it is positioned), it lives in
 * the empty flank right of the last key (measured: last key ends at x=564 on a
 * 844px phone, the pill starts at 735), and its tap target is padded by 6px on
 * each side so the 26px face is a 38px target on a 44px row. `pointerdown` is
 * cancelled by the wrapper so tapping it does not take focus off the composer,
 * which is what keeps the keyboard up.
 *
 * The keyboard is simulated the way the composer actually detects one: only
 * `visualViewport.height` is lied about, and `PromptBar` is left to publish
 * `--kb-inset` and `has-keyboard` from its own resize handling. That is why the
 * pill's visibility is asserted through the class rather than by setting it.
 */

const MENU = [
  "$ npm test",
  "",
  "❯ 1. Yes, run the tests",
  "❯ 2. No, stop here",
  "esc to cancel · enter to confirm",
  "",
].join("\n");

const IDLE = ["$ ls", "a.txt  b.txt", "ready", ""].join("\n");

async function installBridge(
  page: Page,
  { waiting, lens = "chat" }: { waiting: boolean; lens?: "chat" | "terminal" },
): Promise<void> {
  const status = waiting ? "blocked" : "idle";
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
        text: waiting ? MENU : IDLE,
        revision: waiting ? 2 : 1,
        truncated: false,
        agentStatus: status,
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) => route.fulfill(json({ ok: true })));
  // Start in the requested lens. Chat is the tight case (answer chips above a
  // six-key row); terminal is where the keys menu lives.
  await page.addInitScript((start) => {
    window.localStorage.setItem("herdr:lens:w2:p1", start);
  }, lens);
  await page.route("**/api/v1/herdr/panes/*/input", (route) => route.fulfill(json({ ok: true })));
}

/**
 * Raise the keyboard by lying only about `visualViewport.height` — exactly the
 * one fact a soft keyboard changes for the page. `PromptBar` sees the resize,
 * publishes `--kb-inset`, and reflows. Nothing here touches the class the
 * assertions then read, so the assertions test the app's own detection.
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

/** Put the real viewport back and let the composer notice. */
async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    delete (viewport as unknown as Record<string, unknown>).height;
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).not.toHaveClass(/has-keyboard/);
}

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return rect;
};

test.describe("a phone on its side, keyboard up", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("the lens switch rides the answer row for free", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();

    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);

    const lens = await box(page, ".lens");
    const prompt = await box(page, ".prompt");
    const pill = await box(page, ".flip");

    // A waiting menu in this frame is an answer card: the rows below the lane
    // are the 18px question and a 40px answer row, and the bar's shift keys
    // live in that row (see squeeze-rows). So the band the pill grew up in is
    // gone — and the answer row's own trailing bay is what is empty now.
    await expect(page.locator(".lens .keys")).toBeHidden();
    const answers = await box(page, ".chat__pick");

    // The switch that used to be in the hidden header is gone; the floating one
    // replaces it and costs no height: the lens still ends where the composer
    // starts, and the pill ends inside the lens.
    await expect(page.locator(".lens__switch")).toBeHidden();
    expect(Math.round(lens.y + lens.height)).toBe(Math.round(prompt.y));
    expect(Math.round(pill.y + pill.height)).toBeLessThanOrEqual(
      Math.round(lens.y + lens.height),
    );

    // It sits inside the answer row's band, on its centre line, 10px in from
    // the edge, and clears the last answer face by a comfortable margin.
    expect(Math.round(pill.x + pill.width)).toBe(844 - 10);
    expect(pill.y).toBeGreaterThanOrEqual(answers.y);
    expect(pill.y + pill.height).toBeLessThanOrEqual(answers.y + answers.height);
    expect(
      Math.abs(pill.y + pill.height / 2 - (answers.y + answers.height / 2)),
    ).toBeLessThanOrEqual(4);
    const lastAnswer = await box(page, ".chat__pick > *:last-child");
    expect(pill.x - (lastAnswer.x + lastAnswer.width)).toBeGreaterThan(8);

    // The face is 26px tall but `::after` pads it to a 38px target: a point 4px
    // below the face still resolves to the control, not to the key row behind.
    const below = await page.evaluate(
      (point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && hit.closest(".flip__opt") !== null
          ? "flip"
          : String(hit?.className ?? "nothing");
      },
      { x: pill.x + pill.width / 2, y: pill.y + pill.height + 4 },
    );
    expect(below).toBe("flip");

    // No vertical overflow crept in: the page still measures exactly its view.
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight).toBe(390);

    // The pill belongs to the keyboard's lifetime only.
    await keyboardDown(page);
    await expect(page.locator(".flip")).toBeHidden();
  });

  test("tapping the pill flips the lens and keeps the keyboard up", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();

    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);

    const lens = page.locator(".lens").first();
    await expect(lens).toHaveAttribute("data-lens", "chat");
    await expect(page.locator(".flip__opt")).toHaveCount(2);
    await expect(page.locator(".flip__opt").nth(0)).toHaveAttribute("aria-pressed", "true");

    await page.locator(".flip__opt").nth(1).tap();
    await expect(lens).toHaveAttribute("data-lens", "terminal");
    await expect(page.locator(".lens .term")).toBeVisible();
    await expect(page.locator(".flip__opt").nth(1)).toHaveAttribute("aria-pressed", "true");
    // The whole point: the composer still owns focus, so the soft keyboard (and
    // therefore the pill) survives the tap.
    await expect(page.locator("#herdr-input")).toBeFocused();
    await expect(page.locator("html")).toHaveClass(/has-keyboard/);
    await expect(page.locator(".flip")).toBeVisible();

    await page.locator(".flip__opt").nth(0).tap();
    await expect(lens).toHaveAttribute("data-lens", "chat");
    await expect(page.locator("#herdr-input")).toBeFocused();
    await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  });

  test("the keys menu takes the pill's bay, so the pill steps out", async ({ page }) => {
    await installBridge(page, { waiting: true, lens: "terminal" });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);
    await expect(page.locator(".flip")).toBeVisible();

    // The open menu is a full row that ends in its own `hide`, in the same bay:
    // the pill must not cover it (it used to intercept the tap).
    await page.locator('button[aria-label="more keys"]').tap();
    await expect(page.locator(".keymenu__panel")).toBeVisible();
    await expect(page.locator(".flip")).toBeHidden();
    await page.locator(".keymenu__hide").tap();
    await expect(page.locator(".keymenu__panel")).toHaveCount(0);
    await expect(page.locator(".flip")).toBeVisible();
  });

  test("without a waiting menu there is no key row, so no pill", async ({ page }) => {
    await installBridge(page, { waiting: false });
    await page.goto("/");
    await expect(page.locator(".lens")).toBeVisible();

    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);

    // The gate is `:has(.keys)`: no key row means nothing to ride, and the
    // empty flank it would occupy is content instead.
    await expect(page.locator(".lens .keys")).toHaveCount(0);
    await expect(page.locator(".flip")).toBeHidden();
  });
});

test.describe("a phone in portrait", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the header switch is the one control, even keyboard up", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();

    await page.locator("#herdr-input").click();
    await keyboardUp(page, 336);

    // A key row is showing, so the `:has(.keys)` gate would pass: what excludes
    // portrait is the coarse-landscape media query. The real switch stays.
    await expect(page.locator(".flip")).toBeHidden();
    await expect(page.locator(".lens__switch")).toBeVisible();
  });
});

test.describe("a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("never renders the floating switch at all", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".stage")).toBeVisible();

    // Tiles are not a `.lens`; the control does not exist on this path.
    await expect(page.locator(".flip")).toHaveCount(0);
    await expect(page.locator(".lens")).toHaveCount(0);
  });
});

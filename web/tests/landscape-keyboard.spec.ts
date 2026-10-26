import { expect, test, type Page } from "@playwright/test";

/*
 * What a phone shows while it is being typed into.
 *
 * A phone on its side has 390px of height; the soft keyboard takes more than
 * half of it (iOS: ~210px). Every row of chrome is then a row of transcript, and
 * the tab strip was the expensive one: 37px, a fifth of what is left, spent
 * naming the focused pane that the composer already names in its placeholder
 * (`send to w2:p1`). So on a short coarse screen the strip steps aside for the
 * keyboard's lifetime and the pane gets the space back.
 *
 * The soft keyboard is simulated the way the composer detects it: `--kb-inset`
 * on the root plus `has-keyboard`, which is what `PromptBar` sets from
 * `visualViewport`. Real keyboards resize that same viewport, so the layout math
 * here is the layout math on a phone.
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
  // Last route registered wins, so the fallback goes first and every route the
  // console needs follows it.
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

/** Raise the keyboard the way `PromptBar` reports one, without a real one. */
async function keyboardUp(page: Page, inset: number): Promise<void> {
  await page.evaluate((px) => {
    document.documentElement.style.setProperty("--kb-inset", `${px}px`);
    document.documentElement.classList.add("has-keyboard");
  }, inset);
}

async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--kb-inset");
    document.documentElement.classList.remove("has-keyboard");
  });
}

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return rect;
};

test.describe("a phone on its side, keyboard up", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("the tab strip yields its 37px to the transcript", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    const strip = page.locator(".stage--lens > .strip");
    const lens = page.locator(".lens").first();
    await expect(strip).toBeVisible();
    const lensIdle = await box(page, ".lens");
    const stripIdle = await box(page, ".stage--lens > .strip");
    expect(stripIdle.height).toBeGreaterThan(30);

    // iOS landscape: 390 - 210 = 180px to draw in.
    await keyboardUp(page, 210);
    await expect(strip).toBeHidden();

    const lensTyping = await box(page, ".lens");
    expect(lensTyping.y).toBe(0);
    expect(lensTyping.height).toBeGreaterThan(100);

    // The keyboard shortens the shell; the question is whether the strip's rows
    // went to the pane or to nobody. Undo the rule for one measurement: the lens
    // must be exactly one strip shorter than it is now.
    const withoutStrip = await page.evaluate(() => {
      const strip = document.querySelector(".stage--lens > .strip") as HTMLElement;
      strip.style.display = "flex";
      const measured = {
        lens: document.querySelector(".lens")!.getBoundingClientRect().height,
        strip: strip.getBoundingClientRect().height,
      };
      strip.style.removeProperty("display");
      return measured;
    });
    expect(lensTyping.height - withoutStrip.lens).toBeCloseTo(withoutStrip.strip, 0);

    const prompt = await box(page, ".prompt");
    expect(Math.round(lensTyping.y + lensTyping.height)).toBe(Math.round(prompt.y));

    // Which pane receives the line is still on screen: the composer says so.
    await expect(page.locator("#herdr-input")).toHaveAttribute(
      "placeholder",
      "send to w2:p1",
    );
    // Reclaimed height is real space, not overflow.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(390);

    // Dismissing the keyboard brings the identity row back.
    await keyboardDown(page);
    await expect(strip).toBeVisible();
    expect(Math.round((await box(page, ".lens")).height)).toBe(Math.round(lensIdle.height));
  });
});

test.describe("a phone upright, keyboard up", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("keeps the tab strip: the screen is tall enough for both", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    await keyboardUp(page, 336);
    // 844 - 336 still leaves 400px of transcript, so the identity row earns its
    // 37px here and only the short landscape case may take it away.
    await expect(page.locator(".stage--lens > .strip")).toBeVisible();
    const lens = await box(page, ".lens");
    expect(lens.height).toBeGreaterThan(300);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  });
});

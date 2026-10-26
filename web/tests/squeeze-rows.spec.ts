import { expect, test, type Page } from "@playwright/test";

/*
 * Rows that fold when the lens itself runs out of height.
 *
 * A sideways phone with the keyboard up gives `.lens` what the composer did not
 * take, and the composer is allowed 40% of the visual viewport. Measured before
 * the fold existed: 844x390 with a 210px keyboard and a three-line draft leaves
 * the lens 82px, 568x320 with a 160px keyboard leaves 86px — while the chat
 * stack under the transcript (8px lane air + 44px answers + 44px keys) is
 * 104px. The bottom 18-22px of the key row were painted under the composer:
 * half a key visible, no key hittable.
 *
 * The fix keeps the composer's share and folds the rows instead, gated by a
 * container query on `.lens` itself (< 104px), so a roomy sideways screen keeps
 * its 44px rows. These tests pin the folded geometry, the hit points, and the
 * two boundaries that must not move: an empty draft still gets 44px rows, and
 * portrait is not affected at all.
 *
 * The keyboard is simulated the way the composer actually detects one: only
 * `visualViewport.height` is lied about and `PromptBar` publishes the class.
 */

const MENU = [
  "$ npm test",
  "",
  "❯ 1. Yes, run the tests",
  "❯ 2. No, stop here",
  "esc to cancel · enter to confirm",
  "",
].join("\n");

const DRAFT = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");

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
        text: waiting ? MENU : "$ ls\na.txt  b.txt\nready\n",
        revision: 2,
        truncated: false,
        agentStatus: status,
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) => route.fulfill(json({ ok: true })));
  await page.route("**/api/v1/herdr/panes/*/input", (route) => route.fulfill(json({ ok: true })));
  await page.addInitScript((start) => {
    window.localStorage.setItem("herdr:lens:w2:p1", start);
  }, lens);
}

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
}

async function typeDraft(page: Page): Promise<void> {
  await page.locator("#herdr-input").fill(DRAFT);
  // The composer measures, sets the box, the lens takes the rest: wait until the
  // geometry has settled rather than sampling mid-resize.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const prompt = document.querySelector(".prompt");
        return prompt === null ? -1 : Math.round(prompt.getBoundingClientRect().height);
      }),
    )
    .toBeGreaterThan(60);
}

type Rect = { y: number; bottom: number; height: number; x: number; width: number };

async function rects(page: Page): Promise<Record<string, Rect | null>> {
  const measure = (selector: string): Rect | null => {
    const element = document.querySelector(selector);
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      bottom: Math.round(box.bottom),
    };
  };
  return page.evaluate((selectors) => {
    const out: Record<string, Rect | null> = {};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element === null) {
        out[selector] = null;
        continue;
      }
      const box = element.getBoundingClientRect();
      out[selector] = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        bottom: Math.round(box.bottom),
      };
    }
    return out;
  }, [".lens", ".chat__lane", ".chat__pick", ".chat__pickopt", ".lens .keys", ".lens .keys > *", ".prompt", ".flip"]);
}

/** What a fingertip at the centre of a row actually hits. */
async function hitAt(page: Page, selector: string): Promise<string> {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) return "missing";
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(box.x + box.width / 2),
      Math.round(box.y + box.height / 2),
    );
    return hit === null ? "nothing" : String((hit as HTMLElement).className);
  }, selector);
}

test.describe("a sideways phone, keyboard up, draft at the composer's cap", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("folds the answer and key rows until the lens fits", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);
    await typeDraft(page);

    const now = await rects(page);
    const lens = now[".lens"];
    const keys = now[".lens .keys"];
    const chipRow = now[".chat__pick"];
    const chip = now[".chat__pickopt"];
    const prompt = now[".prompt"];
    const key = now[".lens .keys > *"];
    if (!lens || !keys || !chipRow || !chip || !prompt || !key) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    // The disagreement this fixes: 8 + 44 + 44 = 104 in an 82px lens. The lens
    // ends where the composer starts, and the key row now ends there too.
    expect(lens.height).toBe(82);
    expect(Math.round(lens.bottom)).toBe(Math.round(prompt.y));
    expect(keys.bottom).toBeLessThanOrEqual(lens.bottom);

    // Folded, not shaved: 40px rows, 40px faces, nothing under the fingertip
    // floor the chips already set.
    expect(chipRow.height).toBe(40);
    expect(keys.height).toBe(40);
    expect(key.height).toBe(40);
    expect(chip.height).toBe(32);

    // The key row is still a key row: the divider moved from the border into an
    // inset shadow so 40px of face could live in a 40px row.
    const divider = await page.evaluate(() => {
      const row = document.querySelector(".lens .keys");
      if (row === null) return null;
      const style = getComputedStyle(row);
      return { border: style.borderTopWidth, shadow: style.boxShadow };
    });
    expect(divider?.border).toBe("0px");
    expect(divider?.shadow).toContain("inset");

    // And every row answers a tap: the fold must not put the composer over them.
    expect(await hitAt(page, ".lens .keys > *")).toContain("keys__key");
    expect(await hitAt(page, ".chat__pickopt")).toContain("chat__pickopt");

    // The composer was not the thing that gave: it keeps its 3 rows (40% of the
    // 180px visual viewport) and the draft still reads.
    expect(prompt.height).toBe(90);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight).toBe(390);
  });

  test("keeps 44px rows when the draft is short enough to leave the lens room", async ({
    page,
  }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 210);

    const now = await rects(page);
    const lens = now[".lens"];
    const keys = now[".lens .keys"];
    const chipRow = now[".chat__pick"];
    if (!lens || !keys || !chipRow) throw new Error(`geometry missing: ${JSON.stringify(now)}`);

    // An empty draft leaves a 106px lens — above the 104px the stack needs, so
    // the container query must not fire and the comfortable rows stay.
    expect(lens.height).toBe(106);
    expect(chipRow.height).toBe(44);
    expect(keys.height).toBe(44);
    expect(keys.bottom).toBeLessThanOrEqual(lens.bottom);

    const container = await page.evaluate(() => {
      const lensElement = document.querySelector(".lens");
      return lensElement === null ? null : getComputedStyle(lensElement).containerType;
    });
    expect(container).toBe("size");
  });
});

test.describe("the shortest sideways phone", () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

  test("keeps both rows on screen with no lane left to spare", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 160);
    await typeDraft(page);

    const now = await rects(page);
    const lens = now[".lens"];
    const keys = now[".lens .keys"];
    const chipRow = now[".chat__pick"];
    const lane = now[".chat__lane"];
    const prompt = now[".prompt"];
    if (!lens || !keys || !chipRow || !lane || !prompt) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    // 86px of lens: still 18px short of the unfolded stack, and the fold ends
    // exactly at the composer's edge — 6px of lane is what is left over.
    expect(lens.height).toBe(86);
    expect(Math.round(lens.bottom)).toBe(Math.round(prompt.y));
    expect(keys.bottom).toBe(lens.bottom);
    expect(chipRow.height).toBe(40);
    expect(keys.height).toBe(40);
    expect(lane.height).toBeGreaterThanOrEqual(0);

    // The lane gave its 8px air, but the answer chips above it stay hittable.
    expect(lane.height).toBeLessThan(8);
    expect(await hitAt(page, ".chat__pickopt")).toContain("chat__pickopt");
    expect(await hitAt(page, ".lens .keys > *")).toContain("keys__key");
  });

  test("the terminal lens keeps a readable screen above its folded key row", async ({ page }) => {
    await installBridge(page, { waiting: true, lens: "terminal" });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 160);
    await typeDraft(page);

    const now = await rects(page);
    const lens = now[".lens"];
    const keys = now[".lens .keys"];
    if (!lens || !keys) throw new Error(`geometry missing: ${JSON.stringify(now)}`);

    // The same fold applies on this lens, and it buys the terminal nothing but
    // safety: the key row still ends inside the lens.
    expect(keys.height).toBe(40);
    expect(keys.bottom).toBeLessThanOrEqual(lens.bottom);
    const term = await page.locator(".lens .term").first().boundingBox();
    expect(term).not.toBeNull();
    expect(Math.round((term?.height ?? 0) + (term?.y ?? 0))).toBeLessThanOrEqual(lens.bottom);
  });
});

test.describe("a phone in portrait", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("is not folded, however short the viewport gets", async ({ page }) => {
    await installBridge(page, { waiting: true });
    await page.goto("/");
    await expect(page.locator(".lens .keys")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 336);
    await typeDraft(page);

    const now = await rects(page);
    const keys = now[".lens .keys"];
    const chipRow = now[".chat__pick"];
    if (!keys || !chipRow) throw new Error(`geometry missing: ${JSON.stringify(now)}`);

    // The fold is scoped to the short coarse frame (`max-height: 499px`): a tall
    // phone has the height for 44px rows and keeps them.
    expect(keys.height).toBe(44);
    expect(chipRow.height).toBe(44);
  });
});

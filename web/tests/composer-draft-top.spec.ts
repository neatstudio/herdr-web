import { expect, test, type Page } from "@playwright/test";

/*
 * Where the first line of a phone draft sits in its card.
 *
 * The composer aligns its field to the bottom on a desktop so a one-row pad
 * lands on the last line of a two-row draft. On a phone the pad is two rows —
 * 74px against a 48px draft floor — so the same rule pushed the draft down
 * until its box bottomed out against the pad: measured at 390x844 the field was
 * y751..825, the textarea y777..825, and the placeholder's baseline started
 * 26px below the attach button it sits beside. The top-left of the card read as
 * a hole, and the caret began under the controls.
 *
 * Top-aligned, the draft starts with attach and image (both y751) and the empty
 * row under it reads as room to write. The card keeps its 96px, because the pad
 * is still the tallest thing in it — this costs no transcript. Typing mode folds
 * the pad into one row and centers it on the draft again, so these tests pin all
 * three states and the desktop rule that must not move.
 *
 * The keyboard is simulated the way the composer actually detects one: only
 * `visualViewport.height` is lied about, then `PromptBar` publishes the class.
 */

const DRAFT = ["first line", "second line"].join("\n");

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
  await page.route("**/api/v1/herdr/workspaces", (route) => route.fulfill(json([WORKSPACE])));
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill(json({ workspace: WORKSPACE, panes: [PANE] })),
  );
  await page.route("**/api/v1/herdr/panes", (route) => route.fulfill(json({ panes: [PANE] })));
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill(
      json({
        paneId: PANE.id,
        source: "recent",
        format: "ansi",
        text: "$ ls\na.txt  b.txt\nready\n",
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

type Box = { x: number; y: number; width: number; height: number; bottom: number };

async function boxes(page: Page): Promise<Record<string, Box | null>> {
  return page.evaluate((selectors) => {
    const out: Record<string, Box | null> = {};
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
  }, [".prompt", ".prompt__field", ".prompt textarea", "#herdr-attach-button", ".prompt__pad"]);
}

function alignOf(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const field = document.querySelector(".prompt__field");
    return field === null ? null : getComputedStyle(field).alignItems;
  });
}

async function typeDraft(page: Page): Promise<void> {
  await page.locator("#herdr-input").fill(DRAFT);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const input = document.querySelector(".prompt textarea");
        return input === null ? -1 : Math.round(input.getBoundingClientRect().height);
      }),
    )
    .toBe(48);
}

test.describe("a phone, no keyboard", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("starts the draft level with the controls instead of on the card's floor", async ({
    page,
  }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".prompt textarea")).toBeVisible();

    expect(await alignOf(page)).toBe("start");

    const now = await boxes(page);
    const card = now[".prompt"];
    const field = now[".prompt__field"];
    const draft = now[".prompt textarea"];
    const attach = now["#herdr-attach-button"];
    const pad = now[".prompt__pad"];
    if (!card || !field || !draft || !attach || !pad) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    // The complaint: 777 against 751, a 26px void over the placeholder. One
    // pixel is the rounding of the two boxes, not slack.
    expect(Math.abs(draft.y - attach.y)).toBeLessThanOrEqual(1);

    // Nothing was paid for it: the 2x2 pad is still the tallest thing in the
    // card, so the field is exactly the pad. The numbers are 66/82 rather than
    // 74/96 because the phone's density block takes the pad's faces from 36px
    // to 30px — the card was 96px of a phone screen for an empty box; its
    // controls keep their 44px reach through a wider skirt, not a bigger face.
    expect(card.height).toBe(82);
    expect(field.height).toBe(66);
    expect(pad.height).toBe(66);
    expect(pad.bottom).toBe(field.bottom);

    // The draft still has its two-row floor to grow into, its column still ends
    // before the pad begins, and the field is inset evenly in the card — the fix
    // moved the draft inside the field, it did not resize the card.
    expect(draft.height).toBe(48);
    expect(draft.x + draft.width).toBeLessThanOrEqual(pad.x);
    expect(field.y - card.y).toBe(card.bottom - field.bottom);
  });

  test("keeps the card at two rows while the draft grows", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".prompt textarea")).toBeVisible();
    await typeDraft(page);

    const now = await boxes(page);
    const card = now[".prompt"];
    const draft = now[".prompt textarea"];
    const attach = now["#herdr-attach-button"];
    if (!card || !draft || !attach) throw new Error(`geometry missing: ${JSON.stringify(now)}`);

    expect(card.height).toBe(82);
    expect(draft.y).toBe(attach.y);
  });
});

test.describe("a phone, keyboard up", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("folds the pad to one row and centres it on the draft again", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".prompt textarea")).toBeVisible();
    await page.locator("#herdr-input").click();
    await keyboardUp(page, 300);
    await typeDraft(page);

    // Center, not start: folding the pad makes the 48px draft the tallest thing
    // in a 66px card, so the one row of controls rides its middle.
    expect(await alignOf(page)).toBe("center");

    const now = await boxes(page);
    const card = now[".prompt"];
    const draft = now[".prompt textarea"];
    const attach = now["#herdr-attach-button"];
    const pad = now[".prompt__pad"];
    if (!card || !draft || !attach || !pad) throw new Error(`geometry missing: ${JSON.stringify(now)}`);

    expect(pad.height).toBe(36);
    expect(card.height).toBe(66);
    expect(attach.y).toBeGreaterThan(draft.y);
    expect(attach.y + attach.height).toBeLessThan(draft.bottom);
  });
});

test.describe("a sideways phone, no keyboard", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("folds the pad sideways and centres it on the draft", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".prompt textarea")).toBeVisible();

    expect(await alignOf(page)).toBe("center");

    const now = await boxes(page);
    const card = now[".prompt"];
    const pad = now[".prompt__pad"];
    if (!card || !pad) throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    expect(card.height).toBe(70);
    expect(pad.height).toBe(36);
  });
});

test.describe("a window, a mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the draft on the floor of a one-row field", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".prompt textarea")).toBeVisible();

    // The desktop rule is unchanged: the pad is one 34px row, the draft is two
    // 22px lines, and bottom alignment puts the controls on the last line.
    expect(await alignOf(page)).toBe("end");

    const now = await boxes(page);
    const draft = now[".prompt textarea"];
    const attach = now["#herdr-attach-button"];
    if (!draft || !attach) throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    expect(attach.y).toBeGreaterThan(draft.y);
    expect(attach.y + attach.height).toBeLessThanOrEqual(draft.bottom);
  });
});

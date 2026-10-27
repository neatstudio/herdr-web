import { expect, test, type Page } from "@playwright/test";

/*
 * The question a menu is asking, and the way back out of it.
 *
 * A menu prints its question above its options, and on a single-line terminal
 * that is three or four rows up. The transcript lane under the answer chips is
 * 18px on a sideways phone with the keyboard up — less than one line — and it
 * is the *bottom* of the transcript, so the question is exactly the row that
 * falls off. The operator then sees six answers and no idea what they answer.
 *
 * So the short frame prints the question itself, in the 18px the answer card
 * has above its chips, and folds the key bar's shift keys into the chip row so
 * the card costs no more height than the rows it replaces (see squeeze-rows).
 * These tests pin the reading (one clipped line, the right line, nothing on a
 * frame with room), and both writes: esc and enter must reach the pane as the
 * shift keys they stand for, not as chips that answer "1".
 *
 * The bridge is mocked at the HTTP boundary, as the other browser suites do:
 * these taps must never reach a real pane.
 */

const QUESTION = "三个方向，选一个：";
const ANSWERS = ["重写这一段", "分成两段", "先给我看 diff"];

const LONG_QUESTION =
  "The release build is failing on the branch you asked me to keep clean: " +
  "do you want the failing log first, or the diff of the change that broke it?";

const PANE = {
  id: "w2:p1",
  workspaceId: "w2",
  tabId: "w2:t1",
  focused: true,
  cwd: "/tmp/api",
  agentStatus: "blocked",
  terminalTitle: "shell",
};

const WORKSPACE = {
  id: "w2",
  name: "api",
  windows: 1,
  attached: true,
  paneCount: 1,
  agentStatus: "blocked",
};

/** A blocked agent's snapshot: the question, then the menu under it. */
function snapshot(question: string): string {
  const rows = ANSWERS.map((label, index) => `❯ ${index + 1}. ${label}`);
  return ["$ npm run release", "", question, "", ...rows, "esc to cancel · enter to confirm", ""].join(
    "\n",
  );
}

/** The pane's write route, so a tap can be read back as the keys it sent. */
async function installBridge(page: Page, question: string): Promise<string[]> {
  const keyPosts: string[] = [];
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  // Last route registered wins, so the fallback goes first and every route the
  // shell actually reads is registered after it.
  await page.route("**/api/v1/herdr/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill(json({ enabled: true, status: "ok", version: "0.9.0", protocol: 22 })),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) =>
    route.fulfill(json([WORKSPACE])),
  );
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill(json({ workspace: WORKSPACE, panes: [PANE] })),
  );
  await page.route("**/api/v1/herdr/panes", (route) =>
    route.fulfill(json({ panes: [PANE] })),
  );
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill(
      json({
        paneId: PANE.id,
        source: "recent",
        format: "ansi",
        text: snapshot(question),
        revision: 2,
        truncated: false,
        agentStatus: "blocked",
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill(json({ ok: true }));
  });
  return keyPosts;
}

/**
 * Raise the keyboard by lying only about `visualViewport.height` — the one fact
 * a soft keyboard changes. `PromptBar` publishes `--kb-inset` and the shell
 * reflows for real, which is what the container query reads.
 */
async function keyboardUp(page: Page, inset: number): Promise<void> {
  await page.evaluate((px) => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, inset);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  await page.waitForTimeout(120);
}

/** Open the transcript lens with the keyboard up, optionally with a draft. */
async function openChat(
  page: Page,
  frame: { width: number; height: number; inset: number; draft: boolean },
  question: string = QUESTION,
) {
  const keyPosts = await installBridge(page, question);
  await page.setViewportSize({ width: frame.width, height: frame.height });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("herdr:lens:w2:p1", "chat");
    } catch {
      /* the shell falls back to the pane's own default */
    }
  });
  await page.goto("/");
  await expect(page.locator(".chat__pickopt").first()).toBeVisible();
  await page.locator("#herdr-input").click();
  await keyboardUp(page, frame.inset);
  if (frame.draft) {
    // Five lines: the composer takes its 40% share and the lens folds.
    await page.locator("#herdr-input").fill("one\ntwo\nthree\nfour\nfive");
    await expect
      .poll(async () => (await page.locator(".prompt").boundingBox())?.height ?? 0)
      .toBeGreaterThan(60);
  }
  return keyPosts;
}

/** The card: the question strip, the chips, the lane, the lens. */
async function card(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        display: style.display,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        text: element.textContent ?? "",
      };
    };
    return {
      lens: box(".lens"),
      lane: box(".chat__lane"),
      ask: box(".chat__ask"),
      pick: box(".chat__pick"),
      keys: box(".chat .keys"),
      prompt: box(".prompt"),
    };
  });
}

test.describe("the question on a sideways phone, keyboard up", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("prints the question the lane cannot reach, in one clipped line", async ({
    page,
  }) => {
    await openChat(page, { width: 844, height: 390, inset: 210, draft: true });
    const now = await card(page);
    if (!now.ask || !now.lane || !now.pick || !now.lens || !now.prompt) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    // The lane is 24px here, less than one line of prose: without the strip the
    // question is the row that falls off. It is 18px, above the chips, below
    // the whole lane, and as wide as the lane the answers are laid in.
    expect(now.ask.display).toBe("block");
    expect(now.ask.height).toBe(18);
    expect(now.ask.width).toBe(820);
    expect(Math.round(now.lane.bottom)).toBe(Math.round(now.ask.top));
    expect(Math.round(now.ask.bottom)).toBe(Math.round(now.pick.top));

    // The question as the pane printed it, not the hint line and not an option.
    expect(now.ask.text).toBe(QUESTION);
    // One line, whatever the menu said: the strip never grows the card.
    expect(now.ask.scrollWidth).toBeLessThanOrEqual(now.ask.clientWidth + 1);

    // And the card still ends where the composer starts, with the lens intact.
    expect(now.lens.height).toBe(82);
    expect(Math.round(now.lens.bottom)).toBe(Math.round(now.prompt.top));
  });

  test("clips a question that is longer than the lane instead of growing", async ({
    page,
  }) => {
    // The narrowest sideways phone: a 544px lane cannot hold 130 characters of
    // 11px mono, so the strip has to cut. It answers with one ellipsis rather
    // than a second line the card does not have.
    await openChat(page, { width: 568, height: 320, inset: 160, draft: true }, LONG_QUESTION);
    const now = await card(page);
    if (!now.ask || !now.pick || !now.lens) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    expect(now.ask.height).toBe(18);
    expect(now.ask.width).toBe(544);
    expect(now.ask.scrollWidth).toBeGreaterThan(now.ask.clientWidth);
    expect(now.lens.height).toBe(86);
    expect(now.pick.height).toBe(40);

    // The text itself is capped before it ever reaches the DOM (96 characters),
    // so a very long question cannot make the strip expensive to lay out; the
    // cap wears the same ellipsis the CSS would have drawn.
    const title = await page.locator(".chat__ask").getAttribute("title");
    expect(title).not.toBeNull();
    expect(title!.startsWith("The release build is failing on the branch")).toBe(true);
    expect(title!.endsWith("…")).toBe(true);
    expect(title!.length).toBe(96);
  });

  test("sends esc and enter from the card, not a chip's number", async ({ page }) => {
    const keyPosts = await openChat(page, {
      width: 844,
      height: 390,
      inset: 210,
      draft: true,
    });
    const keys = page.locator(".chat__pickkey");
    await expect(keys).toHaveCount(2);

    // The bar that owned these two keys is gone in the card, so the card owns
    // them: 44 x 32, one at each end of the pair, both inside the answer row.
    const faces = await keys.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, top: rect.top };
      }),
    );
    expect(faces.every((face) => face.width === 44)).toBe(true);
    expect(faces.every((face) => face.height === 32)).toBe(true);
    expect(Math.round(faces[0].top)).toBe(Math.round(faces[1].top));

    // The label and the aria-label are prose; the wire carries herdr's own key
    // name, spelled exactly as the key bar spells it (`esc`, `Enter`), so that
    // is what the poll looks for.
    await keys.first().tap();
    await expect.poll(() => keyPosts.join("|")).toContain('"esc"');

    await keys.last().tap();
    await expect.poll(() => keyPosts.join("|")).toContain('"Enter"');

    // Never a number: these faces answer the menu's control keys, and a chip's
    // "1" would answer the question instead of dismissing it.
    expect(keyPosts.join("|").toLowerCase()).not.toContain('"1"');
  });
});

test.describe("a frame with room", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("keeps the key bar and leaves the question in the transcript", async ({
    page,
  }) => {
    await openChat(page, { width: 390, height: 844, inset: 336, draft: false });
    const now = await card(page);
    if (!now.ask || !now.keys || !now.lens || !now.lane) {
      throw new Error(`geometry missing: ${JSON.stringify(now)}`);
    }

    // 433px of lens: the transcript shows the question in its own prose, so the
    // strip stays out of the flow — purely additive on the frames that were
    // already right, 44px keys included.
    expect(now.lens.height).toBeGreaterThan(167);
    expect(now.ask.display).toBe("none");
    expect(now.lane.height).toBeGreaterThan(100);
    expect(now.keys.display).not.toBe("none");
    expect(now.keys.height).toBe(44);
  });
});

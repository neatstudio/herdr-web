import { expect, test, type Page } from "@playwright/test";

/*
 * The short-lens card is not a landscape feature.
 *
 * The card that folds the answer row and the key row into one belongs to the
 * lens, not to the frame, but its trigger was gated on
 * `(pointer: coarse) and (max-height: 499px)` — "the phone is on its side" —
 * and a portrait phone had no way to reach it. It does as soon as the keyboard
 * brings a candidate bar and the draft grows: with the blocked-menu fixture,
 * a 375x667 phone and a 336px keyboard leave the lens 148px and the transcript
 * 60px; 360x640 with 320px leaves 137/49; 320x568 with 260px leaves 125/37.
 * At 37px the lane cannot show the question the chips are answering, while a
 * 44px chip row and a 44px key row take 88px of a 125px lens — and the key row
 * only repeats esc and enter, which the chips carry anyway.
 *
 * So `index.css` registers the lens container for every coarse keyboard frame
 * and lets the two height queries decide. A roomy portrait lens is untouched:
 * 390x844 with a 336px keyboard leaves 325px, nothing under 167px matches, and
 * the frame measures exactly as it did before the change.
 *
 * The bridge is mocked at the HTTP boundary: nothing here reaches a pane.
 */

// The container is only registered for coarse pointers with the keyboard up.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const QUESTION = "三个方向，选一个：";
const ANSWERS = ["重写这一段", "分成两段", "先给我看 diff"];

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

/**
 * A blocked pane with a menu: the snapshot spells the answers out, so the lens
 * draws chips, and holds enough prose that only the tail of it fits in a short
 * lane — the question is what a reader has to be able to see.
 */
const SNAPSHOT = [
  "❭ 评审一下这个仓库",
  "",
  " 我先看了 server/ 的分层，watcher 和 session 的边界是清楚的。",
  "",
  " 但有三处值得说：",
  "",
  " 1. watcher 里的 ticker 没有 stop。",
  " 2. session 关闭时没有等 in-flight。",
  " 3. 错误只用 log 打印。",
  "",
  "$ npm run release",
  "",
  QUESTION,
  "",
  ...ANSWERS.map((label, index) => `❯ ${index + 1}. ${label}`),
  "esc to cancel · enter to confirm",
  "",
].join("\n");

async function installBridge(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  // Last route registered wins, so the fallback goes first.
  await page.route("**/api/v1/herdr/*", (route) => route.fulfill(json({})));
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill(json({ enabled: true, status: "ok", version: "0.9.0", protocol: 22 })),
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
        text: SNAPSHOT,
        revision: 2,
        truncated: false,
        agentStatus: "blocked",
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) => route.fulfill(json({ ok: true })));
  await page.route("**/api/v1/herdr/panes/*/input", (route) => route.fulfill(json({ ok: true })));
  await page.addInitScript(() => {
    window.localStorage.setItem("herdr:lens:w2:p1", "chat");
  });
}

/*
 * Lip service to the keyboard, the way `landscape-keyboard.spec.ts` does it:
 * the browser cannot open one, so the visual viewport is told to be shorter and
 * the composer publishes `--kb-inset` and `has-keyboard` from what it measures.
 */
async function keyboard(page: Page, cover: number): Promise<void> {
  await page.evaluate((px) => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return;
    }
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, cover);
  await page.waitForTimeout(150);
}

/** Open the transcript lens with the keyboard up and a five-line draft. */
async function openChat(
  page: Page,
  frame: { width: number; height: number; inset: number; draft: boolean },
): Promise<void> {
  await installBridge(page);
  await page.setViewportSize({ width: frame.width, height: frame.height });
  await page.goto("/");
  await expect(page.locator(".chat__pickopt").first()).toBeVisible();
  await page.locator("#herdr-input").click();
  await keyboard(page, frame.inset);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  if (frame.draft) {
    await page.locator("#herdr-input").fill("one\ntwo\nthree\nfour\nfive");
  }
  await page.waitForTimeout(150);
}

type Box = { top: number; bottom: number; height: number; width: number };

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null): { top: number; bottom: number; height: number; width: number } | null => {
      if (element === null) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
      };
    };
    const lens = document.querySelector<HTMLElement>(".lens");
    const ask = document.querySelector<HTMLElement>(".chat__ask");
    const keys = document.querySelector<HTMLElement>(".chat .keys");
    const pick = document.querySelector<HTMLElement>(".chat__pick");
    return {
      lens: box(lens),
      lane: box(document.querySelector(".chat__lane")),
      ask: box(ask),
      pick: box(pick),
      pickPad: pick === null ? null : getComputedStyle(pick).paddingTop,
      keys: box(keys),
      prompt: box(document.querySelector(".prompt")),
      container: lens === null ? "none" : getComputedStyle(lens).containerType,
      askShown: ask !== null && getComputedStyle(ask).display !== "none",
      keysShown: keys !== null && getComputedStyle(keys).display !== "none",
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
}

test("a short portrait lens folds to the card and keeps the question", async ({ page }) => {
  await openChat(page, { width: 375, height: 667, inset: 336, draft: true });

  // Registration is what makes `@container lens` work at all in portrait.
  const card = await measure(page);
  expect(card.container, "the lens is a size container while typing").toBe("size");

  // 148px of lens: 18px question, 44px answers, the rest to the transcript.
  expect(card.lens?.height).toBe(148);
  expect(card.askShown, "the question line is paid for").toBe(true);
  expect(card.ask?.height).toBe(18);
  // `--ui-lane` is `min(100% - 24px, 820px)`, so the strip is the lane's
  // content width, not the frame's: 375 - 24.
  expect(card.ask?.width).toBe(351);
  expect(card.ask?.width).toBe((card.lane?.width ?? 0) - 24);
  expect(card.ask?.top, "the strip sits under the transcript").toBe(card.lane?.bottom);
  expect(card.ask?.bottom, "and directly above the answers").toBe(card.pick?.top);
  expect(card.pick?.height, "the answers keep their 44px row").toBe(44);
  expect(card.keysShown, "the key row gives its 44px back").toBe(false);

  // 86px of transcript, up from 60px, and the whole stack closes the lens.
  expect(card.lane?.height).toBe(86);
  expect(card.lens?.bottom).toBe(card.prompt?.top);

  // The two shift keys move into the answers row rather than disappearing: a
  // 44x32 face inside the 44px row, still a fingertip target.
  const shift = page.locator(".chat__pickkey");
  await expect(shift).toHaveCount(2);
  const face = await shift.first().boundingBox();
  expect(Math.round(face === null ? 0 : face.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(face === null ? 0 : face.height)).toBe(32);

  // And the chips are still the answer: the middle of the first two is a chip.
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".chat__pickopt")].slice(0, 2).map((chip) => {
      const rect = chip.getBoundingClientRect();
      const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return at === null ? null : at.closest(".chat__pickopt") !== null;
    }),
  );
  expect(hits).toEqual([true, true]);

  // Nothing spills: the composer ends inside the visible viewport.
  expect(card.documentHeight).toBe(card.viewportHeight);
  expect(card.prompt === null ? 0 : card.prompt.bottom).toBeLessThanOrEqual(card.viewportHeight);
});

test("a 320px phone in portrait gets the card too, and gives it back", async ({ page }) => {
  await openChat(page, { width: 320, height: 568, inset: 300, draft: true });

  // 109px of lens, 47px of transcript — here the lane used to be 21px, less
  // than one line of prose, with the question somewhere above it.
  const card = await measure(page);
  expect(card.lens?.height).toBe(109);
  expect(card.lane?.height).toBe(47);
  expect(card.askShown).toBe(true);
  expect(card.ask?.height).toBe(18);
  expect(card.pick?.height).toBe(44);
  expect(card.keysShown).toBe(false);
  expect(card.lens?.bottom).toBe(card.prompt?.top);

  // The card is a keyboard state, not a one-way trip: drop the keyboard and
  // the container goes away with it, so the 167px query cannot match and the
  // full 44px rows come back.
  await keyboard(page, 0);
  await expect(page.locator("html")).not.toHaveClass(/has-keyboard/);
  const resting = await measure(page);
  expect(resting.container, "no container without the keyboard").toBe("normal");
  expect(resting.askShown, "no question strip in a roomy lens").toBe(false);
  expect(resting.keysShown, "the key row is back").toBe(true);
  expect(resting.pick?.height).toBe(44);
  expect(resting.lens?.height ?? 0).toBeGreaterThan(167);
});

test("at 103px of lens the fold is the same as it is sideways", async ({ page }) => {
  await openChat(page, { width: 320, height: 568, inset: 330, draft: true });

  // Exactly the boundary: the second height query gives the row 4px of padding
  // and 40px faces, and last round's landscape frames pinned the same numbers.
  const folded = await measure(page);
  expect(folded.container).toBe("size");
  expect(folded.lens?.height).toBe(103);
  expect(folded.ask?.height).toBe(18);
  expect(folded.pick?.height, "a 40px answer row").toBe(40);
  expect(folded.pickPad, "4px of padding, not 6").toBe("4px");
  expect(folded.keysShown).toBe(false);
  const face = await page.locator(".chat__pickkey").first().boundingBox();
  expect(Math.round(face === null ? 0 : face.height), "the 32px face sits in the row").toBe(32);
  expect(folded.documentHeight).toBe(folded.viewportHeight);
});

test("a roomy portrait lens is left exactly as it was", async ({ page }) => {
  await openChat(page, { width: 390, height: 844, inset: 336, draft: true });

  // 325px of lens: the container exists, no height query matches, so the frame
  // measures the way it did before the registration widened.
  const roomy = await measure(page);
  expect(roomy.container).toBe("size");
  expect(roomy.lens?.height).toBe(325);
  expect(roomy.lane?.height).toBe(237);
  expect(roomy.askShown, "no card in a roomy lens").toBe(false);
  expect(roomy.pick?.height).toBe(44);
  expect(roomy.pickPad).toBe("6px");
  expect(roomy.keysShown).toBe(true);
  expect(roomy.lens?.bottom).toBe(roomy.prompt?.top);
});

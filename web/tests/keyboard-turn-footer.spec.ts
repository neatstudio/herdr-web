import { expect, test, type Page } from "@playwright/test";

/*
 * The row under a turn, while the keyboard is up.
 *
 * On a phone in landscape the keyboard leaves 106px of lane. The turn footer —
 * the status dot, the clock, and the two copy buttons, 44px tall on a coarse
 * pointer — took 41% of it, and the answer it belongs to was pushed a line out
 * of view; portrait loses 44px of 433px the same way. Nothing in the row is a
 * typing tool: the dot and the clock restate the send button, and `markdown` /
 * `text` are reached for after reading, not while writing. So it leaves the
 * flow for as long as the keyboard is up (`.has-keyboard .chat__turn >
 * .chat__meta` in `chat.css`) and comes back the moment the keyboard drops.
 *
 * These tests pin the trade: the 44px goes to the transcript both ways, the
 * copy buttons are back when the keyboard is gone, and the lane-level status
 * row — which is not a turn footer and is the only status a reader of a failed
 * read has — is not swept up by the rule.
 *
 * The bridge is mocked at the HTTP boundary, as the other browser suites do:
 * nothing here may reach a real pane.
 */

// The keyboard only changes the layout on a coarse, tall frame.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

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

/** One question, then an answer long enough to outgrow the lane under the keyboard. */
const SNAPSHOT = [
  "\u001b[48;2;42;42;42m❭ picker 现在到哪一步了\u001b[0m",
  "",
  " 三件事都落了地，只剩菜单的键盘导航。",
  "",
  ...Array.from(
    { length: 24 },
    (_, row) => ` 第 ${row + 1} 条：菜单每一行保持 44px，拇指往上抬就能点到，也不挡住上面那行。`,
  ),
].join("\n");

async function installBridge(page: Page, text: string): Promise<void> {
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
        text,
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

/*
 * Lip service to the keyboard, the same way `landscape-keyboard.spec.ts` does
 * it: the browser cannot open one, so the visual viewport is told to be
 * shorter and the composer's own effect publishes `--kb-inset` and
 * `has-keyboard` from what it measures.
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
}

/**
 * How many pixels of blank sit between the end of the answer and the lane's
 * bottom edge, sitting where a reader parks: scrolled all the way down.
 */
async function bottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lane = document.querySelector<HTMLElement>(".chat__lane");
    if (lane === null) {
      return -1;
    }
    lane.scrollTop = lane.scrollHeight;
    const last = [...lane.querySelectorAll<HTMLElement>(".chat__prose")].pop();
    if (last === undefined) {
      return -1;
    }
    return Math.round(lane.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
  });
}

const footer = (page: Page) => page.locator(".chat__turn .chat__meta");

test("the turn footer steps aside for the keyboard and comes back", async ({ page }) => {
  await installBridge(page, SNAPSHOT);
  await page.goto("/");
  await expect(footer(page)).toBeVisible();

  // The coarse floor is what makes this row expensive: two formats, 44px each.
  await expect(footer(page).locator(".chat__acts button")).toHaveCount(2);
  const resting = await bottomGap(page);
  expect(resting, "a footer's worth of lane, plus the lane's own padding").toBeGreaterThan(44);

  await keyboard(page, 300);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);

  // Gone, not squashed: 44px of transcript instead of a 44px row of copy
  // buttons. What is left below the answer is the lane's own 8px.
  await expect(footer(page)).toBeHidden();
  const typing = await bottomGap(page);
  expect(typing, "the answer reaches the lane's bottom edge").toBeLessThanOrEqual(16);
  expect(resting - typing, "exactly the row that left").toBeGreaterThanOrEqual(44);

  // And it is a keyboard state, not a one-way trip: the buttons return.
  await keyboard(page, 0);
  await expect(page.locator("html")).not.toHaveClass(/has-keyboard/);
  await expect(footer(page)).toBeVisible();
  await expect(footer(page).locator(".chat__acts button")).toHaveCount(2);
  expect(await bottomGap(page)).toBe(resting);
});

test("the failed-read row is not a turn footer", async ({ page }) => {
  await installBridge(page, SNAPSHOT);
  // A read that paints nothing, then a daemon that stops answering: no turns
  // are ever built, so the only status on screen is the lane's own row.
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  let reads = 0;
  await page.route("**/api/v1/herdr/panes/*/read*", (route) => {
    reads += 1;
    if (reads === 1) {
      return route.fulfill(
        json({
          paneId: PANE.id,
          source: "recent",
          format: "ansi",
          text: "",
          revision: 1,
          truncated: false,
          agentStatus: "idle",
        }),
      );
    }
    // Not a 500: `readPane` lets a thrown GET escape and the poll loop dies
    // with it. A 200 that does not parse is what the hook treats as a miss.
    return route.fulfill(json({}));
  });
  await page.goto("/");
  const lane = page.locator(".chat__lane > .chat__meta");
  await expect(lane).toHaveText(/daemon unreachable/);
  await expect(page.locator(".chat__turn")).toHaveCount(0);

  // The keyboard takes the turn footer away, not the reader's status line:
  // this row is the only thing on screen that says the snapshot is stale.
  await keyboard(page, 300);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  await expect(lane).toBeVisible();
});

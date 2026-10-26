import { expect, test, type Page } from "@playwright/test";

/*
 * The row of answer chips under a blocked agent.
 *
 * A menu can be longer than the phone is wide: six answers are 1 169px of chips
 * in a 390px row, so the row scrolls sideways. Two things follow from that and
 * both used to be wrong. The chip's 44px hit skirt was clipped by the row's own
 * overflow, so the target was 40px and the band below the face belonged to the
 * esc key; and the chip at the screen edge was cut mid-glyph with nothing to
 * say there was more of it. These tests pin the whole target, the fading edge
 * that replaces the cut, and the tap that a thumb actually lands.
 *
 * The bridge is mocked at the HTTP boundary, as the other browser suites do:
 * these taps must never reach a real pane.
 */

// The chips only exist on a phone's transcript lens, and a thumb is coarse:
// both matter to the row's geometry, so the whole file runs as a touch device.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

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

const ANSWERS = [
  "Yes, run the tests",
  "No, stop here",
  "Show me the diff first",
  "Allow once",
  "Always allow in this repo",
  "Deny and report the branch",
];

/** A blocked agent's snapshot: the menu as the pane painted it. */
function menu(answers: string[]): string {
  const rows = answers.map((label, index) => `❯ ${index + 1}. ${label}`);
  return ["Ask.", "", ...rows, "esc to cancel · enter to confirm", ""].join("\n");
}

/** The pane's write routes, so a tap can be read back as the key it sent. */
async function installBridge(page: Page, snapshot: string): Promise<string[]> {
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
        text: snapshot,
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

/** Raise the keyboard the way `PromptBar` reports one, without a real one. */
async function keyboardUp(page: Page, inset: number): Promise<void> {
  await page.evaluate((px) => {
    document.documentElement.style.setProperty("--kb-inset", `${px}px`);
    document.documentElement.classList.add("has-keyboard");
  }, inset);
}

/**
 * A blocked pane opens on the transcript lens; the chips only exist there.
 * Storing the choice before the module reads it is how the shell is told.
 */
async function openChat(page: Page, width: number, height: number, inset: number) {
  const keyPosts = await installBridge(page, menu(ANSWERS));
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("herdr:lens:w2:p1", "chat");
    } catch {
      /* the shell falls back to the pane's own default */
    }
  });
  await page.goto("/");
  await expect(page.locator(".chat__pickopt").first()).toBeVisible();
  if (inset > 0) {
    await keyboardUp(page, inset);
    // The composer re-fits against the shorter frame; the chips must survive it.
    await page.waitForTimeout(120);
  }
  return keyPosts;
}

/** The row's box, its chips, and whether either edge still has answers behind it. */
async function shape(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".chat__pick");
    const chips = Array.from(document.querySelectorAll<HTMLElement>(".chat__pickopt"));
    if (row === null || chips.length === 0) {
      return null;
    }
    const box = row.getBoundingClientRect();
    const first = chips[0].getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      row: { top: box.top, bottom: box.bottom, height: box.height, width: box.width },
      chip: { top: first.top, bottom: first.bottom, height: first.height, left: first.left },
      scroll: {
        left: row.scrollLeft,
        max: row.scrollWidth - row.clientWidth,
        width: row.scrollWidth,
      },
      classList: row.className,
      mask: style.maskImage || style.webkitMaskImage || "none",
      lane: document.querySelector<HTMLElement>(".chat__lane")?.getBoundingClientRect().height ?? 0,
    };
  });
}

test.describe("answer chips on a phone", () => {
  test("the row pays for a 44px target down to the key bar", async ({ page }) => {
    await openChat(page, 390, 844, 336);
    const measured = await shape(page);
    expect(measured).not.toBeNull();
    // The face stays 32px; the row is 6 + 32 + 6 so the skirt has somewhere to go.
    expect(measured!.chip.height).toBeLessThanOrEqual(34);
    expect(measured!.row.height).toBeGreaterThanOrEqual(44);
    expect(measured!.row.height).toBeLessThanOrEqual(46);

    // A thumb that lands in the padding band must get the chip, not the key bar:
    // both bands are inside the skirt, and the bar starts at the row's bottom.
    const hits = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".chat__pick")!;
      const chip = document.querySelector<HTMLElement>(".chat__pickopt")!;
      const box = row.getBoundingClientRect();
      const face = chip.getBoundingClientRect();
      const x = face.left + Math.min(24, face.width / 2);
      const at = (y: number) =>
        document.elementFromPoint(x, y)?.closest(".chat__pickopt") !== null;
      return {
        top: at(box.top + 1),
        bottom: at(box.bottom - 1),
        face: at(face.top + face.height / 2),
      };
    });
    expect(hits).toEqual({ top: true, bottom: true, face: true });
    // Snapping must not eat the row's lead-in: at rest the first chip keeps its
    // 12px of breathing room and the row reads as untouched, not as scrolled.
    expect(measured!.scroll.left).toBe(0);
    expect(measured!.chip.left).toBeGreaterThanOrEqual(8);
  });

  test("the edge that still has answers fades instead of cutting a chip", async ({ page }) => {
    await openChat(page, 390, 844, 336);
    const rest = await shape(page);
    expect(rest).not.toBeNull();
    // Six answers do not fit, so the right edge has more behind it and left has none.
    expect(rest!.scroll.width).toBeGreaterThan(rest!.row.width);
    expect(rest!.classList).toContain("chat__pick--more");
    expect(rest!.classList).not.toContain("chat__pick--back");
    expect(rest!.mask).not.toBe("none");

    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".chat__pick")!;
      row.scrollLeft = row.scrollWidth;
    });
    await expect(page.locator(".chat__pick--back")).toBeVisible();
    const end = await shape(page);
    // At the end the answer behind the reader is on the left, and the last chip
    // sits inside the row instead of being sliced by the screen edge.
    expect(end!.classList).toContain("chat__pick--back");
    expect(end!.classList).not.toContain("chat__pick--more");
    expect(end!.mask).not.toBe("none");
    expect(end!.mask).not.toBe(rest!.mask);
    const last = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll<HTMLElement>(".chat__pickopt"));
      const box = chips[chips.length - 1].getBoundingClientRect();
      return { right: box.right, width: innerWidth };
    });
    expect(last.right).toBeLessThanOrEqual(last.width - 8);
  });

  test("a tap on the skirt answers with that option's number", async ({ page }) => {
    const keyPosts = await openChat(page, 390, 844, 336);
    const target = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".chat__pick")!;
      const chip = document.querySelector<HTMLElement>(".chat__pickopt")!;
      const box = row.getBoundingClientRect();
      const face = chip.getBoundingClientRect();
      // The low band of the skirt: under the face, above the key bar.
      return { x: face.left + Math.min(24, face.width / 2), y: box.bottom - 3 };
    });
    await page.touchscreen.tap(target.x, target.y);
    await expect.poll(() => keyPosts.join("|")).toContain('"keys"');
    expect(keyPosts.join("|")).toContain('"1"');
  });

  test("the transcript keeps room on the smallest phone with the keyboard up", async ({
    page,
  }) => {
    await openChat(page, 320, 568, 260);
    const measured = await shape(page);
    expect(measured).not.toBeNull();
    // Two rows of facts have to stay readable above the answers; 100px is the
    // floor this frame is held to, not a comfortable number.
    expect(measured!.lane).toBeGreaterThanOrEqual(100);
    expect(measured!.row.bottom).toBeLessThanOrEqual(320 + 568);
  });
});

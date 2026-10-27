import { expect, test, type Page } from "@playwright/test";

/*
 * The lens switch while the soft keyboard is up.
 *
 * Raising the keyboard used to take the whole head row away (`.has-keyboard
 * .stage__head { display: none }`), and the switch went with it: at the one
 * moment a thumb is most likely to want the other lens — mid-sentence, looking
 * at a menu it cannot read in a document — the only control that flips lenses
 * was gone. Putting the row back in the flow would cost the lane 46px of the
 * 197px a 320x568 phone has left while typing, so the row instead leaves the
 * flow and floats over the pane strip, which is 37px tall and already holds
 * only the focused pane's name.
 *
 * These tests pin the trade: no height back from the lane, a target that a
 * thumb can hit inside the strip's own band, the strip left of the overlay
 * still scratchable, and a flip that does not blur the composer.
 *
 * The bridge is mocked at the HTTP boundary, as the other browser suites do:
 * these taps must never reach a real pane.
 */

// The keyboard only changes the layout on a coarse, tall frame, and a thumb is
// coarse: without this the media queries do not match and tap() has no touch.
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

/** A blocked agent's snapshot: the menu as the pane painted it. */
const SNAPSHOT = [
  "Ask.",
  "",
  "❯ 1. Yes, run the tests",
  "❯ 2. No, stop here",
  "esc to cancel · enter to confirm",
  "",
].join("\n");

async function installBridge(page: Page): Promise<void> {
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
        text: SNAPSHOT,
        revision: 2,
        truncated: false,
        agentStatus: "blocked",
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) =>
    route.fulfill(json({ ok: true })),
  );
  await page.route("**/api/v1/herdr/panes/*/input", (route) =>
    route.fulfill(json({ ok: true })),
  );
}

/**
 * Raise the keyboard the way a browser does it: the window keeps its height and
 * only the *visual* viewport shrinks. Short-cutting that difference by setting
 * `--kb-inset` by hand is a trap — `PromptBar` also caps the composer against
 * the visual viewport, so an unshimmed frame measures the cap against the full
 * window and the composer grows far past what a real keyboard leaves. One lie
 * (the viewport height), then the shell's own code does the rest: the inset, the
 * class, the grid reflow and the composer re-fit all run for real.
 */
async function keyboardUp(page: Page, inset: number): Promise<void> {
  await page.evaluate((px) => {
    const vv = window.visualViewport;
    if (vv === null) {
      return;
    }
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    vv.dispatchEvent(new Event("resize"));
  }, inset);
  await expect(page.locator("html")).toHaveClass(/has-keyboard/);
  const published = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--kb-inset").trim(),
  );
  expect(published).toBe(`${inset}px`);
  // The composer re-fits against the shorter frame; the strip must survive it.
  await page.waitForTimeout(120);
}

/** Put the keyboard away again, the way a dismissal reports itself. */
async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv !== null) {
      // Dropping the shim brings back the browser's own getter.
      delete (vv as unknown as Record<string, unknown>).height;
      vv.dispatchEvent(new Event("resize"));
    }
  });
  await expect(page.locator("html")).not.toHaveClass(/has-keyboard/);
  await page.waitForTimeout(120);
}

/**
 * Open a lens on a phone frame with the composer focused, optionally with the
 * keyboard up. Storing the lens before the module reads it is how the shell is
 * told which one to open; focusing the composer first is what makes the soft
 * keyboard's rise realistic, since it is the composer that raises it.
 */
async function openLens(
  page: Page,
  frame: { width: number; height: number; inset: number; lens?: string },
) {
  const { width, height, inset, lens = "chat" } = frame;
  await installBridge(page);
  await page.setViewportSize({ width, height });
  await page.addInitScript((which) => {
    try {
      localStorage.setItem("herdr:lens:w2:p1", which);
    } catch {
      /* the shell falls back to the pane's own default */
    }
  }, lens);
  await page.goto("/");
  await expect(page.locator(".lens__switch")).toBeVisible();
  await page.locator(".prompt__input").click();
  await expect(page.locator(".prompt__input")).toBeFocused();
  if (inset > 0) {
    await keyboardUp(page, inset);
  }
}

/** The head, the strip it floats over, and what a thumb actually gets. */
async function overlay(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector<HTMLElement>(".stage--lens .stage__head");
    const strip = document.querySelector<HTMLElement>(".stage--lens > .strip");
    const sw = document.querySelector<HTMLElement>(".lens__switch");
    const opt = document.querySelector<HTMLElement>(".lens__opt");
    if (head === null || strip === null || sw === null || opt === null) {
      return null;
    }
    const headBox = head.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const choice = sw.getBoundingClientRect();
    const face = opt.getBoundingClientRect();
    const lane = document.querySelector<HTMLElement>(".lens")?.getBoundingClientRect();
    const headStyle = getComputedStyle(head);
    const stripStyle = getComputedStyle(strip);
    const centreX = choice.left + choice.width / 2;
    const centreY = face.top + face.height / 2;
    /** Does the switch own this point, or does it fall through to what is under it? */
    const hits = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest(".lens__opt") !== null;
    const newTab = document.querySelector<HTMLElement>(".tab--new");
    return {
      head: {
        top: headBox.top,
        height: headBox.height,
        width: headBox.width,
        right: innerWidth - headBox.right,
        position: headStyle.position,
        pointerEvents: headStyle.pointerEvents,
      },
      strip: {
        top: stripBox.top,
        bottom: stripBox.bottom,
        height: stripBox.height,
        reserve: parseFloat(stripStyle.paddingRight),
        snap: parseFloat(stripStyle.scrollPaddingRight),
      },
      switch: {
        left: choice.left,
        right: choice.right,
        rightGap: innerWidth - choice.right,
        top: choice.top,
        bottom: choice.bottom,
        width: choice.width,
        height: choice.height,
      },
      face: { width: face.width, height: face.height },
      laneTop: lane?.top ?? -1,
      // The band above and below the face, and the four edges of it. The row's
      // last pixel is the strip's own hairline, so the probe stops 3px short of
      // its bottom edge -- that is where a thumb's centre lands, not the line.
      band: {
        top: hits(centreX, stripBox.top + 1),
        bottom: hits(centreX, stripBox.bottom - 3),
        left: hits(face.left + 2, centreY),
        right: hits(face.right - 2, centreY),
        face: hits(centreX, centreY),
      },
      // The strip just left of the overlay must belong to the strip, not to the
      // invisible rest of the head row: tabs there are still tappable.
      passthrough:
        document
          .elementFromPoint(choice.left - 24, stripBox.top + stripBox.height / 2)
          ?.closest(".stage__head") === null,
      newTab: newTab === null ? "missing" : getComputedStyle(newTab).display,
      pick: document.querySelector<HTMLElement>(".stage__pick")?.offsetParent !== null,
    };
  });
}

test.describe("the lens switch while typing", () => {
  test("the head floats over the strip instead of costing the lane a row", async ({
    page,
  }) => {
    await openLens(page, { width: 390, height: 844, inset: 336 });
    const measured = await overlay(page);
    expect(measured).not.toBeNull();

    // Out of the flow: the strip is the top of the stage and the lane starts at
    // the strip's bottom edge, so nothing was taken from the transcript.
    expect(measured!.head.position).toBe("absolute");
    expect(measured!.head.height).toBe(36);
    expect(measured!.strip.top).toBe(0);
    expect(measured!.laneTop).toBeCloseTo(measured!.strip.bottom, 0);

    // Centred in the strip's band, inside it on both sides, flush to the same
    // 10px the strip's own tab column leaves.
    expect(measured!.switch.top).toBeGreaterThanOrEqual(measured!.strip.top);
    expect(measured!.switch.bottom).toBeLessThanOrEqual(measured!.strip.bottom);
    expect(measured!.head.right).toBe(0);
    expect(measured!.switch.rightGap).toBeCloseTo(10, 0);

    // The rest of the head is not a second copy of the screen, and the strip's
    // pinned `+` steps aside for the one control that is useful mid-typing.
    expect(measured!.pick).toBe(false);
    expect(measured!.newTab).toBe("none");

    // The strip keeps the switch's width free on its trailing edge, so the last
    // tab can still be dragged out from under the overlay.
    expect(measured!.strip.reserve).toBeGreaterThanOrEqual(
      measured!.switch.width + 8,
    );
    expect(measured!.strip.snap).toBeGreaterThanOrEqual(measured!.switch.width);
  });

  test("the switch keeps a thumb-sized target without swallowing the tabs", async ({
    page,
  }) => {
    await openLens(page, { width: 390, height: 844, inset: 336 });
    const measured = await overlay(page);
    expect(measured).not.toBeNull();

    // A 26px face in a 36px row cannot reach 44px without bleeding into the
    // transcript's first line and the terminal's find button, which share this
    // corner. 34px is what the row's own band allows, and it must be all live:
    // the top and bottom hairlines still hit the option, not the strip.
    expect(measured!.face.height).toBeLessThanOrEqual(26);
    expect(measured!.band).toEqual({
      top: true,
      bottom: true,
      left: true,
      right: true,
      face: true,
    });
    expect(measured!.strip.height - 1).toBeGreaterThanOrEqual(34);

    // Left of the overlay the strip is still the strip: `pointer-events: none`
    // on the head's box is what keeps tab scrolls from dying there.
    expect(measured!.head.pointerEvents).toBe("none");
    expect(measured!.passthrough).toBe(true);
  });

  test("a flip mid-sentence keeps the keyboard and the caret", async ({ page }) => {
    await openLens(page, { width: 390, height: 844, inset: 336 });
    await page.keyboard.type("run the");

    // The flip is a tap with a thumb: it must not blur the composer, or the
    // keyboard would fold away the moment it was used.
    await page.getByRole("button", { name: "term", exact: true }).tap();
    await expect(page.locator(".lens")).toHaveAttribute("data-lens", "terminal");
    await expect(page.locator("html")).toHaveClass(/has-keyboard/);
    await expect(page.locator(".prompt__input")).toBeFocused();

    // And the next keystroke still lands in the draft, not in the terminal.
    await page.keyboard.type("!");
    await expect(page.locator(".prompt__input")).toHaveValue("run the!");
  });

  test("putting the keyboard away puts the head back in the row", async ({
    page,
  }) => {
    await openLens(page, { width: 390, height: 844, inset: 336 });
    await keyboardDown(page);
    const measured = await overlay(page);
    expect(measured).not.toBeNull();

    // The overlay is a keyboard-time remedy only: with the keyboard down the
    // head is back in the flow, and `+` is back in the strip. The row is 41px
    // rather than 46: the phone-chrome pass traded 5px of head for 5px of
    // transcript on the screen that has the least of it, and a thumb still gets
    // 40px of box (the 41 is the box plus its hairline).
    expect(measured!.head.position).toBe("static");
    expect(measured!.head.height).toBe(41);
    expect(measured!.strip.top).toBeGreaterThanOrEqual(measured!.head.height);
    expect(measured!.newTab).not.toBe("none");
    expect(measured!.strip.reserve).toBe(0);
    // And the switch is a child of that row again, not a floating copy of it.
    expect(measured!.switch.top).toBeGreaterThanOrEqual(measured!.head.top);
    expect(measured!.switch.bottom).toBeLessThanOrEqual(
      measured!.head.top + measured!.head.height,
    );
  });

  test("the smallest phone still gets both lenses while typing", async ({ page }) => {
    await openLens(page, { width: 320, height: 568, inset: 260 });
    const measured = await overlay(page);
    expect(measured).not.toBeNull();

    // 320 - 10 - 96 = 214: the strip's usable edge. The switch must not reach
    // past it, or its skirt would hang over the screen edge.
    expect(measured!.switch.right).toBeLessThanOrEqual(320 - 10);
    expect(measured!.switch.right).toBeGreaterThanOrEqual(320 - 20);
    expect(measured!.strip.reserve).toBeGreaterThanOrEqual(96);
    expect(measured!.laneTop).toBeCloseTo(measured!.strip.bottom, 0);
    expect(measured!.strip.height - 1).toBeGreaterThanOrEqual(34);
    expect(measured!.newTab).toBe("none");
  });

  test("a five-line draft keeps the key row above the composer", async ({ page }) => {
    await openLens(page, { width: 320, height: 568, inset: 260 });

    // Six lines, so the composer hits its cap and scrolls: this is the tallest
    // the card can get on a phone, and the worst case for everything above it.
    const input = page.locator(".prompt__input");
    await input.fill("line 1\nline 2\nline 3\nline 4\nline 5\nline 6");
    await page.waitForTimeout(160);

    const stack = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          paddingTop: parseFloat(style.paddingTop),
          paddingBottom: parseFloat(style.paddingBottom),
        };
      };
      return {
        viewport: window.visualViewport?.height ?? -1,
        shell: box(".shell"),
        strip: box(".stage--lens > .strip"),
        lane: box(".chat__lane"),
        pick: box(".chat__pick"),
        keys: box(".chat .keys"),
        prompt: box(".prompt"),
        input: box(".prompt__input"),
        scrolls: getComputedStyle(document.querySelector<HTMLElement>(".prompt__input")!).overflowY,
      };
    });

    // The card is capped and scrolls rather than growing to the whole screen.
    expect(stack.scrolls).toBe("auto");
    expect(stack.input!.height).toBeLessThanOrEqual(120);

    // At this frame the lens is under 167px once the composer hits its cap, so
    // the answer card is what fills it and the key row is not stacked above the
    // composer at all: its esc and enter are folded into the answers row. What
    // still holds is the old bug's invariant — no row may paint under the
    // composer, and what is shown stacks in order straight onto it.
    expect(stack.keys!.height, "the card folds the key row away").toBe(0);
    expect(stack.lane!.bottom).toBeCloseTo(stack.pick!.top, 0);
    expect(stack.pick!.bottom).toBeCloseTo(stack.prompt!.top, 0);
    expect(stack.prompt!.bottom).toBeLessThanOrEqual(stack.viewport + 0.5);
    expect(stack.shell!.bottom).toBeCloseTo(stack.viewport, 0);

    // The air is what got cut, and only while typing: the transcript keeps a
    // sliver plus both rows, and the full padding comes back with the keyboard.
    expect(stack.lane!.height).toBeGreaterThanOrEqual(20);
    expect(stack.lane!.paddingTop).toBe(8);
    expect(stack.lane!.paddingBottom).toBe(8);

    // And the card is a keyboard state: with the keyboard down the lens is tall
    // again, the row is back above the composer and so is the lane's air.
    await keyboardDown(page);
    const restored = await page.evaluate(() => ({
      padding: parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>(".chat__lane")!).paddingTop,
      ),
      keys: document.querySelector<HTMLElement>(".chat .keys")!.getBoundingClientRect().height,
    }));
    // 12px, not the 20px this file was written against: the phone's density
    // block cuts the resting air above the transcript. What the assertion is
    // after is unchanged — the padding is back once the keyboard is gone, and
    // it is larger than the 8px the typing state uses.
    expect(restored.padding).toBe(12);
    expect(restored.keys).toBeGreaterThanOrEqual(40);
  });
});

import { expect, test, type Page } from "@playwright/test";

/*
 * What the key menu costs the terminal.
 *
 * The menu is deliberately in flow: opening it shrinks the terminal instead of
 * covering it, because the reason to reach for `↑`/`↓` is to watch the TUI
 * answer. That trade only works while there is a terminal left to watch. With
 * the soft keyboard up on a phone there was not: the menu stacked a header, a
 * two-row 16-key grid and the always-present quick bar on a `.term__host` that
 * has `min-height: 0`, so 320x568 with a 260px inset collapsed the host to 2px
 * and 844x390 landscape collapsed it to 0px — opening the menu hid the thing
 * the menu exists to poke.
 *
 * On coarse pointers under 700px the menu now folds into a single row while the
 * keyboard is up: one 40px grid row that scrolls sideways (the axis a landscape
 * phone has), a 44px `hide`, and only the `keys` toggle from the quick bar,
 * since the grid is a superset of it.
 *
 * The grid being a superset is also why the quick row steps aside while the
 * panel is open. The bar repeated six of the sixteen keys directly under the
 * panel, so on a tall phone the menu charged the terminal twice for the same
 * affordance. Closed, the bar keeps every key it always had — dropping keys
 * from it would leave a phone with no `esc` while the keyboard covers the
 * screen, which is how this bug looked the first time it was "fixed".
 *
 * `hide` is a 26x20 word in the head of every shape the portrait rule does not
 * reach, and it is the panel's only exit. A negative-inset pseudo-element gives
 * it a 44px tall target there instead of buying the head 24 more pixels of
 * terminal; the grid wins the few pixels where the two would overlap, so the
 * skirt only reaches about 3px into the bottom edge of the pane.
 *
 * The soft keyboard is simulated the way the composer detects it: `--kb-inset`
 * on the root plus `has-keyboard`, which is what `PromptBar` sets from
 * `visualViewport`.
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

const height = async (page: Page, selector: string): Promise<number> => {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return Math.round(rect.height);
};

/** How the grid lays out: rows on screen, key count, the scroll it needs. */
async function gridShape(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector(".keys--grid") as HTMLElement | null;
    if (grid === null) throw new Error("no key grid");
    const keys = Array.from(grid.querySelectorAll<HTMLElement>(".keys__key"));
    const tops = new Set(keys.map((key) => Math.round(key.getBoundingClientRect().top)));
    return {
      rows: tops.size,
      keys: keys.length,
      boxHeight: Math.round(grid.getBoundingClientRect().height),
      scrollWidth: grid.scrollWidth,
      clientWidth: grid.clientWidth,
      scrollLeft: grid.scrollLeft,
      firstKeyX: Math.round(keys[0].getBoundingClientRect().x),
      gridX: Math.round(grid.getBoundingClientRect().x),
    };
  });
}

/** How the closed quick bar looks: its keys, their faces, whether it is there. */
async function barShape(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".keymenu > .keys:not(.keys--grid)") as HTMLElement | null;
    if (bar === null) throw new Error("no quick bar");
    const faces = Array.from(bar.querySelectorAll<HTMLElement>(".keys__key"));
    return {
      display: getComputedStyle(bar).display,
      labels: faces.map((face) => (face.textContent ?? "").trim()),
      faceHeight: Math.round(Math.min(...faces.map((face) => face.getBoundingClientRect().height))),
    };
  });
}

test.describe("phone on its side, keyboard up, key menu open", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("folds to one row and leaves the terminal visible", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    // iOS landscape keyboard: 390 - 210 = 180px to draw in.
    await keyboardUp(page, 210);
    const hostTyping = await height(page, ".term__host");
    expect(hostTyping).toBeGreaterThan(0);

    // Closed, the bar is the whole menu and it is whole: every key it ships
    // with, at a thumb-sized face. Hiding the row while the panel is open is
    // only legitimate if the panel is an addition, not a replacement.
    const closed = await barShape(page);
    expect(closed.display).toBe("flex");
    expect(closed.labels).toEqual(["esc", "tab", "ctrl", "^C", "↑", "↵"]);
    expect(closed.faceHeight).toBeGreaterThanOrEqual(40);
    // The row itself is the tap band: 40px faces plus their padding.
    expect(await height(page, ".keymenu > .keys:not(.keys--grid)")).toBeGreaterThanOrEqual(44);

    await page.locator(".keys__more").first().tap();
    await expect(page.locator(".keys--grid")).toBeVisible();

    // The menu still costs height, but what is left is a terminal, not a sliver:
    // before the fold this measured 0px and the pane was simply gone.
    const hostOpen = await height(page, ".term__host");
    expect(hostOpen).toBeGreaterThanOrEqual(40);
    expect(hostOpen).toBeLessThanOrEqual(hostTyping);

    // One row of 16 keys, and they fit the width here, so no hunting sideways.
    const shape = await gridShape(page);
    expect(shape.rows).toBe(1);
    expect(shape.keys).toBe(16);
    expect(shape.boxHeight).toBe(40);
    expect(shape.scrollWidth).toBeLessThanOrEqual(shape.clientWidth + 1);

    // Open, the quick row is gone: the grid already holds all of it, and here
    // the two sat side by side in an 844px row and left the grid 46px narrower.
    expect(await page.locator(".keymenu > .keys:not(.keys--grid)").isVisible()).toBe(false);
    expect(await height(page, ".keymenu__hide")).toBeGreaterThanOrEqual(44);

    // The row sits between the pane and the composer, not over either: the menu
    // lives below the terminal inside the lens, so the host ends where the menu
    // starts and the lens ends where the composer begins.
    const host = await page.locator(".term__host").first().boundingBox();
    const prompt = await page.locator(".prompt").first().boundingBox();
    const menu = await page.locator(".keymenu").first().boundingBox();
    if (host === null || prompt === null || menu === null) throw new Error("missing box");
    expect(Math.round(menu.y)).toBe(Math.round(host.y + host.height));
    expect(Math.round(menu.y + menu.height)).toBe(Math.round(prompt.y));

    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(390);

    await page.locator(".keymenu__hide").tap();
    await expect(page.locator(".keys--grid")).toHaveCount(0);
    expect(await height(page, ".term__host")).toBeCloseTo(hostTyping, 0);
    // Closed again, the bar is back — with its keys, still thumb-sized.
    const reopened = await barShape(page);
    expect(reopened.display).toBe("flex");
    expect(reopened.labels).toEqual(closed.labels);
  });
});

test.describe("small phone upright, keyboard up, key menu open", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  test("keeps the terminal and every key reachable", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    await keyboardUp(page, 260);
    expect((await barShape(page)).faceHeight).toBeGreaterThanOrEqual(40);
    await page.locator(".keys__more").first().tap();
    await expect(page.locator(".keys--grid")).toBeVisible();
    // The quick row is the grid's duplicate, so it does not stack under it.
    expect(await page.locator(".keymenu > .keys:not(.keys--grid)").isVisible()).toBe(false);

    // Before the fold this was 2px: the menu and the quick bar together owned
    // more height than the frame had to give.
    expect(await height(page, ".term__host")).toBeGreaterThanOrEqual(40);

    const shape = await gridShape(page);
    expect(shape.rows).toBe(1);
    expect(shape.keys).toBe(16);
    expect(shape.boxHeight).toBe(40);

    // 16 keys do not fit 320px, so the grid must scroll — and the first key has
    // to be *at* the scroll origin, not past it. The bar centres its keys, and a
    // centred grid whose tracks overflow pushes the leading keys off the start
    // edge, where no swipe can reach them (esc measured at x=-237, scrollLeft 0).
    expect(shape.scrollLeft).toBe(0);
    expect(shape.firstKeyX).toBeGreaterThanOrEqual(shape.gridX - 1);
    expect(shape.scrollWidth).toBeGreaterThan(shape.clientWidth);

    // The whole row is one swipe away from its last key.
    const lastKey = page.locator(".keys--grid .keys__key").last();
    await expect(lastKey).toHaveText("PgDn");
    await page.evaluate(() => {
      const grid = document.querySelector(".keys--grid") as HTMLElement;
      grid.scrollLeft = grid.scrollWidth;
    });
    const last = await lastKey.boundingBox();
    const grid = await page.locator(".keys--grid").boundingBox();
    if (last === null || grid === null) throw new Error("missing box");
    expect(last.x).toBeGreaterThanOrEqual(grid.x - 1);
    expect(last.x + last.width).toBeLessThanOrEqual(grid.x + grid.width + 1);

    // Nothing spills out of the frame.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(568);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});

test.describe("tall phone upright, key menu open", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("keeps the two-row grid: there is height to spare", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    await keyboardUp(page, 336);
    const hostTyping = await height(page, ".term__host");
    await page.locator(".keys__more").first().tap();
    await expect(page.locator(".keys--grid")).toBeVisible();

    // Folding is a remedy for a short frame, not a new look for tall ones.
    const shape = await gridShape(page);
    expect(shape.rows).toBe(2);
    expect(shape.boxHeight).toBeGreaterThan(40);
    const hostOpen = await height(page, ".term__host");
    expect(hostOpen).toBeGreaterThanOrEqual(120);

    // Opening costs the two-row panel and nothing on top of it: the quick row
    // it used to keep underneath was 40px of terminal bought twice. Measured
    // 353 -> 246 before this, i.e. the panel (151) plus the row (40) came out
    // of a menu that only needs 151.
    expect(hostTyping - hostOpen).toBeLessThanOrEqual(110);
  });
});

test.describe("phone on its side, keyboard down, key menu open", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("the 20px head still gives `hide` a thumb-sized target", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator("#herdr-input")).toBeVisible();

    // Keyboard away: no fold media query reaches this frame, so the head is the
    // plain 20px one and `hide` is a 26x20 word. It is still the only exit.
    await page.locator(".keys__more").first().tap();
    await expect(page.locator(".keys--grid")).toBeVisible();
    const reach = await page.evaluate(() => {
      const hide = document.querySelector(".keymenu__hide");
      if (hide === null) throw new Error("no hide");
      const box = hide.getBoundingClientRect();
      const centreX = box.x + box.width / 2;
      const centreY = box.y + box.height / 2;
      const hits = (y: number) => {
        const element = document.elementFromPoint(centreX, y);
        return element !== null && element.closest(".keymenu__hide") !== null;
      };
      let top = centreY;
      let bottom = centreY;
      for (let y = centreY; y >= box.y - 20; y -= 1) {
        if (!hits(y)) break;
        top = y;
      }
      for (let y = centreY; y <= box.y + box.height + 20; y += 1) {
        if (!hits(y)) break;
        bottom = y;
      }
      const cc = document.querySelectorAll(".keys--grid .keys__key")[7];
      const keyBox = cc.getBoundingClientRect();
      return {
        face: Math.round(box.height),
        target: Math.round(bottom - top) + 1,
        // The skirt must not eat the last grid column's first key, which is the
        // one it would reach: it sits at the top edge, inside the skirt's span.
        onKey: document
          .elementFromPoint(keyBox.x + keyBox.width / 2, keyBox.y + 2)
          ?.closest(".keys__key")
          ?.textContent?.trim(),
      };
    });
    expect(reach.face).toBeLessThan(44);
    expect(reach.target).toBeGreaterThanOrEqual(44);
    expect(reach.onKey).toBe("^C");
  });
});

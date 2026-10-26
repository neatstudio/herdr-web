import { expect, test, type Page } from "@playwright/test";

/*
 * Long lines in a fenced block inside a narrow transcript.
 *
 * `web/src/chat.css` gives `.chat__code-body` and `.chat__pre` `white-space:
 * pre` with a sideways scroll, so a 938px line in a 390px frame is not lost —
 * but nothing on screen says it continues. The panel edge cuts the glyph in
 * half, which reads as the end of the line, and there is no scrollbar on a
 * phone to argue otherwise. Measured before the fade existed: a 366px block
 * holding a 938px line, `scrollWidth - clientWidth` = 572px with no visible
 * affordance at all.
 *
 * The fade is the convention `.chat__pick` already uses one layer up: the block
 * reports which sides still have text and CSS masks exactly that edge. These
 * tests pin the three states (right, both, left), the state that must not exist
 * (a block that fits says nothing), and that masking never changes the box.
 */

const LONG =
  "const handler = async (req, res) => { const body = await readJson(req); return res.json({ ok: true, body }); };";
const READ = [
  "Here is the patch.",
  "",
  "```ts",
  LONG,
  "```",
  "",
  "Run it:",
  "",
  "```",
  "npm test",
  "```",
  "",
].join("\n");

async function installBridge(page: Page): Promise<void> {
  const pane = {
    id: "w2:p1",
    workspaceId: "w2",
    tabId: "w2:t1",
    focused: true,
    cwd: "/tmp/api",
    agentStatus: "idle",
    terminalTitle: "shell",
  };
  const workspace = {
    id: "w2",
    name: "api",
    windows: 1,
    attached: true,
    paneCount: 1,
    agentStatus: "idle",
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
        text: READ,
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

/** The block with the long line; the second block fits and must stay quiet. */
const longBlock = (page: Page) => page.locator(".chat__code-body").first();
const fitsBlock = (page: Page) => page.locator(".chat__code-body").nth(1);

const edgesOf = (page: Page, index: number) =>
  page.evaluate((i) => {
    const block = document.querySelectorAll<HTMLElement>(".chat__code-body")[i];
    return block === undefined ? null : (block.dataset.edges ?? "");
  }, index);

const maskOf = (page: Page, index: number) =>
  page.evaluate((i) => {
    const block = document.querySelectorAll<HTMLElement>(".chat__code-body")[i];
    if (block === undefined) {
      return null;
    }
    const style = getComputedStyle(block);
    return style.maskImage === "" || style.maskImage === "none"
      ? "none"
      : style.maskImage.replace(/\s+/g, " ");
  }, index);

async function scrollBlockTo(page: Page, index: number, left: number): Promise<void> {
  await page.evaluate(
    ({ i, x }) => {
      const block = document.querySelectorAll<HTMLElement>(".chat__code-body")[i];
      if (block !== undefined) {
        block.scrollLeft = x;
      }
    },
    { i: index, x: left },
  );
}

const boxOf = (page: Page, index: number) =>
  page.evaluate((i) => {
    const block = document.querySelectorAll<HTMLElement>(".chat__code-body")[i];
    if (block === undefined) {
      return null;
    }
    const rect = block.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      clientWidth: block.clientWidth,
      scrollWidth: block.scrollWidth,
    };
  }, index);

test.describe("phone transcript", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a block wider than the frame keeps its right edge faded", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__code-body")).toHaveCount(2);

    const box = await boxOf(page, 0);
    expect(box).not.toBeNull();
    // The premise: there really is more line than frame.
    expect(box!.scrollWidth - box!.clientWidth).toBeGreaterThan(200);

    await expect.poll(() => edgesOf(page, 0)).toBe("more");
    const mask = await maskOf(page, 0);
    expect(mask).toContain("calc(100% - 36px)");
    // Right edge only: nothing fades on the left until the reader scrolls.
    expect(mask).not.toContain("22px");

    // The fade is a mask, not a wider box: the page still has no sideways
    // overflow of its own and the block keeps its width and height.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      await page.evaluate(() => window.innerWidth),
    );
    expect(box!.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  });

  test("a block that fits says nothing", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__code-body")).toHaveCount(2);

    const box = await boxOf(page, 1);
    expect(box!.scrollWidth).toBe(box!.clientWidth);
    expect(await edgesOf(page, 1)).toBe("");
    expect(await maskOf(page, 1)).toBe("none");
  });

  test("the middle of a long line fades both edges, the end only the left", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__code-body")).toHaveCount(2);
    await expect.poll(() => edgesOf(page, 0)).toBe("more");

    const box = await boxOf(page, 0);
    await scrollBlockTo(page, 0, Math.round((box!.scrollWidth - box!.clientWidth) / 2));
    await expect.poll(() => edgesOf(page, 0)).toBe("both");
    const both = await maskOf(page, 0);
    expect(both).toContain("22px");
    expect(both).toContain("calc(100% - 36px)");

    await scrollBlockTo(page, 0, box!.scrollWidth);
    await expect.poll(() => edgesOf(page, 0)).toBe("back");
    const back = await maskOf(page, 0);
    expect(back).toContain("22px");
    expect(back).not.toContain("calc(100% - 36px)");

    // Masking must not reflow the block while it is swiped.
    const after = await boxOf(page, 0);
    expect(after!.width).toBe(box!.width);
    expect(after!.height).toBe(box!.height);
    expect(after!.right).toBe(box!.right);

    await scrollBlockTo(page, 0, 0);
    await expect.poll(() => edgesOf(page, 0)).toBe("more");
  });
});

test.describe("narrow desktop frame", () => {
  test.use({ viewport: { width: 700, height: 800 }, hasTouch: false, isMobile: false });

  test("the same fade appears when a mouse-width frame is still narrow", async ({ page }) => {
    await installBridge(page);
    await page.goto("/");
    await expect(page.locator(".chat__code-body")).toHaveCount(2);

    const box = await boxOf(page, 0);
    expect(box!.scrollWidth - box!.clientWidth).toBeGreaterThan(100);
    await expect.poll(() => edgesOf(page, 0)).toBe("more");
    expect(await maskOf(page, 0)).toContain("calc(100% - 36px)");
  });
});

import { expect, test, type Page } from "@playwright/test";

/*
 * An answer that mentions eight values in eight fenced blocks.
 *
 * The live pane this is modelled on (`w6:p3`, Claude Code) printed 8 blocks in
 * one answer, every one of them 1-2 lines — a URL, a phrase, an address — and
 * the turn measured 1 543px on a 390px phone. None of that height was text: it
 * was a 26px head with a language label and a copy button, paid eight times.
 *
 * `lib/outputFold.ts` folds a block only when it is *short* and the answer
 * repeats the shape at least three times; the spec pins both halves of that
 * rule, the row's own contents, and that opening a row hands the original
 * fenced source back to `Markdown` instead of a reconstruction. The unfolded
 * case is the control: two short blocks must render exactly as before.
 */

/** The TUI writes the language on the *closing* fence line; this is that shape. */
const URL_BLOCK = ["```", "this console", "```text"].join("\n");
const CURL_BLOCK = ["```bash", "curl -s http://100.89.0.116:5000/status", "```"].join("\n");
const ADDR_BLOCK = ["```", "100.89.0.3:5000 (m8s)", "100.89.0.116:5000 up 3h", "```"].join("\n");

/** Eight content lines: a listing, not a mention, so it never folds. */
const LONG_BLOCK = [
  "```ts",
  "const app = express();",
  "app.get('/', (req, res) => {",
  "  res.json({ ok: true });",
  "});",
  "app.post('/keys', (req, res) => {",
  "  res.json({ ok: true });",
  "});",
  "app.listen(5000);",
  "console.log('up');",
  "```",
].join("\n");

function transcript(short: number): string {
  const blocks = [URL_BLOCK, CURL_BLOCK, ADDR_BLOCK].slice(0, short);
  const parts = ["Two places answer on that port.", ""];
  for (const block of blocks) {
    parts.push(block, "");
  }
  parts.push("The handler itself is unchanged:", "", LONG_BLOCK, "");
  return parts.join("\n");
}

async function installBridge(page: Page, text: string): Promise<void> {
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

const row = (page: Page, index: number) => page.locator(".out__row").nth(index);

test.describe("phone transcript", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("three short blocks fold to three rows and leave the long one alone", async ({ page }) => {
    await installBridge(page, transcript(3));
    await page.goto("/");
    await expect(page.locator(".out__row")).toHaveCount(3);
    // The long block is still a code panel, head, copy button and all.
    await expect(page.locator(".chat__code")).toHaveCount(1);
    await expect(page.locator(".chat__code-body")).toHaveText(/app\.listen\(5000\);/);
    // Its body is on screen; the folded ones' bodies are not — a closed row is
    // the preview and nothing else.
    await expect(page.locator(".chat__code-body")).toHaveCount(1);
    await expect(page.locator(".out__body")).toHaveCount(0);
  });

  test("a folded row says what it holds without being opened", async ({ page }) => {
    await installBridge(page, transcript(3));
    await page.goto("/");
    await expect(page.locator(".out__row")).toHaveCount(3);

    // The TUI's bare-open/text-close block reads as `text`; the bash block as
    // `bash`. A one-line block prints no count — its line is already the
    // preview — and the two-line block does.
    await expect(row(page, 0).locator(".out__lang")).toHaveText("text");
    await expect(row(page, 0).locator(".out__count")).toHaveCount(0);
    await expect(row(page, 0).locator(".out__peek")).toHaveText("this console");
    await expect(row(page, 1).locator(".out__lang")).toHaveText("bash");
    await expect(row(page, 1).locator(".out__peek")).toHaveText(
      "curl -s http://100.89.0.116:5000/status",
    );
    await expect(row(page, 2).locator(".out__count")).toHaveText("2 lines");
    await expect(row(page, 2).locator(".out__peek")).toHaveText("100.89.0.3:5000 (m8s)");

    // Closed is the resting state.
    await expect(row(page, 0)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".out__body")).toHaveCount(0);

    // A row is a line of navigation, not a panel: 30px on this frame, with the
    // rest of the 34px touch settle coming from the lane around it.
    const box = await row(page, 0).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(29);
    expect(box!.height).toBeLessThanOrEqual(33);
    expect(box!.width).toBeGreaterThan(300);
  });

  test("opening a row gives back the original fenced block, and closing it takes it away", async ({
    page,
  }) => {
    await installBridge(page, transcript(3));
    await page.goto("/");
    await expect(page.locator(".out__row")).toHaveCount(3);

    await row(page, 0).click();
    await expect(row(page, 0)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('.out[data-open="true"]')).toHaveCount(1);
    // The opened block is the panel this transcript always drew: language head,
    // copy button, and the exact line the TUI printed.
    const opened = page.locator(".out__body");
    await expect(opened).toHaveCount(1);
    await expect(opened.locator(".chat__code-lang")).toHaveText("text");
    await expect(opened.locator(".chat__code-copy")).toHaveCount(1);
    // The body replays byte for byte and the language moves from the closing
    // marker to the opening one, so the opened block does not print the TUI's
    // own ` ```text ` scaffolding as if it were content.
    await expect(opened.locator(".chat__code-body")).toHaveText("this console");
    // Opening one row does not open the others.
    await expect(row(page, 1)).toHaveAttribute("aria-expanded", "false");

    await row(page, 0).click();
    await expect(row(page, 0)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".out__body")).toHaveCount(0);
  });

  test("two short blocks are not a wall of panels: nothing folds", async ({ page }) => {
    await installBridge(page, transcript(2));
    await page.goto("/");
    await expect(page.locator(".chat__code")).toHaveCount(3);
    await expect(page.locator(".chat__code-body")).toHaveCount(3);
    await expect(page.locator(".out__row")).toHaveCount(0);
    // Still rendered, still in place, just as panels.
    await expect(page.locator(".chat__code-body", { hasText: "this console" })).toHaveCount(1);
  });
});

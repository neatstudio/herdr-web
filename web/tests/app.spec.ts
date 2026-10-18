import { expect, test, type Page } from "@playwright/test";

/*
 * The bridge is mocked at the HTTP boundary: these tests cover the UI's own
 * behaviour (grouping, polling, prompt, menu, theme). The real socket path is
 * exercised by the Go suite and by the live end-to-end check.
 */

const ESC = "\u001b";

const WORKSPACES = [
  { id: "w1", name: "web", windows: 2, attached: false, paneCount: 2, agentStatus: "idle" },
  { id: "w2", name: "api", windows: 1, attached: true, paneCount: 1, agentStatus: "blocked" },
];

const PANES = [
  // An operator rename: outranks every other name.
  {
    id: "w1:p1", workspaceId: "w1", tabId: "w1:t1", focused: true, cwd: "/tmp/web",
    agentStatus: "idle", label: "Deploy Watch", terminalTitle: "osc title", agent: "claude",
  },
  // No label: falls through to the terminal title the program set.
  {
    id: "w1:p2", workspaceId: "w1", tabId: "w1:t1", focused: false, cwd: "/tmp/web",
    agentStatus: "working", terminalTitle: "vnstat 区间流量合计脚本 - grok", agent: "grok",
  },
  // Nothing named it at all: the pane id is all there is.
  { id: "w2:p1", workspaceId: "w2", tabId: "w2:t1", focused: true, cwd: "/tmp/api", agentStatus: "blocked" },
];

type FixtureOptions = {
  workspaces?: unknown;
  panes?: unknown;
  readText?: string;
  revision?: number;
  truncated?: boolean;
  readFails?: boolean;
};

async function installBridge(page: Page, options: FixtureOptions = {}): Promise<void> {
  const workspaces = options.workspaces ?? WORKSPACES;
  const panes = options.panes ?? PANES;
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        socket: "/Users/op/.config/herdr/herdr.sock",
        status: "ok",
        version: "0.9.0",
        protocol: 22,
        protocolTested: true,
      }),
    }),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspaces) }),
  );
  // The fleet poll fetches every pane in one call, so the ledger can be
  // grouped by pane status rather than by workspace.
  await page.route("**/api/v1/herdr/panes", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ panes }) }),
  );
  await page.route("**/api/v1/herdr/workspaces/*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const workspace = (workspaces as { id: string }[]).find((item) => item.id === id) ?? null;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspace,
        panes: (panes as { workspaceId: string }[]).filter((pane) => pane.workspaceId === id),
      }),
    });
  });
  await page.route("**/api/v1/herdr/panes/*/read*", (route) => {
    if (options.readFails === true) {
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "herdr_read_failed", message: "boom" } }),
      });
    }
    const paneId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        paneId,
        source: "recent",
        format: "ansi",
        text: options.readText ?? "plain line\n\u001b[32mok\u001b[0m and \u001b[31mbad\u001b[0m\n",
        revision: options.revision ?? 1,
        truncated: options.truncated ?? false,
        agentStatus: "idle",
      }),
    });
  });
}

test("fleet groups by status with blocked workspaces first", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  const groups = page.locator(".group__label-text");
  await expect(groups).toHaveText(["needs input", "working", "idle"]);

  // The blocked workspace opens by default, because it needs a human.
  await expect(page.locator(".stage__status")).toContainText("needs input");
});

test("selecting a workspace loads its panes and transcript", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // The blocked workspace opens first; switch to the idle one.
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");
  await page.locator('[data-pane-id="w1:p1"]').click();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);
  // The tab label is the pane's name, so identity is asserted on the id.
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveAttribute("data-pane-id", "w1:p1");
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");
});

test("ansi colours become styled spans, not escape bytes", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  await expect(page.locator("#herdr-feed-text")).toContainText("ok and bad");
  const green = page.locator("#herdr-feed-text span").first();
  await expect(green).toHaveText("ok");
  await expect(green).toHaveAttribute("style", /var\(--ansi-2\)/);
  await expect(page.locator("#herdr-feed-text")).not.toContainText("\u001b");
});

test("a 256-colour prompt renders like a real terminal", async ({ page }) => {
  // This is the shape a zsh prompt actually arrives in, padding included.
  await installBridge(page, {
    readText: "\u001b[0m\u001b[38;5;6madmin\u001b[0m \u001b[38;5;4m/tmp\u001b[0m \u001b[38;5;2m%\u001b[0m echo hi" +
      " ".repeat(60) + "\r\n",
  });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toContainText("admin /tmp % echo hi");
  await expect(feed.locator("span").first()).toHaveAttribute("style", /var\(--ansi-6\)/);
  // The terminal's trailing padding must not create ghost rows.
  await expect(page.locator(".scope__line")).toHaveCount(1);
  await expect(feed).not.toContainText("\u001b");
});

test("truncated scrollback is announced", async ({ page }) => {
  await installBridge(page, { truncated: true });
  await page.goto("/");
  await expect(page.locator("#herdr-feed-truncated")).toBeVisible();
  await expect(page.locator("#herdr-feed-truncated")).toContainText("scrollback truncated");
});

test("a failed read is reported and does not blank the page", async ({ page }) => {
  await installBridge(page, { readFails: true });
  await page.goto("/");
  await expect(page.locator("#herdr-read-failed")).toBeVisible();
  await expect(page.locator(".masthead")).toBeVisible();
});

test("enter sends the line with a trailing newline and keeps history", async ({ page }) => {
  const posted: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/input", async (route) => {
    posted.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("echo hi");
  await input.press("Enter");
  await expect.poll(() => posted).toEqual([JSON.stringify({ text: "echo hi\n" })]);
  await expect(input).toHaveValue("");

  await input.fill("echo again");
  await input.press("Enter");
  await expect.poll(() => posted).toHaveLength(2);
  await expect(input).toHaveValue("");

  await input.press("ArrowUp");
  await expect(input).toHaveValue("echo again");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("echo hi");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("echo again");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
});

test("tab flushes the line without a newline then sends a real Tab", async ({ page }) => {
  const inputPosts: string[] = [];
  const keyPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/input", async (route) => {
    inputPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("git ch");
  await input.press("Tab");
  await expect.poll(() => keyPosts).toEqual([JSON.stringify({ keys: ["Tab"] })]);
  expect(inputPosts).toEqual([JSON.stringify({ text: "git ch" })]);
  // The box keeps its text so the completion stays editable.
  await expect(input).toHaveValue("git ch");
});

test("the send button is disabled until there is something to send", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  const send = page.locator("#herdr-send");
  await expect(send).toBeDisabled();
  await page.locator("#herdr-input").fill("ls");
  await expect(send).toBeEnabled();
});

test("right-click opens the pane menu only on a pane title", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");

  // Work on the two-pane workspace.
  await page.locator('[data-pane-id="w1:p1"]').click();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);

  // Right-click on the transcript: no menu.
  await page.locator("#herdr-feed-text").click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);

  // Right-click on the second pane tab title: menu, offering to open it.
  await page.locator('[role="tab"] [data-pane-title="w1:p2"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menu"]')).toContainText("Open pane");

  await page.getByRole("menuitem", { name: /Open pane/ }).click();
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveAttribute("data-pane-id", "w1:p2");

  // On the already-open pane the menu drops the redundant action.
  await page.locator('h1 [data-pane-title="w1:p2"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menu"]')).not.toContainText("Open pane");

  // Clicking outside dismisses it.
  await page.locator(".masthead").click({ position: { x: 5, y: 5 } });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("theme switch flips the palette and persists", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  const html = page.locator("html");

  await page.getByRole("button", { name: "light", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("herdr-web-theme"))).toBe("light");

  await page.getByRole("button", { name: "dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // The choice survives a reload without flashing back to auto.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

test("re-selecting the open workspace keeps its pane visible", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");

  const selected = page.locator('.row[aria-current="true"]');
  await selected.click();
  // The stage must not empty out: the pane-loading effect keys on the
  // workspace id, which did not change.
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");
  await expect(page.locator(".scope__idle")).toHaveCount(0);
});

test("panes are labelled with their herdr name, not the raw id", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('[data-pane-id="w1:p1"]').click();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);

  const tabs = page.locator("[role=\"tab\"]");
  await expect(tabs.nth(0)).toContainText("Deploy Watch");
  await expect(tabs.nth(1)).toContainText("vnstat 区间流量合计脚本 - grok");
  // The id stays visible next to a real name, and in the tooltip.
  await expect(tabs.nth(0).locator(".tab__id")).toHaveText("p1");
  await expect(tabs.nth(0)).toHaveAttribute("title", "Deploy Watch — w1:p1");

  // The header names the pane too, keeping the id as secondary text.
  await expect(page.locator("h1")).toContainText("Deploy Watch");
  await expect(page.locator("h1 .stage__pane-id")).toHaveText("w1:p1");
});

test("a pane nothing has named falls back to its id", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");   // the blocked workspace opens first, and it is unnamed
  await expect(page.locator(".row[aria-current=\"true\"]")).toContainText("api");
  await expect(page.locator('[role="tab"]')).toContainText("w2:p1");
  // Nothing to disambiguate, so no secondary id is shown.
  await expect(page.locator(".tab__id")).toHaveCount(0);
  await expect(page.locator("h1 .stage__pane-id")).toHaveCount(0);
});

test("the pane menu still targets the id even when a label is shown", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('[data-pane-id="w1:p1"]').click();
  await page.locator('[role="tab"] [data-pane-title="w1:p2"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menu"]')).toContainText("Open pane");
});

test.describe("a pane that paints its own canvas", () => {
  const row = `${ESC}[48;2;20;20;20m${" ".repeat(120)}${ESC}[0m`;
  const text = `${ESC}[48;2;20;20;20m  hello from a TUI  ${ESC}[0m`;
  const lines = `${row}\n${text}\n${row}\n`;

  test("keeps that canvas on a dark page, with no colour surgery", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await installBridge(page, { readText: lines });
    await page.goto("/");

    const feed = page.locator("#herdr-feed-text");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(feed).toHaveAttribute("data-canvas", "content");
    await expect(feed).toHaveCSS("background-color", "rgb(20, 20, 20)");
    await expect(feed).not.toHaveAttribute("data-adapt", /.+/);
    // Wrap is the default, so the canvas is painted behind every row and the
    // page can never show through.
    await expect(feed).toHaveAttribute("data-display", "wrap");
  });

  test("mirrors it onto a light page instead of punching a dark hole", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await installBridge(page, { readText: lines });
    await page.goto("/");

    const feed = page.locator("#herdr-feed-text");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // The page provides the canvas, so the container must not paint one.
    await expect(feed).toHaveAttribute("data-adapt", "paper");
    // The backdrop is the *mirrored* canvas, so a wrapped row still sits on
    // the app's own surface rather than on bare paper.
    await expect(feed).toHaveCSS("background-color", "rgb(235, 235, 235)");
    // The app's dark canvas becomes a light one, and its light text dark.
    await expect(feed.locator("span").first()).toHaveCSS("background-color", "rgb(235, 235, 235)");
    await expect(feed.locator("span").first()).toHaveCSS("color", "rgb(23, 22, 15)");
  });
});

test("plain output keeps the page background and does not paint stripes", async ({ page }) => {
  await installBridge(page, { readText: `prompt% ls${" ".repeat(80)}\nfile.txt\n` });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  await expect(feed).not.toHaveAttribute("data-canvas", "content");
  await expect(feed).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Terminal padding is not content and must not become an invisible run.
  await expect(page.locator(".scope__line").first()).toHaveText("prompt% ls");
});

test("exact mode keeps one terminal row per line", async ({ page }) => {
  // A 180-column TUI line must not wrap in exact mode: wrapping destroys the
  // alignment the app draws with and shreds its painted background.
  const wide = `${ESC}[48;2;20;20;20m${"x".repeat(180)}${ESC}[0m`;
  await installBridge(page, { readText: `${wide}\n${wide}\n` });
  await page.goto("/");
  await page.locator("#herdr-display-exact").click();
  await expect(page.locator(".scope__line").first()).toContainText("xxx");

  const heights = await page.locator(".scope__line").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );
  expect(new Set(heights).size).toBe(1);
  // Wider than the viewport, so the transcript scrolls sideways instead.
  const overflow = await page
    .locator("#herdr-feed-text")
    .evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(overflow).toBe(true);
});

test("plain output rewraps to a phone-sized viewport", async ({ page }) => {
  // herdr fixes the pane's width and pane.read takes no width argument, so the
  // browser cannot ask for narrower output. Ordinary text can still reflow,
  // which is what makes a phone readable without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page, { readText: `a fairly long line of plain shell output that would not fit a phone\nsecond\n` });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toHaveAttribute("data-wrap", "on");
  const overflow = await feed.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(overflow, "plain output must not overflow sideways on a phone").toBe(false);
});

test("a fixed-width pane can be scaled to fit instead of only scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const wide = `${ESC}[48;2;20;20;20m${"x".repeat(120)}${ESC}[0m`;
  await installBridge(page, { readText: `${wide}\n${wide}\n` });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  // Exact keeps terminal rows intact, so it does not fit and scrolls.
  await page.locator("#herdr-display-exact").click();
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth > node.clientWidth + 1))
    .toBe(true);

  await page.locator("#herdr-display-fit").click();
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);
});

test("the fleet lists agents, not workspaces, and keeps the workspace as context", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  const rows = page.locator(".row");
  await expect(rows).toHaveCount(3);
  // Every row names the agent working there (or says shell) and the workspace.
  await expect(rows.nth(0)).toContainText("shell");
  await expect(rows.nth(0).locator(".row__workspace")).toHaveText("api");
  await expect(rows.filter({ hasText: "claude" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "grok" })).toHaveCount(1);
  await expect(page.locator(".ledger__head")).toContainText("2/3 agents");
});

test("clicking an agent row opens that pane directly", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.row[data-pane-id="w1:p2"]').click();
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveAttribute("data-pane-id", "w1:p2");
  await expect(page.locator("h1")).toContainText("vnstat 区间流量合计脚本");
});

test("the transcript layout switches between wrap, exact and fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const wide = `${ESC}[48;2;20;20;20m${"x".repeat(120)}${ESC}[0m`;
  await installBridge(page, { readText: `${wide}\n${wide}\n` });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  // Default: text follows the screen width.
  await expect(feed).toHaveAttribute("data-display", "wrap");
  await expect(feed).toHaveAttribute("data-wrap", "on");

  // Exact: one row per terminal line, so it overflows and scrolls.
  await page.locator("#herdr-display-exact").click();
  await expect(feed).toHaveAttribute("data-display", "exact");
  await expect(feed).toHaveAttribute("data-wrap", "off");
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth > node.clientWidth + 1))
    .toBe(true);

  // Fit: scaled so all 120 columns land inside the viewport.
  await page.locator("#herdr-display-fit").click();
  await expect(feed).toHaveAttribute("data-display", "fit");
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);

  // The choice is remembered across a reload.
  await page.reload();
  await expect(page.locator("#herdr-feed-text")).toHaveAttribute("data-display", "fit");
});

test("the pane menu renames a pane, and clearing it restores the id", async ({ page }) => {
  const renames: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/rename", async (route) => {
    renames.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");
  await page.locator('.row[data-pane-id="w1:p1"]').click();

  await page.locator('h1 [data-pane-title="w1:p1"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toContainText("Rename");
  await page.getByRole("menuitem", { name: /Rename/ }).click();

  // The menu turns into an input prefilled with the current name.
  const input = page.locator("#herdr-rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Deploy Watch");
  await input.fill("Nightly deploy");
  await input.press("Enter");
  await expect.poll(() => renames).toEqual([JSON.stringify({ label: "Nightly deploy" })]);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("a long press opens the pane menu, because touch has no right-click", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.row[data-pane-id="w1:p1"]').click();

  const tab = page.locator('[role="tab"] [data-pane-title="w1:p2"]');
  const box = (await tab.boundingBox()) ?? { x: 0, y: 0, width: 10, height: 10 };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Playwright cannot hold a touch, so drive the same events the handlers see.
  await tab.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  await expect(page.locator('[role="menu"]')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('[role="menu"]')).toContainText("Rename");

  // A finger that moves is scrolling, and must not open a menu.
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await tab.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  await tab.dispatchEvent("touchmove", { touches: [{ identifier: 1, clientX: x, clientY: y + 40 }] });
  await page.waitForTimeout(700);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("the fleet never shows a pane id twice", async ({ page }) => {
  // An unnamed pane whose agent herdr detected used to render as "w6:p1 p1".
  await installBridge(page, {
    panes: [
      { id: "w6:p1", workspaceId: "w1", tabId: "w1:t1", focused: true, agentStatus: "idle", agent: "agy", cwd: "/srv/app" },
    ],
    workspaces: [{ id: "w1", name: "web", windows: 1, attached: true, paneCount: 1, agentStatus: "idle" }],
  });
  await page.goto("/");

  const row = page.locator('.row[data-pane-id="w6:p1"]');
  await expect(row.locator(".row__agent")).toHaveText("agy");
  // The name column identifies the pane by its directory, not by a repeat.
  await expect(row.locator(".row__name")).toHaveText("app");
  await expect(row.locator(".row__id")).toHaveCount(0);
});

test("a tainted workspace reports the no-panes state instead of a blank scope", async ({ page }) => {
  await installBridge(page, { panes: [] });
  await page.goto("/");
  await expect(page.locator(".scope__idle")).toContainText("no pane selected");
  await expect(page.locator(".ledger__empty")).toContainText("No panes reported");
  await expect(page.locator("#herdr-input")).toHaveCount(0);
});

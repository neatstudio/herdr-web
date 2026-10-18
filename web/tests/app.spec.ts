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

/* ------------------------------------------------------------- the two columns */

test("the sidebar splits spaces from agents, and each half groups itself", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // Spaces by their own status: blocked first.
  await expect(page.locator(".side--spaces .group__label-text")).toHaveText(["needs input", "idle"]);
  // Agents by pane status, across every space, which is what needs attention.
  await expect(page.locator(".side--agents .group__label-text")).toHaveText([
    "needs input",
    "working",
    "idle",
  ]);
  await expect(page.locator(".side--agents .row")).toHaveCount(3);
  // The blocked workspace opens by default.
  await expect(page.locator(".stage__status")).toContainText("needs input");
});

test("the rail shows how much work each workspace holds", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  await expect(page.locator(".side--spaces [data-workspace-id]")).toHaveCount(2);
  await expect(page.locator('.side--spaces [data-workspace-id="w1"]')).toContainText("web");
  // Two panes, both of which herdr recognised as an agent.
  await expect(page.locator('.side--spaces [data-workspace-id="w1"] .wrow__count')).toHaveText("2p2a");
  await expect(page.locator('.side--spaces [data-workspace-id="w2"] .wrow__count')).toHaveText("1p");
});

test("opening a space shows its pane tabs and opens one of its panes", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  // The tabs above the transcript are that space's panes.
  await expect(page.locator('.strip [role="tab"]')).toHaveCount(2);
  // One rule picks it: blocked, else the pane herdr reports as focused.
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveAttribute("data-pane-id", "w1:p1");
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");
});

test("clicking an agent row opens that pane in the transcript", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();

  await page.locator('.side--agents .row[data-pane-id="w1:p1"]').click();
  await expect(page.locator('.row[aria-current="true"]')).toHaveAttribute("data-pane-id", "w1:p1");
  await expect(page.locator("h1")).toContainText("Deploy Watch");
  await expect(page.locator("h1 .stage__pane-id")).toHaveText("w1:p1");
});

test("panes are labelled with their herdr name, with the id kept as context", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();

  // Rows are grouped by status, so assert on identity rather than position.
  const named = page.locator('.side--agents .row[data-pane-id="w1:p1"]');
  const title = page.locator('.side--agents .row[data-pane-id="w1:p2"]');
  await expect(named).toContainText("Deploy Watch");
  await expect(title).toContainText("vnstat 区间流量合计脚本 - grok");
  await expect(named.locator(".row__workspace")).toHaveText("web");
  await expect(named).toHaveAttribute("title", "Deploy Watch — w1:p1 (web)");
  // The tab above the transcript names the same pane, with the id beside it.
  const tab = page.locator('.tab[data-pane-id="w1:p1"]');
  await expect(tab).toContainText("Deploy Watch");
  await expect(tab.locator(".tab__id")).toHaveText("p1");
});

test("an unnamed pane falls back to its id and never shows it twice", async ({ page }) => {
  await installBridge(page, {
    panes: [{ id: "w2:p1", workspaceId: "w2", tabId: "w2:t1", focused: true, agentStatus: "blocked" }],
  });
  await page.goto("/");

  const row = page.locator('.side--agents .row[data-pane-id="w2:p1"]');
  await expect(row.locator(".row__agent")).toHaveText("shell");
  await expect(row.locator(".row__name")).toHaveText("w2:p1");
  await expect(row.locator(".row__id")).toHaveCount(0);
});

test("an unnamed pane with an agent is identified by its directory, not a repeat", async ({ page }) => {
  await installBridge(page, {
    panes: [
      { id: "w2:p1", workspaceId: "w2", tabId: "w2:t1", focused: true, agentStatus: "blocked", agent: "agy", cwd: "/srv/app" },
    ],
  });
  await page.goto("/");

  const row = page.locator('.side--agents .row[data-pane-id="w2:p1"]');
  await expect(row.locator(".row__agent")).toHaveText("agy");
  await expect(row.locator(".row__name")).toHaveText("app");
  await expect(row.locator(".row__id")).toHaveCount(0);
});

test("the agent filter narrows the whole sidebar and clears again", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator(".side--agents .row")).toHaveCount(3);

  // The filter searches every space at once, so a pane in another space is
  // findable without switching to it first.
  const filter = page.locator("#herdr-agent-filter");
  await filter.fill("grok");
  await expect(page.locator(".side--agents .row")).toHaveCount(1);
  await expect(page.locator(".side--agents .col__head")).toContainText("1/3");

  await expect(page.locator(".side--agents .row")).toContainText("grok");

  // A term that matches nothing says so instead of showing an empty list.
  await filter.fill("nothing-here");
  await expect(page.locator(".side--agents .row")).toHaveCount(0);
  await expect(page.locator(".side--agents .col__empty")).toContainText("No pane matches");

  await page.locator("#herdr-agent-clear").click();
  await expect(page.locator(".side--agents .row")).toHaveCount(3);
  await expect(page.locator(".side--agents .col__head")).toContainText("2/3");
});

test("a workspace with no panes says so and leaves the stage idle", async ({ page }) => {
  await installBridge(page, { panes: [] });
  await page.goto("/");
  await expect(page.locator(".side--agents .col__empty")).toContainText("No panes reported");
  await expect(page.locator(".scope__idle")).toContainText("no pane selected");
  await expect(page.locator("#herdr-input")).toHaveCount(0);
});

/* -------------------------------------------------------------------- menus */

test("right-click opens a menu on a pane row, a rail row and the header name", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await page.locator('.side--agents .row[data-pane-id="w1:p2"]').click();

  // A pane row: the full pane menu.
  await page.locator('.side--agents .row[data-pane-id="w1:p2"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menu"]')).toContainText("Copy pane id");
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);

  // A rail row: the workspace menu.
  await page.locator('.side--spaces [data-workspace-id="w1"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toContainText("Rename workspace");
  await expect(page.locator('[role="menu"]')).toContainText("Copy workspace id");
  await page.keyboard.press("Escape");

  // The header pane name, and nowhere else.
  await page.locator('h1 [data-pane-title]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#herdr-feed-text").click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("a long press opens the same menus, because touch has no right-click", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  const rail = page.locator('.side--spaces [data-workspace-id="w1"]');
  const railBox = (await rail.boundingBox()) ?? { x: 0, y: 0, width: 10, height: 10 };
  await rail.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: railBox.x + 5, clientY: railBox.y + 5 }],
  });
  await expect(page.locator('[role="menu"]')).toBeVisible({ timeout: 3000 });
  await page.keyboard.press("Escape");

  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  const row = page.locator('.side--agents .row[data-pane-id="w1:p2"]');
  const rowBox = (await row.boundingBox()) ?? { x: 0, y: 0, width: 10, height: 10 };
  const x = rowBox.x + rowBox.width / 2;
  const y = rowBox.y + rowBox.height / 2;
  await row.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  await expect(page.locator('[role="menu"]')).toBeVisible({ timeout: 3000 });
  await page.keyboard.press("Escape");

  // A finger that moves is scrolling, and must not open a menu.
  await row.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  await row.dispatchEvent("touchmove", { touches: [{ identifier: 1, clientX: x, clientY: y + 40 }] });
  await page.waitForTimeout(700);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("a pane is renamed from its row, and clearing it restores the id", async ({ page }) => {
  const renames: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/rename", async (route) => {
    renames.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();

  await page.locator('.side--agents .row[data-pane-id="w1:p1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const input = page.locator("#herdr-rename-input");
  await expect(input).toHaveValue("Deploy Watch");
  await input.fill("Nightly deploy");
  await input.press("Enter");
  await expect.poll(() => renames).toEqual([JSON.stringify({ label: "Nightly deploy" })]);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});

test("a workspace is renamed from the rail, and cannot be left nameless", async ({ page }) => {
  const renames: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/workspaces/*/rename", async (route) => {
    renames.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  await page.locator('.side--spaces [data-workspace-id="w1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename workspace/ }).click();
  const input = page.locator("#herdr-rename-input");
  await expect(input).toHaveValue("web");
  // A workspace has no unnamed state, so a blank draft cannot be saved.
  await input.fill("   ");
  await expect(page.locator(".menu__save")).toBeDisabled();
  await input.fill("prod hosts");
  await input.press("Enter");
  await expect.poll(() => renames).toEqual([JSON.stringify({ label: "prod hosts" })]);
});

/* -------------------------------------------------------------- transcript */

test("ansi colours become styled spans, not escape bytes", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator("#herdr-feed-text")).toContainText("ok and bad");
  const green = page.locator("#herdr-feed-text span").first();
  await expect(green).toHaveText("ok");
  await expect(green).toHaveAttribute("style", /var\(--ansi-2\)/);
  await expect(page.locator("#herdr-feed-text")).not.toContainText(ESC);
});

test("a 256-colour prompt renders like a real terminal", async ({ page }) => {
  await installBridge(page, {
    readText:
      `${ESC}[0m${ESC}[38;5;6madmin${ESC}[0m ${ESC}[38;5;4m/tmp${ESC}[0m ${ESC}[38;5;2m%${ESC}[0m echo hi` +
      " ".repeat(60) +
      "\r\n",
  });
  await page.goto("/");
  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toContainText("admin /tmp % echo hi");
  await expect(feed.locator("span").first()).toHaveAttribute("style", /var\(--ansi-6\)/);
  await expect(page.locator(".scope__line")).toHaveCount(1);
  await expect(feed).not.toContainText(ESC);
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
    await expect(feed).toHaveAttribute("data-display", "wrap");
  });

  test("mirrors it onto a light page instead of punching a dark hole", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await installBridge(page, { readText: lines });
    await page.goto("/");

    const feed = page.locator("#herdr-feed-text");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(feed).toHaveAttribute("data-adapt", "paper");
    // The backdrop is the mirrored canvas, so a wrapped row still sits on the
    // app's own surface rather than on bare paper.
    await expect(feed).toHaveCSS("background-color", "rgb(235, 235, 235)");
    await expect(feed.locator("span").first()).toHaveCSS("background-color", "rgb(235, 235, 235)");
  });
});

test("plain output keeps the page background", async ({ page }) => {
  await installBridge(page, { readText: `prompt% ls${" ".repeat(80)}\nfile.txt\n` });
  await page.goto("/");
  const feed = page.locator("#herdr-feed-text");
  await expect(feed).not.toHaveAttribute("data-canvas", /.+/);
  await expect(feed).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".scope__line").first()).toHaveText("prompt% ls");
});

test("the transcript layout switches between wrap, exact and fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const wide = `${ESC}[48;2;20;20;20m${"x".repeat(120)}${ESC}[0m`;
  await installBridge(page, { readText: `${wide}\n${wide}\n` });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toHaveAttribute("data-display", "wrap");

  await page.locator("#herdr-display-exact").click();
  await expect(feed).toHaveAttribute("data-display", "exact");
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth > node.clientWidth + 1))
    .toBe(true);

  await page.locator("#herdr-display-fit").click();
  await expect(feed).toHaveAttribute("data-display", "fit");
  await expect
    .poll(async () => feed.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);

  await page.reload();
  await expect(page.locator("#herdr-feed-text")).toHaveAttribute("data-display", "fit");
});

test("exact mode keeps one terminal row per line", async ({ page }) => {
  const wide = `${ESC}[48;2;20;20;20m${"x".repeat(180)}${ESC}[0m`;
  await installBridge(page, { readText: `${wide}\n${wide}\n` });
  await page.goto("/");
  await page.locator("#herdr-display-exact").click();
  await expect(page.locator(".scope__line").first()).toContainText("xxx");

  const heights = await page.locator(".scope__line").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );
  expect(new Set(heights).size).toBe(1);
  const overflow = await page
    .locator("#herdr-feed-text")
    .evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(overflow).toBe(true);
});

/* ----------------------------------------------------------------- prompt */

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

/* ------------------------------------------------------------------ theme */

test("theme switch flips the palette and persists", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  const html = page.locator("html");

  await page.getByRole("button", { name: "light", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("herdr-web-theme"))).toBe("light");

  await page.getByRole("button", { name: "dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

/* ------------------------------------------------------------------ phone */

test("a phone hides the sidebar behind one picker, in two levels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");

  // The sidebar is off screen, and nothing scrolls sideways to reach it.
  await expect(page.locator(".sidebar")).toBeHidden();

  const pick = page.locator("#herdr-picker-open");
  await expect(pick).toBeVisible();
  await pick.click();

  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  // Level one starts collapsed, naming only the space you are in.
  const spaces = page.locator("#herdr-sheet-spaces");
  await expect(spaces).toHaveAttribute("aria-expanded", "false");
  await expect(spaces).toContainText("api");
  await expect(sheet.locator("[data-workspace-id]")).toHaveCount(0);

  // Level two is open: this space's panes are one tap away.
  await expect(sheet.locator(".srow[data-pane-id]")).toHaveCount(1);
  await sheet.locator('.srow[data-pane-id="w2:p1"]').click();

  await expect(sheet).toHaveCount(0);
  await expect(page.locator("h1")).toContainText("w2:p1");
});

test("the spaces level opens, switches space and folds itself back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");
  await page.locator("#herdr-picker-open").click();

  await page.locator("#herdr-sheet-spaces").click();
  await expect(page.locator("#herdr-sheet-spaces")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sheet [data-workspace-id]")).toHaveCount(2);

  // Picking a space swaps level two to its panes and folds level one back.
  await page.locator('.sheet [data-workspace-id="w1"]').click();
  await expect(page.locator("#herdr-sheet-spaces")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sheet .srow[data-pane-id]")).toHaveCount(2);
  await expect(page.locator("#herdr-sheet-title")).toHaveText("web");
});

test("the picker searches every pane at once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");
  await page.locator("#herdr-picker-open").click();

  const filter = page.locator("#herdr-sheet-filter");
  await filter.fill("claude");
  await expect(page.locator(".sheet .srow")).toHaveCount(1);
  await expect(page.locator(".sheet .srow")).toContainText("claude");
  // A cross-workspace search reaches panes the columns would have hidden.
  await filter.fill("grok");
  await expect(page.locator(".sheet .srow")).toContainText("grok");
});

test("plain output rewraps to a phone-sized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page, {
    readText: `a fairly long line of plain shell output that would not fit a phone\nsecond\n`,
  });
  await page.goto("/");

  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toHaveAttribute("data-wrap", "on");
  const overflow = await feed.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(overflow, "plain output must not overflow sideways on a phone").toBe(false);
});

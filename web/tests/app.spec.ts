import { expect, test, type Page } from "@playwright/test";

/*
 * The bridge is mocked at the HTTP boundary: these tests cover the UI's own
 * behaviour (grouping, polling, prompt, menu, theme). The real socket path is
 * exercised by the Go suite and by the live end-to-end check.
 */

const WORKSPACES = [
  { id: "w1", name: "web", windows: 2, attached: false, paneCount: 2, agentStatus: "idle" },
  { id: "w2", name: "api", windows: 1, attached: true, paneCount: 1, agentStatus: "blocked" },
];

const PANES = [
  { id: "w1:p1", workspaceId: "w1", tabId: "w1:t1", focused: true, cwd: "/tmp/web", agentStatus: "idle" },
  { id: "w1:p2", workspaceId: "w1", tabId: "w1:t1", focused: false, cwd: "/tmp/web", agentStatus: "working" },
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
  await expect(groups).toHaveText(["needs input", "idle"]);

  // The blocked workspace opens by default, because it needs a human.
  await expect(page.locator(".stage__status")).toContainText("needs input");
});

test("selecting a workspace loads its panes and transcript", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // The blocked workspace opens first; switch to the idle one.
  await expect(page.locator("#herdr-feed-text")).toContainText("plain line");
  await page.locator('[data-workspace-id="w1"]').click();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText("w1:p1");
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
  await page.locator('[data-workspace-id="w1"]').click();
  await expect(page.locator('[role="tab"]')).toHaveCount(2);

  // Right-click on the transcript: no menu.
  await page.locator("#herdr-feed-text").click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);

  // Right-click on the second pane tab title: menu, offering to open it.
  await page.locator('[role="tab"] [data-pane-title="w1:p2"]').click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menu"]')).toContainText("Open pane");

  await page.getByRole("menuitem", { name: /Open pane/ }).click();
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText("w1:p2");

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

test("a tainted workspace reports the no-panes state instead of a blank scope", async ({ page }) => {
  await installBridge(page, { panes: [] });
  await page.goto("/");
  await expect(page.locator(".scope__idle")).toContainText("no panes here");
  await expect(page.locator("#herdr-input")).toHaveCount(0);
});

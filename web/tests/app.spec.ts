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
    id: "w1:p2", workspaceId: "w1", tabId: "w1:t2", focused: false, cwd: "/tmp/web",
    agentStatus: "working", terminalTitle: "vnstat 区间流量合计脚本 - grok", agent: "grok",
  },
  // Nothing named it at all: the pane id is all there is.
  { id: "w2:p1", workspaceId: "w2", tabId: "w2:t1", focused: true, cwd: "/tmp/api", agentStatus: "blocked" },
];

type FixtureOptions = {
  workspaces?: unknown;
  panes?: unknown;
  /** Answer every herdr route with 502, as a restarting daemon does. */
  daemonDown?: boolean;
  /** Report the panes' directories as absent, as a remote host's would be. */
  pathMissing?: boolean;
  /** Extra panes to report for the open tab, to exercise a split. */
  splitWith?: string[];
  readText?: string;
  revision?: number;
  truncated?: boolean;
  readFails?: boolean;
};

async function installBridge(page: Page, options: FixtureOptions = {}): Promise<void> {
  const resizes: string[] = [];
  const splits: string[] = [];
  const closes: string[] = [];
  const created: unknown[] = [];
  Object.assign(page as Page & { resizes?: string[]; splits?: string[]; closes?: string[] }, {
    resizes,
    splits,
    closes,
  });
  const workspaces = options.workspaces ?? WORKSPACES;
  const panes = options.panes ?? PANES;
  if (options.daemonDown === true) {
    await page.route("**/api/v1/herdr/*", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "herdr_unreachable", message: "daemon restarting" } }),
      }),
    );
    return;
  }
  await page.route("**/api/v1/herdr-web/release", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "v0.3.1",
        platform: "darwin-arm64",
        sha256: "0".repeat(64),
        source: "https://github.com/neatstudio/herdr-web/releases/latest/download",
        executable: "/Users/op/.local/bin/herdr-web",
      }),
    }),
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
        // What this console runs: the masthead names the machine and this build,
        // not the daemon's version.
        consoleVersion: "v0.3.1",
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
  // A split really does add a pane to herdr, so later polls must include it;
  // otherwise the selection would fall back to the default and hide a bug.
  await page.route("**/api/v1/herdr/panes", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ panes: [...(panes as unknown[]), ...created] }),
    }),
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
  // Every path is on this host unless a test says otherwise.
  await page.route("**/api/v1/herdr/host/stat*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "/tmp", exists: options.pathMissing !== true, isDir: true }),
    }),
  );
  await page.route("**/api/v1/herdr/panes/*/split", async (route) => {
    splits.push(route.request().postData() ?? "");
    const source = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    const parent = (panes as { id: string; workspaceId: string; tabId: string }[]).find(
      (item) => item.id === source,
    );
    created.push({
      id: "w1:p9",
      workspaceId: parent?.workspaceId ?? "w1",
      tabId: parent?.tabId ?? "w1:t1",
      focused: false,
      cwd: "/tmp/new",
      agentStatus: "unknown",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, paneId: "w1:p9" }),
    });
  });
  await page.route("**/api/v1/herdr/panes/*/close", async (route) => {
    closes.push(route.request().postData() ?? route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/v1/herdr/panes/*/resize", async (route) => {
    resizes.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  // How the open tab is split. By default one pane fills the area.
  await page.route("**/api/v1/herdr/panes/*/layout", (route) => {
    const url = new URL(route.request().url());
    const paneId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
    const pane = (panes as { id: string; tabId: string }[]).find((item) => item.id === paneId);
    const ids = [paneId, ...(options.splitWith ?? []).filter((id) => id !== paneId)];
    const each = Math.floor(120 / ids.length);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tabId: pane?.tabId ?? "w1:t1",
        workspaceId: pane === undefined ? "" : paneId.split(":")[0],
        zoomed: false,
        area: { x: 0, y: 0, width: 120, height: 40 },
        focusedPaneId: paneId,
        // One edge when there is a split, because herdr reports the split's own
        // box and ratio rather than leaving the client to infer it.
        splits:
          ids.length > 1
            ? [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 40 } }]
            : [],
        panes: ids.map((id, index) => ({
          id,
          focused: index === 0,
          rect: { x: index * each, y: 0, width: index === ids.length - 1 ? 120 - index * each : each, height: 40 },
        })),
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

test("spaces keep herdr's own order and carry no status", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // Workspaces are a place to attach to: listed in the order herdr reports
  // them, with no status grouping, no dots and no group headings.
  await expect(page.locator(".side--spaces .wrow__name")).toHaveText(["web", "api"]);
  await expect(page.locator(".side--spaces .group__label")).toHaveCount(0);
  await expect(page.locator(".side--spaces .signal")).toHaveCount(0);

  // Agents only: w2:p1 is a plain shell, so the sidebar does not list it even
  // though its workspace is the one that needs attention.
  await expect(page.locator(".side--agents .row")).toHaveCount(2);
  await expect(page.locator('.side--agents .row[data-pane-id="w2:p1"]')).toHaveCount(0);
  await expect(page.locator(".side--agents .group__label")).toHaveCount(0);
  await expect(page.locator(".side--agents .signal")).toHaveCount(0);
  // Ordered by what needs attention, with the tone carried by colour.
  await expect(page.locator(".side--agents .row").first()).toHaveAttribute("data-tone", "working");

  // The blocked workspace opens by default.
  await expect(page.locator(".stage__status")).toContainText("needs input");
});

test("the sidebar halves are equal, and agent tones are colours not marks", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  const halves = await page.evaluate(() => ({
    spaces: Math.round(document.querySelector(".side--spaces")?.getBoundingClientRect().height ?? 0),
    agents: Math.round(document.querySelector(".side--agents")?.getBoundingClientRect().height ?? 0),
  }));
  expect(Math.abs(halves.spaces - halves.agents)).toBeLessThanOrEqual(1);

  // Working and idle differ by colour, and each equals its theme token, so the
  // assertion holds in both themes instead of pinning one palette.
  const tones = await page.evaluate(() => {
    const resolve = (token: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    const colourAt = (selector: string): string => {
      const node = document.querySelector(selector);
      return node === null ? "" : getComputedStyle(node).color;
    };
    return {
      workingToken: resolve("--working"),
      idleToken: resolve("--idle"),
      working: colourAt('.side--agents .row[data-pane-id="w1:p2"] .row__agent'),
      idle: colourAt('.side--agents .row[data-pane-id="w1:p1"] .row__agent'),
    };
  });
  expect(tones.working).toBe(tones.workingToken);
  expect(tones.idle).toBe(tones.idleToken);
  expect(tones.working).not.toBe(tones.idle);
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
  // The tab strip names the open pane; the line above it says where, not which.
  const tab = page.locator('.tab[aria-selected="true"]');
  await expect(tab).toContainText("Deploy Watch");
  await expect(tab.locator(".tab__id")).toHaveText("p1");
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

test("a plain shell stays out of the sidebar but reachable from the tabs", async ({ page }) => {
  await installBridge(page, {
    panes: [{ id: "w2:p1", workspaceId: "w2", tabId: "w2:t1", focused: true, agentStatus: "blocked" }],
  });
  await page.goto("/");

  // Not in the sidebar: the left side lists workspaces and agents only.
  await expect(page.locator('.side--agents .row[data-pane-id="w2:p1"]')).toHaveCount(0);
  await expect(page.locator(".side--agents .col__empty")).toContainText("No agents running");

  // Still openable: the pane tabs cover every pane of the space.
  const tab = page.locator('.tab[data-pane-id="w2:p1"]');
  await expect(tab).toHaveCount(1);
  await expect(tab).toContainText("w2:p1");
  // The header says where the pane is, not which pane it is.
  await expect(page.locator("h1")).not.toContainText("w2:p1");
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
  await expect(page.locator(".side--agents .row")).toHaveCount(2);

  // The filter searches every space at once, so a pane in another space is
  // findable without switching to it first.
  const filter = page.locator("#herdr-agent-filter");
  await filter.fill("grok");
  await expect(page.locator(".side--agents .row")).toHaveCount(1);
  await expect(page.locator(".side--agents .col__head")).toContainText("1/2");

  await expect(page.locator(".side--agents .row")).toContainText("grok");

  // A term that matches nothing says so instead of showing an empty list.
  await filter.fill("nothing-here");
  await expect(page.locator(".side--agents .row")).toHaveCount(0);
  await expect(page.locator(".side--agents .col__empty")).toContainText("No pane matches");

  await page.locator("#herdr-agent-clear").click();
  await expect(page.locator(".side--agents .row")).toHaveCount(2);
  await expect(page.locator(".side--agents .col__head")).toContainText("2");
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

  // The pane name in the tab strip, and nowhere else.
  await page.locator('.strip [data-pane-title]').first().click({ button: "right" });
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

test("a painted block has no seam between its rows", async ({ page }) => {
  // A TUI paints its echoed input as a bar, padding included. If the line box is
  // taller than the painted background, every row shows a light seam and one
  // block reads as a stack of separate bars.
  // The painted run is long, as a TUI's full-width bar is: a couple of coloured
  // characters are a highlight, not a bar, and the renderer treats them apart.
  const bar = `${ESC}[48;2;48;53;62m > hello ${" ".repeat(160)}${ESC}[0m`;
  await installBridge(page, { readText: `${bar}\n${bar}\n${bar}\n` });
  await page.goto("/");
  await expect(page.locator(".scope__line")).toHaveCount(3);

  const rows = await page.locator(".scope__line").evaluateAll((nodes) =>
    nodes.map((node) => {
      const span = node.querySelector("span[style*='background-color']");
      const line = node.getBoundingClientRect();
      const painted = span?.getBoundingClientRect();
      return {
        line: Math.round(line.height),
        painted: painted ? Math.round(painted.height) : 0,
        offset: painted ? Math.round(painted.top - line.top) : null,
      };
    }),
  );
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.painted, "the background fills the row box").toBe(row.line);
    expect(row.offset).toBe(0);
  }
  // An empty row still occupies a row, so the transcript keeps its shape.
  const empty = await page.locator(".scope__line").first().evaluate((node) => node.getBoundingClientRect().height);
  expect(Math.round(empty)).toBe(rows[0].line);
});

test("a dark bar is mirrored on paper and left alone on carbon", async ({ page }) => {
  const bar = `${ESC}[48;2;48;53;62m${ESC}[38;2;242;240;233m > hello ${" ".repeat(160)}${ESC}[0m`;

  // On paper the app's absolute colours are mirrored: a light bar, dark ink.
  await page.emulateMedia({ colorScheme: "light" });
  await installBridge(page, { readText: `${bar}\n` });
  await page.goto("/");
  const feed = page.locator("#herdr-feed-text");
  await expect(feed).toHaveAttribute("data-adapt", "paper");
  const light = await page.locator(".scope__line span").first().evaluate((node) => ({
    bg: getComputedStyle(node).backgroundColor,
    ink: getComputedStyle(node).color,
  }));
  expect(light.bg).not.toBe("rgb(48, 53, 62)");
  // The mirrored bar is lighter than the ink it carries.
  const lum = (css: string): number => {
    const [r, g, b] = css.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  expect(lum(light.bg)).toBeGreaterThan(lum(light.ink));

  // On carbon the bar is what the app drew, because that is the theme it was
  // designed for.
  const dark = await page.context().browser()?.newContext({ colorScheme: "dark" });
  const page2 = await dark!.newPage();
  await installBridge(page2, { readText: `${bar}\n` });
  await page2.goto("/");
  await expect(page2.locator("#herdr-feed-text")).not.toHaveAttribute("data-adapt", /.+/);
  const carbon = await page2.locator(".scope__line span").first().evaluate((node) => ({
    bg: getComputedStyle(node).backgroundColor,
    ink: getComputedStyle(node).color,
  }));
  expect(carbon.bg).toBe("rgb(48, 53, 62)");
  expect(carbon.ink).toBe("rgb(242, 240, 233)");
  await dark!.close();
});

test("plain output keeps the page background", async ({ page }) => {
  await installBridge(page, { readText: `prompt% ls${" ".repeat(80)}\nfile.txt\n` });
  await page.goto("/");
  const feed = page.locator("#herdr-feed-text");
  await expect(feed).not.toHaveAttribute("data-canvas", /.+/);
  await expect(feed).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".scope__line").first()).toHaveText("prompt% ls");
});

test("a tab with a split shows one tile per pane, and the click chooses the prompt", async ({ page }) => {
  await installBridge(page, { splitWith: ["w1:p2"] });
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();

  const tiles = page.locator(".tile");
  await expect(tiles).toHaveCount(2);
  // Side by side on a wide window, as herdr splits them.
  await expect(page.locator(".tiles")).toHaveAttribute("data-arrange", "side");
  const boxes = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().left)),
  );
  expect(boxes[1]).toBeGreaterThan(boxes[0]);

  // Only the active tile reads its pane, so a split costs one read per poll.
  await expect(page.locator('.tile[data-active="true"]')).toHaveAttribute("data-pane-id", "w1:p1");
  await expect(page.locator("#herdr-input")).toHaveAttribute("placeholder", "send to w1:p1");

  // Clicking the other tile sends the prompt there, with the caret already in it.
  await page.locator('.tile[data-pane-id="w1:p2"] .tile__head').click();
  await expect(page.locator('.tile[data-active="true"]')).toHaveAttribute("data-pane-id", "w1:p2");
  await expect(page.locator("#herdr-input")).toHaveAttribute("placeholder", "send to w1:p2");
  await expect(page.locator("#herdr-input")).toBeFocused();
  await expect(page.locator("#herdr-feed-text")).toHaveCount(1);
});

test("a split stacks on a phone instead of squeezing side by side", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page, { splitWith: ["w1:p2"] });
  await page.goto("/");

  const tiles = page.locator(".tile");
  await expect(tiles).toHaveCount(2);
  await expect(page.locator(".tiles")).toHaveAttribute("data-arrange", "stack");
  const boxes = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), width: Math.round(rect.width) };
    }),
  );
  // One above the other, both full width.
  expect(boxes[1].top).toBeGreaterThan(boxes[0].top);
  for (const box of boxes) {
    expect(box.width).toBe(390);
  }
});

test("a split edge can be dragged, one herdr step at a time", async ({ page }) => {
  await installBridge(page, { splitWith: ["w1:p2"] });
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();

  // The edge sits where herdr says, not where the tiles happen to be.
  const bar = page.locator('.splitbar[data-direction="right"]');
  await expect(bar).toHaveCount(1);
  const stage = await page.locator(".tiles").boundingBox();
  const box = await bar.boundingBox();
  const at = Math.round(((box.x + 4 - stage.x) / stage.width) * 100);
  expect(Math.abs(at - 50)).toBeLessThanOrEqual(2);

  // Dragging asks herdr for a step rather than moving the edge locally, because
  // herdr owns the step size and clamps at its own minimum.
  await page.mouse.move(box.x + 4, box.y + 200);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) {
    await page.mouse.move(box.x + 4 - step * 20, box.y + 200);
  }
  await page.mouse.up();

  const sent = (page as Page & { resizes?: string[] }).resizes ?? [];
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  for (const body of sent) {
    expect(body).toBe(JSON.stringify({ direction: "left" }));
  }
});

test("one pane names itself once, not in three stacked lines", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // The tab names the pane; a single tile has no header of its own, and the
  // title line above says where the pane is rather than repeating its name.
  // (The picker button on the same row names the pane too, but that is the
  // phone's sheet opener and is hidden on a wide window.)
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText("w2:p1");
  await expect(page.locator(".tile__head")).toHaveCount(0);
  const title = page.locator(".stage__title");
  await expect(title).not.toContainText("w2:p1");
  await expect(title).toContainText("api");
});

test("a split labels each tile, because one tab holds several panes", async ({ page }) => {
  await installBridge(page, { splitWith: ["w1:p2"] });
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await expect(page.locator(".tile__head")).toHaveCount(2);
});

test("a split has no edge to drag on a phone, because it stacks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page, { splitWith: ["w1:p2"] });
  await page.goto("/");
  await expect(page.locator(".tile")).toHaveCount(2);
  await expect(page.locator(".splitbar")).toHaveCount(0);
});

test("a pane whose directory is not on this host is marked remote", async ({ page }) => {
  await installBridge(page, { pathMissing: true });
  await page.goto("/");
  // The mark sits beside the directory it applies to, which is the one place
  // that survives when the tab holds a single pane.
  await expect(page.locator(".stage__remote")).toHaveText("remote");
});

test("a local pane carries no remote mark", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator(".stage__remote")).toHaveCount(0);
  await expect(page.locator(".tile__remote")).toHaveCount(0);
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

test("a path in the output opens its preview, and Escape closes it", async ({ page }) => {
  await installBridge(page, { readText: "wrote /tmp/chart.png and /tmp/run.log\n" });
  await page.route("**/api/v1/herdr/file?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        path === "/tmp/chart.png"
          ? { path, name: "chart.png", bytes: 2048, kind: "image" }
          : { path, name: "run.log", bytes: 12, kind: "text", text: "hello herdr\n", truncated: false },
      ),
    });
  });
  // The image itself: without this the element is removed as soon as the real
  // request fails, which is what the preview does when a file cannot be read.
  // A real 1x1 PNG: the preview is an <img>, and a body the browser cannot decode
  // is what the element's own error handler treats as "the file could not be read".
  await page.route(/\/api\/v1\/herdr\/file\/raw/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  await page.goto("/");

  // Two paths in a line are two separate links, and prose is not.
  const links = page.locator("#herdr-feed-text .path");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("data-path", "/tmp/chart.png");

  await links.nth(0).click();
  const viewer = page.locator(".viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute("data-kind", "image");
  await expect(page.locator("#herdr-viewer-image")).toHaveAttribute(
    "src",
    /^\/api\/v1\/herdr\/file\/raw\?path=%2Ftmp%2Fchart.png$/,
  );

  // The prompt holds the caret, so Escape reaches the composer first. It must
  // close the viewer rather than switch the keyboard to raw mode, or the
  // overlay would be left open with no way out.
  await page.locator("#herdr-input").focus();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.locator(".prompt")).not.toHaveAttribute("data-raw", "on");

  // A text file shows its contents in place.
  await links.nth(1).click();
  await expect(page.locator("#herdr-viewer-text")).toContainText("hello herdr");
});

test("a path that is not on this host says so instead of showing nothing", async ({ page }) => {
  await installBridge(page, { readText: "wrote /remote/only/chart.png\n" });
  await page.route("**/api/v1/herdr/file?*", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "file not found" } }),
    }),
  );
  await page.goto("/");

  await page.locator("#herdr-feed-text .path").first().click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-kind", "missing");
  await expect(page.locator(".viewer__note")).toContainText("not on this host");
  await page.locator("#herdr-viewer-close").click();
  await expect(page.locator(".viewer")).toHaveCount(0);
});

test("the strip's + makes a new pane by splitting the open one", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");

  // Sideways where there is room; stacked on a phone, where side by side would
  // leave neither pane readable.
  await page.locator("#herdr-new-pane").click();
  const sent = (page as Page & { splits?: string[] }).splits ?? [];
  await expect.poll(() => sent).toEqual([JSON.stringify({ direction: "right" })]);
  // The new pane becomes the one being typed at.
  await expect(page.locator("#herdr-input")).toHaveAttribute("placeholder", "send to w1:p9");
});

test("a split keeps the view where it was, and selects the new pane at once", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveCount(1);

  await page.locator("#herdr-new-pane").click();

  // The new pane is not in herdr's pane list until the next poll. The console
  // must not go blank or jump to another workspace in the meantime: the tab
  // stays selected, the pane joins the list at once, and the prompt aims at it.
  await expect(page.locator("#herdr-input")).toHaveAttribute("placeholder", "send to w1:p9");
  await expect(page.locator('.tab[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('.side--spaces [aria-current="true"]')).toHaveAttribute(
    "data-workspace-id",
    "w1",
  );
  // The tab it landed in is the tab that is open, not the one whose label
  // happens to equal the new pane's id.
  await expect(page.locator('.strip .tab[data-pane-id="w1:p9"]')).toHaveCount(0);
});

test("a phone splits downwards", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");
  await page.locator("#herdr-new-pane").click();
  const sent = (page as Page & { splits?: string[] }).splits ?? [];
  await expect.poll(() => sent).toEqual([JSON.stringify({ direction: "down" })]);
});

test("a split offers both directions and a close from the pane menu", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--agents .row[data-pane-id="w1:p2"]').click({ button: "right" });

  const menu = page.locator('[role="menu"]');
  await expect(menu).toContainText("Split right");
  await expect(menu).toContainText("Split down");
  await expect(menu).toContainText("Close pane");

  await page.getByRole("menuitem", { name: /Split down/ }).click();
  const sent = (page as Page & { splits?: string[] }).splits ?? [];
  await expect.poll(() => sent).toEqual([JSON.stringify({ direction: "down" })]);
});

test("closing a pane asks first, because it ends what runs there", async ({ page }) => {
  // Both panes of the tab are listed, so the pair stays a pair whichever of
  // them is the active one; a one-sided mock would collapse to a single tile
  // as soon as the click activated the other pane.
  await installBridge(page, { splitWith: ["w1:p1", "w1:p2"] });
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await expect(page.locator(".tile")).toHaveCount(2);

  const close = page.locator('.tile[data-pane-id="w1:p2"] .tile__close');
  // Refusing the prompt closes nothing.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await close.click({ force: true });
  await page.waitForTimeout(200);
  expect((page as Page & { closes?: string[] }).closes).toEqual([]);

  // Accepting it closes that pane.
  page.once("dialog", (dialog) => void dialog.accept());
  await close.click({ force: true });
  const closes = (page as Page & { closes?: string[] }).closes ?? [];
  await expect.poll(() => closes.length).toBe(1);
});

test("a daemon restart keeps the view instead of blanking it", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator(".offline")).toHaveCount(0);

  // herdr restarting is not herdr empty. The console says so and holds on to
  // what it last knew, rather than showing a console with nothing in it.
  await page.route("**/api/v1/herdr/*", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "herdr_unreachable", message: "daemon restarting" } }),
    }),
  );
  await expect(page.locator(".offline")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".offline")).toContainText("not reachable");
  await expect(page.locator('.side--spaces [data-workspace-id="w1"]')).toHaveCount(1);
  await expect(page.locator(".tile")).toHaveCount(1);
  // A 502 from the bridge means the console cannot reach it at all, which the
  // cluster words as "not reachable"; a reachable bridge with a dead daemon
  // says "daemon down".
  await expect(page.locator(".offline")).toContainText("not reachable");
  // The machine's name does not change because the daemon is down: it is this
  // console's build, read from the console itself.
  await expect(page.locator("#herdr-host-open")).toContainText("herdr v0.3.1");
});

test("the daemon state opens a panel that can install or update herdr", async ({ page }) => {
  const actions: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        binary: "/Users/op/.local/bin/herdr",
        clientVersion: "0.9.0",
        channel: "stable",
        serverRunning: true,
        serverVersion: "0.9.0",
        serverStatus: "running",
        compatible: true,
        socket: "/Users/op/.config/herdr/herdr.sock",
        restartNeeded: false,
        serverBinaryStale: false,
        installMethod: "direct",
        latestVersion: "0.9.5",
        updateAvailable: true,
        canUpdate: true,
        error: "",
      }),
    }),
  );
  // Only the two actions, so the path probe for /host/stat is not counted.
  for (const action of ["update", "install"]) {
    await page.route(`**/api/v1/herdr/host/${action}`, async (route) => {
      actions.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, command: "herdr update", output: "updated to 0.9.5", exitCode: 0 }),
      });
    });
  }
  await page.goto("/");

  await page.locator("#herdr-host-open").click();
  const panel = page.locator(".hostpanel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#herdr-host-installed")).toContainText("/Users/op/.local/bin/herdr");
  await expect(panel).toContainText("latest 0.9.5");

  // A newer release turns the action into what it will do.
  const update = page.locator("#herdr-host-update");
  await expect(update).toContainText("update to 0.9.5");
  page.once("dialog", (dialog) => void dialog.accept());
  await update.click();
  await expect.poll(() => actions).toEqual(["/api/v1/herdr/host/update"]);
  await expect(page.locator("#herdr-host-output")).toContainText("updated to 0.9.5");
});

test("a stopped daemon says what to run, instead of leaving it at not running", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        binary: "/home/op/.local/bin/herdr",
        clientVersion: "0.9.5",
        channel: "stable",
        serverRunning: false,
        serverVersion: "",
        serverStatus: "stopped",
        compatible: true,
        socket: "/home/op/.config/herdr/herdr.sock",
        restartNeeded: false,
        serverBinaryStale: false,
        installMethod: "direct",
        latestVersion: "0.9.5",
        updateAvailable: false,
        canUpdate: true,
        error: "",
      }),
    }),
  );
  await page.goto("/");
  await page.locator("#herdr-host-open").click();

  await expect(page.locator(".hostpanel")).toContainText("not running");
  // An update stops an old server on purpose; a stopped daemon is a step, and
  // the panel has to say which command finishes it.
  const hint = page.locator("#herdr-daemon-hint");
  await expect(hint).toBeVisible();
  // herdr is a terminal application: the hint has to give a command that works
  // over ssh, not just say "run herdr".
  // herdr runs its own headless server: a second multiplexer underneath it was
  // the wrong answer, and the hint must not send anyone to tmux.
  await expect(hint).toContainText("herdr server");
  await expect(hint).not.toContainText("tmux");
  await expect(page.locator("#herdr-restart-hint")).toHaveCount(0);
});

test("a server on an older build names the command that picks the new one up", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        binary: "/home/op/.local/bin/herdr",
        clientVersion: "0.9.5",
        channel: "stable",
        serverRunning: true,
        serverVersion: "0.8.2",
        serverStatus: "running",
        compatible: true,
        socket: "/home/op/.config/herdr/herdr.sock",
        restartNeeded: true,
        serverBinaryStale: true,
        installMethod: "direct",
        latestVersion: "0.9.5",
        updateAvailable: false,
        canUpdate: true,
        error: "",
      }),
    }),
  );
  await page.goto("/");
  await page.locator("#herdr-host-open").click();

  await expect(page.locator(".hostpanel")).toContainText("restart needed");
  const hint = page.locator("#herdr-restart-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("herdr server");
  // Stopping a server ends its panes, so the panel says so rather than doing it.
  await expect(hint).toContainText("ends its panes");
  await expect(page.locator("#herdr-daemon-hint")).toHaveCount(0);
});

test("a missing herdr offers install, and a nix copy is left to nix", async ({ page }) => {
  await installBridge(page);
  let host: Record<string, unknown> = {
    installed: false,
    binary: "",
    clientVersion: "",
    channel: "",
    serverRunning: false,
    serverVersion: "",
    serverStatus: "",
    compatible: false,
    socket: "/Users/op/.config/herdr/herdr.sock",
    restartNeeded: false,
    serverBinaryStale: false,
    installMethod: "unknown",
    latestVersion: "0.9.5",
    updateAvailable: false,
    canUpdate: false,
    error: "herdr is not installed on this host",
  };
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(host) }),
  );
  await page.route("**/api/v1/herdr/host/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, command: "sh -c curl …", output: "installed 0.9.5", exitCode: 0 }),
    }),
  );
  await page.goto("/");
  await page.locator("#herdr-host-open").click();

  await expect(page.locator("#herdr-host-installed")).toContainText("not on this host");
  await expect(page.locator("#herdr-host-install")).toBeVisible();
  await expect(page.locator("#herdr-host-update")).toHaveCount(0);

  // A copy from nix is updated by nix, so no button is offered for it.
  host = { ...host, installed: true, binary: "/nix/store/x/bin/herdr", installMethod: "nix", canUpdate: false };
  await page.locator("#herdr-host-refresh").click();
  await expect(page.locator("#herdr-host-install")).toHaveCount(0);
  await expect(page.locator("#herdr-host-update")).toHaveCount(0);
  await expect(page.locator(".hostpanel")).toContainText("update it with that package manager");
});

/* ----------------------------------------------------------------- prompt */

test("enter types the line key by key and keeps history", async ({ page }) => {
  const keyPosts: string[] = [];
  const inputPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/v1/herdr/panes/*/input", async (route) => {
    inputPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("echo hi");
  await input.press("Enter");
  // Typed, not pasted: a TUI treats pasted text literally and opens no menus
  // for it, so the composer types plain ASCII and reserves a paste for what a
  // key cannot carry.
  await expect
    .poll(() => keyPosts)
    // A space is "space" to the daemon: it rejects " " as a key.
    .toEqual([JSON.stringify({ keys: ["e", "c", "h", "o", "space", "h", "i", "Enter"] })]);
  expect(inputPosts).toEqual([]);
  await expect(input).toHaveValue("");

  await input.fill("echo again");
  await input.press("Enter");
  await expect.poll(() => keyPosts).toHaveLength(2);
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

test("text a key cannot carry is sent as text", async ({ page }) => {
  const keyPosts: string[] = [];
  const inputPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/v1/herdr/panes/*/input", async (route) => {
    inputPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("检查一下这个目录");
  await input.press("Enter");
  await expect.poll(() => inputPosts).toEqual([JSON.stringify({ text: "检查一下这个目录\n" })]);
  expect(keyPosts).toEqual([]);
});

test("shift+enter writes a newline instead of sending", async ({ page }) => {
  const keyPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("first line");
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  await expect(input).toHaveValue("first line\nsecond line");
  // Nothing went out: the box is a place to write a message, not a terminal.
  expect(keyPosts).toEqual([]);
});

test("tab hands the line to the pane so completion continues there", async ({ page }) => {
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
  // The line is typed without Enter, then a real Tab completes it in the pane.
  // Completion is the pane's line editor doing the work, so the box gives the
  // line up rather than keeping a second copy that Enter would resend.
  await expect
    .poll(() => keyPosts)
    .toEqual([
      JSON.stringify({ keys: ["g", "i", "t", "space", "c", "h"] }),
      JSON.stringify({ keys: ["Tab"] }),
    ]);
  expect(inputPosts).toEqual([]);
  await expect(input).toHaveValue("");
  await expect(page.locator(".prompt")).toHaveAttribute("data-raw", "on");

  // And the next Tab goes straight to the pane, which is the point.
  await input.press("Tab");
  await expect.poll(() => keyPosts).toHaveLength(3);
  expect(JSON.parse(keyPosts[2])).toEqual({ keys: ["Tab"] });
});

test("a slash command types its characters and leaves the menu open", async ({ page }) => {
  const keyPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("/model");
  await input.press("Enter");
  // Enter must not arrive with the characters: an agent's slash command opens a
  // menu for the rest of the line, and an Enter here would pick the first entry
  // before the operator saw it.
  await expect
    .poll(() => keyPosts)
    .toEqual([JSON.stringify({ keys: ["/", "m", "o", "d", "e", "l"] })]);
  await expect(page.locator(".prompt")).toHaveAttribute("data-raw", "on");
  await expect(input).toHaveValue("");

  // The menu is driven from here now: arrows and Enter are the pane's.
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect.poll(() => keyPosts).toHaveLength(3);
  expect(JSON.parse(keyPosts[1])).toEqual({ keys: ["Down"] });
  expect(JSON.parse(keyPosts[2])).toEqual({ keys: ["Enter"] });
});

test("raw mode forwards every key to the pane, so completion and Ctrl work", async ({ page }) => {
  const keyPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.click();
  await input.press("Escape");
  // The composer becomes a keyboard for the pane: this is the only way the
  // shell's own line editor — completion, history, Ctrl-C — stays reachable.
  await expect(page.locator(".prompt")).toHaveAttribute("data-raw", "on");
  await expect(page.locator("#herdr-raw-off")).toBeVisible();

  await input.pressSequentially("ec");
  await input.press("Tab");
  await input.press("Control+c");
  await expect
    .poll(() => keyPosts)
    .toEqual([
      JSON.stringify({ keys: ["e"] }),
      JSON.stringify({ keys: ["c"] }),
      JSON.stringify({ keys: ["Tab"] }),
      JSON.stringify({ keys: ["ctrl+c"] }),
    ]);

  // Escape belongs to the pane: it cancels a menu or leaves insert mode, and
  // taking it here is what made an agent's "/model" impossible to back out of.
  await input.press("Escape");
  await expect.poll(() => keyPosts.length).toBe(5);
  expect(JSON.parse(keyPosts[4])).toEqual({ keys: ["esc"] });
  await expect(page.locator(".prompt")).toHaveAttribute("data-raw", "on");
  // Nothing is typed into the box, and the textarea keeps the focus so the
  // keyboard stays where the operator put it.
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();

  // Shift+Escape is the way out, because a TUI does not want that chord.
  await input.press("Shift+Escape");
  await expect(page.locator(".prompt")).not.toHaveAttribute("data-raw", "on");
});

test("opening a pane puts the caret in the prompt", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.locator("#herdr-input")).toBeFocused();

  // Switching pane takes the caret with it, without a click. The blocked
  // workspace opens first, so move to the one with two panes.
  await page.locator('.side--spaces [data-workspace-id="w1"]').click();
  await expect(page.locator("#herdr-input")).toBeFocused();
  await page.locator('.strip .tab[data-pane-id="w1:p2"]').click();
  await expect(page.locator("#herdr-input")).toBeFocused();

  // Clicking plain page chrome moves focus away; Tab brings it back.
  await page.locator("h1").click();
  await expect(page.locator("#herdr-input")).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#herdr-input")).toBeFocused();

  // And so does Enter.
  await page.locator("h1").click();
  await expect(page.locator("#herdr-input")).not.toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#herdr-input")).toBeFocused();
});

test("Enter on a focused button still presses it, not the prompt", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.locator("#herdr-display-exact").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#herdr-display-exact")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#herdr-input")).not.toBeFocused();
});

test("an attached file is uploaded and its host path lands in the prompt", async ({ page }) => {
  const uploaded: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/uploads", async (route) => {
    uploaded.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        path: "/Users/op/.local/share/herdr-web/uploads/20261018-shot.png",
        name: "20261018-shot.png",
        bytes: 12,
      }),
    });
  });
  await page.goto("/");

  // herdr can only send text, so the agent is handed the file's path.
  await page.locator("#herdr-attach").setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("fake"),
  });
  await expect
    .poll(async () => page.locator("#herdr-input").inputValue())
    .toBe("/Users/op/.local/share/herdr-web/uploads/20261018-shot.png ");
  expect(uploaded).toHaveLength(1);
  await expect(page.locator("#herdr-input")).toBeFocused();
});

test("a dropped file is attached the same way", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/uploads", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, path: "/tmp/dropped.png", name: "dropped.png", bytes: 3 }),
    }),
  );
  await page.goto("/");

  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["abc"], "dropped.png", { type: "image/png" }));
    return transfer;
  });
  await page.locator(".prompt").dispatchEvent("drop", { dataTransfer });
  await expect.poll(async () => page.locator("#herdr-input").inputValue()).toBe("/tmp/dropped.png ");
});

test("a failed upload says so and leaves the prompt alone", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/uploads", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "upload_failed", message: "boom" } }),
    }),
  );
  await page.goto("/");

  await page.locator("#herdr-attach").setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("fake"),
  });
  await expect(page.locator(".prompt__problem")).toContainText("could not attach shot.png");
  await expect(page.locator("#herdr-input")).toHaveValue("");
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

test("a phone hides both sidebar halves and offers one switcher instead", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");

  // Neither half is on screen, and nothing scrolls sideways to reach them.
  await expect(page.locator(".sidebar")).toBeHidden();

  const pick = page.locator("#herdr-picker-open");
  await expect(pick).toBeVisible();
  await pick.click();

  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  // Two views, switched rather than stacked: agents first, spaces one tap away.
  await expect(page.locator("#herdr-sheet-view-agents")).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator(".srow[data-pane-id]")).toHaveCount(2);
  await expect(sheet.locator("[data-workspace-id]")).toHaveCount(0);

  await page.locator("#herdr-sheet-view-spaces").click();
  await expect(page.locator("#herdr-sheet-view-spaces")).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator("[data-workspace-id]")).toHaveCount(2);
  await expect(sheet.locator(".srow[data-pane-id]")).toHaveCount(0);

  // Picking a space returns to the agents, now scoped by the new selection.
  await sheet.locator('[data-workspace-id="w1"]').click();
  await expect(page.locator("#herdr-sheet-view-agents")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#herdr-sheet-title")).toHaveText("web");
  await expect(sheet.locator(".srow[aria-current=\"true\"]")).toHaveCount(1);
});

test("picking an agent closes the sheet and opens it in the transcript", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installBridge(page);
  await page.goto("/");
  await page.locator("#herdr-picker-open").click();

  await page.locator('.sheet .srow[data-pane-id="w1:p2"]').click();
  await expect(page.locator(".sheet")).toHaveCount(0);
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText("vnstat 区间流量合计脚本");
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


test("the console can update itself and says how to start the new build", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        binary: "/home/op/.local/bin/herdr",
        clientVersion: "0.9.5",
        channel: "stable",
        serverRunning: true,
        serverVersion: "0.9.5",
        serverStatus: "running",
        compatible: true,
        socket: "/home/op/.config/herdr/herdr.sock",
        restartNeeded: false,
        serverBinaryStale: false,
        installMethod: "direct",
        latestVersion: "0.9.5",
        updateAvailable: false,
        canUpdate: true,
        error: "",
      }),
    }),
  );
  const calls: string[] = [];
  await page.route("**/api/v1/herdr-web/update", async (route) => {
    calls.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        updated: true,
        restart: "make service-restart",
        steps: [
          { step: "verify", ok: true, detail: "checksum matches (abc123)" },
          { step: "replace", ok: true, detail: "installed abc123", changed: true },
        ],
      }),
    });
  });
  await page.goto("/");
  await page.locator("#herdr-host-open").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#herdr-console-update").click();

  // The bytes are replaced but the process that answered is still the old one,
  // so the panel has to say how to start the new build.
  await expect(page.locator("#herdr-host-output")).toContainText("checksum matches");
  await expect(page.locator("#herdr-host-output")).toContainText("make service-restart");
  // No source is sent: the console decides where an update comes from.
  expect(calls).toEqual(["{}"]);
});

test("the masthead names the machine and the console build, not the daemon", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  // The test page is served from 127.0.0.1, so the address is implied and the
  // label is just the build this console runs.
  await expect(page.locator("#herdr-daemon-label")).toHaveText(/^herdr v\d+\.\d+\.\d+/);
});



test("the tab title names the machine, so consoles on several hosts differ", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  // Served over loopback in the test: the address is implied, the build is not.
  await expect(page).toHaveTitle(/^herdr v\d+\.\d+\.\d+/);
  await expect(page.locator("#herdr-daemon-label")).toHaveText(/^herdr v\d+\.\d+\.\d+/);
});

test("ctrl+c interrupts the pane, but copies when something is selected", async ({ page }) => {
  const keyPosts: string[] = [];
  await installBridge(page);
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    keyPosts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.click();
  await input.pressSequentially("some text");
  // Nothing selected: Ctrl-C is the terminal's interrupt, not the browser's copy.
  await input.press("Control+c");
  await expect.poll(() => keyPosts).toEqual([JSON.stringify({ keys: ["ctrl+c"] })]);

  // With a selection the browser owns it: sending it to the pane would steal a
  // copy the operator asked for.
  await input.selectText();
  await input.press("Control+c");
  await page.waitForTimeout(300);
  expect(keyPosts).toHaveLength(1);

  // Ctrl-D ends input, and the same rule applies.
  await input.click();
  await input.press("Control+d");
  await expect.poll(() => keyPosts).toHaveLength(2);
  expect(JSON.parse(keyPosts[1])).toEqual({ keys: ["ctrl+d"] });
});

test("a workspace can be made, and a running tmux session taken over", async ({ page }) => {
  await installBridge(page);
  const created: string[] = [];
  await page.route("**/api/v1/herdr/tmux", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        sessions: [
          { name: "work", windows: 2, attached: 0 },
          { name: "codex", windows: 1, attached: 1 },
        ],
      }),
    }),
  );
  await page.route("**/api/v1/herdr/workspaces", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    created.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, workspaceId: "w1", paneId: "w1:p1", label: "made" }),
    });
  });
  await page.goto("/");

  // There was no way to make a workspace at all; the count in the header is where
  // it belongs, next to the list it affects.
  await page.locator("#herdr-new-workspace").click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("take over a tmux session");

  await page.locator("#workspace-label").fill("made");
  await page.locator("#workspace-cwd").fill("/tmp");
  await page.locator("#workspace-create").click();
  await expect.poll(() => created).toEqual([JSON.stringify({ label: "made", cwd: "/tmp" })]);
  await expect(page.locator(".sheet")).toHaveCount(0);

  // herdr has no tmux integration, so taking a session over is a pane running
  // tmux attach — which is what makes an old session reachable again.
  await page.locator("#herdr-new-workspace").click();
  await page.locator('.newws__session[data-session="codex"]').click();
  await expect
    .poll(() => created[1] ?? "")
    .toBe(JSON.stringify({ command: ["tmux", "attach", "-t", "codex"] }));
});

test("the panel shows which consoles are in the fleet and which build each runs", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hub: true,
        hubUrl: "",
        follow: false,
        self: { id: "bendes", addr: "100.89.0.206:5000", version: "v0.3.1", platform: "linux-amd64" },
        peers: [
          { id: "tw1", addr: "100.89.0.4:5000", version: "v0.3.1", platform: "linux-amd64", seen: 0, stale: false },
          { id: "m8s", addr: "100.89.0.3:5000", version: "v0.3.0", platform: "linux-amd64", seen: 0, stale: true },
        ],
      }),
    }),
  );
  await page.goto("/");

  await page.locator("#herdr-host-open").click();
  const list = page.locator("#herdr-fleet-list");
  await expect(list).toBeVisible();
  await expect(list.locator("li")).toHaveCount(2);
  await expect(list.locator('[data-peer="tw1"]')).toContainText("100.89.0.4:5000");
  await expect(list.locator('[data-peer="tw1"]')).toContainText("v0.3.1");
  // A console that stopped reporting is shown as stale rather than removed: the
  // fleet should show what is missing, not just what is there.
  await expect(list.locator('[data-peer="m8s"]')).toContainText("stale");
});

test("the console can go back to the build it replaced", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/herdr/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        installed: true,
        binary: "/home/op/.local/bin/herdr",
        clientVersion: "0.9.5",
        channel: "stable",
        serverRunning: true,
        serverVersion: "0.9.5",
        serverStatus: "running",
        compatible: true,
        socket: "/home/op/.config/herdr/herdr.sock",
        restartNeeded: false,
        serverBinaryStale: false,
        installMethod: "direct",
        latestVersion: "0.9.5",
        updateAvailable: false,
        canUpdate: true,
        error: "",
      }),
    }),
  );
  let rolled = 0;
  await page.route("**/api/v1/herdr-web/rollback", async (route) => {
    rolled += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, rolled: true, restart: "systemctl --user restart dev.herdr-web" }),
    });
  });
  await page.goto("/");

  await page.locator("#herdr-host-open").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#herdr-console-rollback").click();
  await expect.poll(() => rolled).toBe(1);
  // An update that starts and then misbehaves is the failure the checksum cannot
  // catch, so the panel says what to do next.
  await expect(page.locator(".hostpanel__result")).toContainText("previous build restored");
});

test("one prompt can be sent to the whole fleet", async ({ page }) => {
  await installBridge(page);
  await page.route("**/api/v1/fleet", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hub: false,
        seeds: ["http://100.89.0.206:5000"],
        follow: true,
        self: { id: "me", addr: "100.89.0.116:5000", version: "v0.6.0", platform: "darwin-arm64" },
        peers: [
          { id: "tw1", addr: "100.89.0.4:5000", version: "v0.6.0", platform: "linux-amd64", agents: ["claude", "opencode"], seen: 0, stale: false },
          { id: "m9", addr: "100.89.0.9:5000", version: "v0.6.0", platform: "linux-amd64", agents: ["codex"], seen: 0, stale: false },
        ],
      }),
    }),
  );
  await page.route("**/api/v1/herdr/agents", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kinds: ["claude", "opencode"] }) }),
  );
  await page.route("**/api/v1/fleet/jobs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dispatches: [] }) }),
  );
  const sent: string[] = [];
  await page.route("**/api/v1/fleet/job", async (route) => {
    sent.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        dispatch: {
          id: "job-1",
          at: 0,
          prompt: "summarise the changelog",
          jobs: [
            { host: "http://100.89.0.4:5000", local: "w1:p1", jobId: "w1:p1", workspaceId: "w1", status: "working", output: "reading files" },
            { host: "http://100.89.0.9:5000", local: "w2:p1", jobId: "w2:p1", workspaceId: "w2", status: "blocked", output: "may I rewrite this file?" },
          ],
        },
      }),
    });
  });

  await page.goto("/");
  await page.locator("#herdr-host-open").click();
  await page.locator("#dispatch-open").click();

  const sheet = page.locator('.sheet[aria-label="Dispatch a job"]');
  await expect(sheet).toBeVisible();
  await expect(page.locator("#dispatch-kind")).toHaveValue("claude");
  // Only machines that can start the chosen agent are offered: a job sent where
  // the agent is not installed can only fail.
  await expect(sheet.locator('input[data-target="100.89.0.4:5000"]')).toBeChecked();
  await expect(sheet.locator('input[data-target="100.89.0.9:5000"]')).toBeDisabled();

  await page.locator("#dispatch-prompt").fill("summarise the changelog");
  await page.locator("#dispatch-send").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(JSON.parse(sent[0])).toMatchObject({
    prompt: "summarise the changelog",
    kind: "claude",
    targets: ["http://100.89.0.4:5000"],
  });

  // The status is the point: blocked means the agent wants a human, and that is
  // what makes a fleet worth watching from one place.
  await expect(sheet.locator('[data-host="http://100.89.0.9:5000"]')).toContainText("blocked");
  await expect(sheet.locator('[data-host="http://100.89.0.4:5000"]')).toContainText("working");
});

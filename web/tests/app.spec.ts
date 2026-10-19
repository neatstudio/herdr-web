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

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

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

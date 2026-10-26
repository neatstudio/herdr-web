import { expect, test, type Page } from "@playwright/test";

/*
 * What the composer says when a send does not finish.
 *
 * A line a key cannot carry goes out as a paste plus an Enter key: two requests,
 * and the pair can stop between them. These tests drive both halves to failure
 * and check that the operator is told which half landed, that a lost Enter can
 * be completed without typing the message a second time, and that a message that
 * never arrived stays in the box. The bridge is mocked at the HTTP boundary, as
 * the other browser suites do.
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

/** The pane's two write routes, with a switch per half to fail on demand. */
type Bridge = {
  inputPosts: string[];
  keyPosts: string[];
  failInput: boolean;
  failKeys: boolean;
};

const ok = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true }),
};

async function installBridge(page: Page): Promise<Bridge> {
  const bridge: Bridge = { inputPosts: [], keyPosts: [], failInput: false, failKeys: false };
  const down = {
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "herdr_unreachable", message: "daemon restarting" } }),
  };

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
  await page.route("**/api/v1/herdr/panes/*/input", async (route) => {
    bridge.inputPosts.push(route.request().postData() ?? "");
    await route.fulfill(bridge.failInput ? down : ok);
  });
  await page.route("**/api/v1/herdr/panes/*/keys", async (route) => {
    bridge.keyPosts.push(route.request().postData() ?? "");
    await route.fulfill(bridge.failKeys ? down : ok);
  });
  return bridge;
}

test("a lost Enter is reported, and the key alone finishes the send", async ({ page }) => {
  const bridge = await installBridge(page);
  // The paste is accepted; the key request behind it is not.
  bridge.failKeys = true;
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("检查一下这个目录");
  await input.press("Enter");

  // The text really did arrive, without a newline byte: the Enter is its own
  // request, so a raw-mode TUI gets a key press rather than a line break.
  await expect
    .poll(() => bridge.inputPosts)
    .toEqual([JSON.stringify({ text: "检查一下这个目录" })]);
  await expect(page.locator(".prompt__note-text")).toHaveText("in w2:p1, Enter did not land");
  // The message is in the pane's line editor. A copy left in the box would be
  // sent a second time on the next attempt, so the box is cleared.
  await expect(input).toHaveValue("");

  bridge.failKeys = false;
  await page.locator(".prompt__note-act", { hasText: "send ⏎" }).click();

  // Only the key goes out again; the message is not repeated.
  await expect
    .poll(() => bridge.keyPosts)
    .toEqual([
      JSON.stringify({ keys: ["Enter"] }),
      JSON.stringify({ keys: ["Enter"] }),
    ]);
  expect(bridge.inputPosts).toHaveLength(1);
  await expect(page.locator(".prompt__note-text")).toHaveCount(0);
});

test("a paste that never arrived keeps the draft and says so", async ({ page }) => {
  const bridge = await installBridge(page);
  bridge.failInput = true;
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("检查一下这个目录");
  await input.press("Enter");

  await expect(page.locator(".prompt__note-text")).toHaveText(
    "could not reach w2:p1, message kept",
  );
  // Nothing reached the pane, so nothing may be lost: the draft is still here
  // and not in history, and no submit key was sent into the void.
  await expect(input).toHaveValue("检查一下这个目录");
  expect(bridge.keyPosts).toHaveLength(0);

  // The operator's next attempt is the same button as the first one.
  bridge.failInput = false;
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.locator(".prompt__note-text")).toHaveCount(0);
  await expect
    .poll(() => bridge.keyPosts)
    .toEqual([JSON.stringify({ keys: ["Enter"] })]);
});

test("a typed line that never landed stays in the box", async ({ page }) => {
  const bridge = await installBridge(page);
  // Plain ASCII is typed as one key request, Enter included; that request fails.
  bridge.failKeys = true;
  await page.goto("/");

  const input = page.locator("#herdr-input");
  await input.fill("ls -la");
  await input.press("Enter");

  await expect(page.locator(".prompt__note-text")).toHaveText(
    "could not reach w2:p1, message kept",
  );
  await expect(input).toHaveValue("ls -la");
  expect(bridge.inputPosts).toHaveLength(0);
  expect(bridge.keyPosts).toHaveLength(1);
});

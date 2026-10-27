import { expect, test, type Page } from "@playwright/test";

/*
 * The reading setting, reached from the phone's sheet.
 *
 * The transcript is read, not driven, so the one thing a phone needs to be
 * usable at all is a way to say how big that text is and how long its line is.
 * Both live in the sheet's third tab and are applied as custom properties on
 * <html> — the stylesheet keeps owning every row, target and min-height, which
 * is why these tests check the properties and the painted prose, not a pile of
 * new one-off numbers.
 *
 * The whole file is a touch device: the default size and measure are the
 * coarse-pointer ones, and the sheet is a phone-only surface.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

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

/* Plain sentences, so the conversation reader paints them as answer prose. */
const SNAPSHOT = [
  "I fixed the retry and the parser now gives up after two attempts instead of",
  "one, which is what the failing case was actually about.",
  "",
  "The suite is green again and nothing else moved.",
  "",
].join("\n");

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The bridge, mocked at the HTTP boundary: nothing here may reach a real pane. */
async function installBridge(page: Page): Promise<void> {
  // Last route registered wins, so the fallback goes first.
  await page.route("**/api/v1/herdr/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/herdr/status", (route) =>
    route.fulfill(json({ enabled: true, status: "ok", version: "0.9.0", protocol: 22 })),
  );
  await page.route("**/api/v1/herdr/workspaces", (route) => route.fulfill(json([WORKSPACE])));
  await page.route("**/api/v1/herdr/workspaces/*", (route) =>
    route.fulfill(json({ workspace: WORKSPACE, panes: [PANE] })),
  );
  await page.route("**/api/v1/herdr/panes", (route) => route.fulfill(json({ panes: [PANE] })));
  await page.route("**/api/v1/herdr/panes/*/read*", (route) =>
    route.fulfill(
      json({
        paneId: PANE.id,
        source: "recent",
        format: "ansi",
        text: SNAPSHOT,
        revision: 2,
        truncated: false,
        agentStatus: "idle",
      }),
    ),
  );
  await page.route("**/api/v1/herdr/panes/*/keys", (route) => route.fulfill(json({ ok: true })));
}

/** The transcript lens, chosen before the shell reads the stored value. */
async function openTranscript(page: Page): Promise<void> {
  await installBridge(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("herdr:lens:w2:p1", "chat");
    } catch {
      /* the shell falls back to the pane's own default */
    }
  });
  await page.goto("/");
  await expect(page.locator(".chat__prose").first()).toBeVisible();
}

/** The sheet, open on its third tab. */
async function openTextTab(page: Page): Promise<void> {
  await page.locator("#herdr-picker-open").click();
  await expect(page.locator(".sheet")).toBeVisible();
  await page.locator("#herdr-sheet-view-text").click();
  await expect(page.locator("#herdr-sheet-panel-text")).toBeVisible();
}

/** What the transcript is actually painted with. */
async function painted(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const prose = document.querySelector<HTMLElement>(".chat__prose");
    const sample = document.querySelector<HTMLElement>(".read__sample p");
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(".sheet__view"));
    const views = document.querySelector<HTMLElement>(".sheet__views");
    const box = prose?.getBoundingClientRect();
    return {
      body: root.style.getPropertyValue("--ui-body"),
      lane: root.style.getPropertyValue("--ui-lane"),
      dataSize: root.dataset.readSize ?? "",
      dataMeasure: root.dataset.readMeasure ?? "",
      proseSize: prose === null ? "" : getComputedStyle(prose).fontSize,
      proseLine: prose === null ? "" : getComputedStyle(prose).lineHeight,
      proseWidth: box === undefined ? 0 : Math.round(box.width),
      sampleSize: sample === null ? "" : getComputedStyle(sample).fontSize,
      tabs: tabs.length,
      columns: views === null ? "" : getComputedStyle(views).gridTemplateColumns,
      stored: window.localStorage.getItem("herdr-web-reading"),
    };
  });
}

test.describe("reading setting on a phone", () => {
  test("the sheet carries it as a third tab, next to the two lists", async ({ page }) => {
    await openTranscript(page);

    await page.locator("#herdr-picker-open").click();
    const tabs = page.locator(".sheet__view");
    await expect(tabs).toHaveCount(3);
    await expect(page.locator("#herdr-sheet-view-text")).toBeVisible();
    // The counters belong to the lists; the panel has nothing to count.
    await expect(page.locator("#herdr-sheet-view-text .sheet__view-count")).toHaveCount(0);

    await page.locator("#herdr-sheet-view-text").click();
    const panel = page.locator("#herdr-sheet-panel-text");
    await expect(panel).toBeVisible();

    // Six options, three per row, and the measured defaults are what is pressed.
    await expect(page.locator(".read__opt[data-read-size]")).toHaveCount(3);
    await expect(page.locator(".read__opt[data-read-measure]")).toHaveCount(3);
    await expect(page.locator('.read__opt[data-read-size="default"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('.read__opt[data-read-measure="default"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Nothing to reset while the defaults are already in force.
    await expect(page.locator(".read__reset")).toBeDisabled();

    // Three equal tabs on one row: the switch is not allowed to overflow.
    const { columns } = await painted(page);
    expect(columns.split(" ")).toHaveLength(3);
  });

  test("a larger size paints the transcript, the sample and the next load", async ({ page }) => {
    await openTranscript(page);
    const before = await painted(page);
    expect(before.proseSize).toBe("14px");

    await openTextTab(page);
    await page.locator('.read__opt[data-read-size="large"]').click();
    // The panel stays open on the choice: the sample is the evidence.
    await expect(page.locator("#herdr-sheet-panel-text")).toBeVisible();

    const large = await painted(page);
    expect(large.body).toBe("16.5px");
    expect(large.dataSize).toBe("large");
    expect(large.sampleSize).toBe("16.5px");
    expect(large.stored).toBe("large/default");

    // Close the sheet: the transcript behind it was repainted, not just stored.
    await page.locator(".sheet__close").click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    await expect(page.locator(".chat__prose").first()).toHaveCSS("font-size", "16.5px");

    // A reload reopens at the size that was chosen.
    await page.reload();
    await expect(page.locator(".chat__prose").first()).toBeVisible();
    expect((await painted(page)).proseSize).toBe("16.5px");
  });

  test("a narrow measure shortens the lanes and leaves the padding alone", async ({ page }) => {
    await openTranscript(page);
    const wide = await painted(page);

    await openTextTab(page);
    await page.locator('.read__opt[data-read-measure="narrow"]').click();
    const narrow = await painted(page);
    expect(narrow.lane).toContain("40px");
    expect(narrow.dataMeasure).toBe("narrow");
    expect(narrow.stored).toBe("default/narrow");

    await page.locator(".sheet__close").click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    // The measure is a lane width: the painted prose is narrower by the difference.
    expect(narrow.proseWidth).toBeLessThan(wide.proseWidth);
    expect(Math.abs(wide.proseWidth - narrow.proseWidth)).toBeGreaterThanOrEqual(14);
  });

  test("reset gives every property back to the stylesheet", async ({ page }) => {
    await openTranscript(page);
    await openTextTab(page);
    await page.locator('.read__opt[data-read-size="small"]').click();
    await page.locator('.read__opt[data-read-measure="wide"]').click();
    await expect(page.locator(".read__reset")).toBeEnabled();
    expect((await painted(page)).stored).toBe("small/wide");

    await page.locator(".read__reset").click();
    const reset = await painted(page);
    // Nothing is left inline on <html>: the media query owns the phone again.
    expect(reset.body).toBe("");
    expect(reset.lane).toBe("");
    // The dataset always names the state (it is a hook, not a style); the
    // inline properties are what must go back to the stylesheet.
    expect(reset.dataSize).toBe("default");
    expect(reset.dataMeasure).toBe("default");
    expect(reset.stored).toBe("default/default");
    await expect(page.locator('.read__opt[data-read-size="default"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".read__reset")).toBeDisabled();

    await page.locator(".sheet__close").click();
    await expect(page.locator(".chat__prose").first()).toHaveCSS("font-size", "14px");
  });

  test("an unreadable stored value falls back to the measured defaults", async ({ page }) => {
    await installBridge(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem("herdr:lens:w2:p1", "chat");
        localStorage.setItem("herdr-web-reading", "enormous/sideways");
      } catch {
        /* nothing to restore */
      }
    });
    await page.goto("/");
    await expect(page.locator(".chat__prose").first()).toBeVisible();
    const fallback = await painted(page);
    expect(fallback.body).toBe("");
    expect(fallback.proseSize).toBe("14px");
  });
});

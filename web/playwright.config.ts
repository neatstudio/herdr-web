import { defineConfig } from "@playwright/test";

const webPort = Number(process.env.HERDR_WEB_PORT ?? "5175");

export default defineConfig({
  testDir: "./tests",
  // Unit suites are .test.ts and belong to node:test; loading them here would
  // run their side effects and can leave the browser runner waiting on handles.
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    // System Chrome: the sandbox has no matching downloaded build for this
    // playwright copy, and the repo already runs its browser suites this way.
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
    url: `http://127.0.0.1:${webPort}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

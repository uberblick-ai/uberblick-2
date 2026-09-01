/**
 * The e2e harness (`mise run e2e`).
 *
 * Chromium only, one worker, no retries, no `webServer`:
 *
 * - **One worker, serial file.** The tests share one hub and one dev server —
 *   started by the spec itself (see e2e/harness.ts), because the dev server has
 *   to be told the hub's ephemeral port, and one proof point stops the hub
 *   mid-file. Parallel workers would fight over both.
 * - **No retries.** A real-browser test that only passes on the second attempt
 *   is not evidence of anything; a flake here should be visible, not absorbed.
 * - **Chromium only** — a cross-browser matrix is explicitly out of scope
 *   (#46). The behaviour under test is our collaboration wiring, not a
 *   browser's.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  // `list` is still the suite's reporter. The second one is #628's throwaway
  // spike: it files evidence for tests that carry a `scenario` annotation and
  // ignores every other test, so nothing here switches recording on suite-wide
  // — the video comes from a `test.use` scoped to one describe block.
  reporter: [["list"], ["./e2e/scenarios/evidence-reporter.ts"]],
  // Generous per test, not per run: the whole file is meant to finish in well
  // under 90s, and a stuck test should fail rather than hang the suite.
  timeout: 60_000,
  // Convergence over a websocket is not instant, and the first navigation waits
  // for vite to pre-bundle the app's dependencies.
  expect: { timeout: 20_000 },
  // Two projects, one browser. `video` is a worker-scoped option — Playwright
  // refuses it in a `test.use` inside a describe block — so a project is the
  // narrowest thing that can turn recording on for one scenario and nothing
  // else. #628's `@scenario` test runs only in the second; everything else runs
  // only in the first, unrecorded, exactly as before.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /@scenario/,
    },
    {
      name: "scenario",
      use: { ...devices["Desktop Chrome"], video: "on" },
      grep: /@scenario/,
    },
  ],
});

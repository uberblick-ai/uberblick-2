/**
 * The e2e harness (`mise run e2e`).
 *
 * Chromium only, one worker, no retries, no `webServer`:
 *
 * - **One worker, serial file.** A spec's tests share one hub and one `ub open`
 *   serving a private build (see e2e/harness.ts), and one proof point stops the
 *   hub mid-file. Keeping files serial also keeps the browser proof load bounded;
 *   separately started harnesses are collision-free and have a direct proof.
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
  reporter: [["list"]],
  // Generous per test, not per run: the whole file is meant to finish in well
  // under 90s, and a stuck test should fail rather than hang the suite.
  timeout: 60_000,
  // Convergence over a websocket is not instant, and the first navigation waits
  // for vite to pre-bundle the app's dependencies.
  expect: { timeout: 20_000 },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

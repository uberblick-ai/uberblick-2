/**
 * The e2e harness (`mise run e2e`).
 *
 * Full Chromium suite plus tagged supported-device WebKit proofs, two workers,
 * no retries, no `webServer`:
 *
 * - **Parallel files, serial tests.** A spec's tests share one hub and one
 *   `ub open`; fresh-harness specs retain test scope. Two workers bound load,
 *   and separately started harnesses have a direct collision-free proof.
 *   Global setup builds one run-owned bundle even for filtered runs. Only
 *   release-runtime, shared-controls and the compiled-loopback proof build separately.
 * - **No retries.** A real-browser test that only passes on the second attempt
 *   is not evidence of anything; a flake here should be visible, not absorbed.
 * - **Bounded WebKit set.** @webkit runs on iPhone and MacBook;
 *   @webkit-touch runs only on iPhone; @webkit-iphone adds the phone's
 *   short visual viewport. Chromium still runs every test, including its
 *   forced-width and forced-touch cases. Tagged WebKit tests inherit their
 *   project's viewport and input rather than resizing or enabling touch.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 2,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  reporter: [["list"]],
  // Generous per test, not per run: the whole file is meant to finish in well
  // under 90s, and a stuck test should fail rather than hang the suite.
  timeout: 60_000,
  // Convergence over a websocket is not instant.
  expect: { timeout: 20_000 },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-iphone",
      grep: /@webkit(?:-touch|-iphone)?(?:\s|$)/,
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "webkit-macbook",
      grep: /@webkit(?:\s|$)/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
    },
  ],
});

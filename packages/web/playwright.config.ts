/**
 * The e2e harness (`mise run e2e`).
 *
 * Full Chromium suite plus tagged supported-device WebKit proofs, one worker,
 * no retries, no `webServer`:
 *
 * - **One worker, serial file.** A spec's tests share one hub and one `ub open`
 *   serving a private build (see e2e/harness.ts), and one proof point stops the
 *   hub mid-file. Keeping files serial also keeps the browser proof load bounded;
 *   separately started harnesses are collision-free and have a direct proof.
 * - **No retries.** A real-browser test that only passes on the second attempt
 *   is not evidence of anything; a flake here should be visible, not absorbed.
 * - **Bounded WebKit set.** @webkit runs at all three supported devices;
 *   @webkit-touch runs only on iPhone/iPad; @webkit-iphone adds the phone's
 *   short visual viewport. Chromium still runs every test, including its
 *   forced-width and forced-touch cases. Tagged WebKit tests inherit their
 *   project's viewport and input rather than resizing or enabling touch.
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
    {
      name: "webkit-iphone",
      grep: /@webkit(?:-touch|-iphone)?(?:\s|$)/,
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "webkit-ipad",
      grep: /@webkit(?:-touch)?(?:\s|$)/,
      use: { ...devices["iPad (gen 7)"] },
    },
    {
      name: "webkit-macbook",
      grep: /@webkit(?:\s|$)/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
    },
  ],
});

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
 * - **Bounded WebKit set.** @webkit runs on iPad and MacBook;
 *   @webkit-touch runs only on iPad. Chromium still runs every test, including its
 *   forced-width and forced-touch cases. Tagged WebKit tests inherit their
 *   project's viewport and input rather than resizing or enabling touch.
 * - **Workload isolation.** Timing probes run after all interactive projects
 *   locally. CI selects them without dependencies on a separate runner, so
 *   layout/GC cannot compete with interactive input on the same host.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 2,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  reporter: [["list"], ["./e2e/timing-reporter.ts"]],
  // Generous per test, not per run: the whole file is meant to finish in well
  // under 90s, and a stuck test should fail rather than hang the suite.
  timeout: 60_000,
  // Convergence over a websocket is not instant.
  expect: { timeout: 20_000 },
  projects: [
    {
      name: "chromium",
      grepInvert: /@workload(?:\s|$)/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-ipad",
      grep: /@webkit(?:-touch)?(?:\s|$)/,
      use: { ...devices["iPad (gen 11)"] },
    },
    {
      name: "webkit-macbook",
      grep: /@webkit(?:\s|$)/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "chromium-workload",
      // Focused workload probes use --project=chromium-workload --no-deps.
      grep: /@workload(?:\s|$)/,
      dependencies: ["chromium", "webkit-ipad", "webkit-macbook"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

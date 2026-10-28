/**
 * The e2e harness (`mise run e2e`).
 *
 * Full Chromium suite plus tagged supported-device WebKit proofs, two interactive workers,
 * no retries, no `webServer`:
 *
 * - **Parallel files, serial tests.** A spec's tests share one hub and one
 *   `ub open`; fresh-harness specs retain test scope. Two workers bound load.
 *   Global setup builds one run-owned bundle even for filtered runs. Only
 *   release-runtime, shared-controls and the compiled-loopback proof build separately.
 * - **No retries.** A real-browser test that only passes on the second attempt
 *   is not evidence of anything; a flake here should be visible, not absorbed.
 *   A flaky test is quarantined instead (CONTRIBUTING.md, "CI").
 * - **Bounded WebKit set.** @webkit and @webkit-touch run on iPad. Chromium runs
 *   every test and covers the desktop, including its forced-width and forced-touch
 *   cases. Tagged WebKit tests use the iPad viewport and input, or explicit paired
 *   desktop/iPad contexts.
 * - **Workload isolation.** Timing probes run after all interactive projects
 *   locally. CI selects them without dependencies on a separate runner, so
 *   layout/GC cannot compete with interactive input on the same host.
 */

import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./e2e",
  workers: 2,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  retries: 0,
  use: { trace: "retain-on-failure" },
  forbidOnly: process.env.CI !== undefined,
  reporter: [["list"], ["./e2e/timing-reporter.ts", {
    outputFile: fileURLToPath(new URL("./test-results/test-durations.json", import.meta.url)),
  }]],
  // The reporter also enforces complete setup/body/cleanup cost on every host;
  // Playwright's separate teardown timeout cannot extend the test's budget.
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
      use: { ...devices["iPad (gen 7)"] },
    },
    {
      name: "chromium-workload",
      // Timing probes must not compete with one another on the same runner.
      workers: 1,
      // Focused workload probes use --project=chromium-workload --no-deps.
      grep: /@workload(?:\s|$)/,
      dependencies: ["chromium", "webkit-ipad"],
      use: { ...devices["Desktop Chrome"], trace: "off" },
    },
  ],
});

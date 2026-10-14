import { defineConfig } from "vitest/config";

// `mise run test-os`, the macOS CI job, runs only the suites whose behaviour
// can differ by OS: file modes, locks and paths, signals and process
// lifecycles. List a suite here when it tests such a seam.
const osSensitive = [
  "admin-setup",
  "admin-setup-public",
  "hub-admin-setup-wrapper",
  "persistence",
  "shutdown",
  "startup",
  "stop",
];

export default defineConfig({
  test: {
    include:
      process.env.UB_TEST_SCOPE === "os"
        ? osSensitive.map((name) => `test/${name}.test.ts`)
        : ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // CI output, as in packages/schema/vitest.config.ts.
    reporters: process.env.CI ? ["dot"] : ["default"],
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // Every suite binds real sockets and opens real SQLite files. They use
    // ephemeral ports and temp directories, so they are safe in parallel, but
    // the timeouts have to allow for a full connect/sync/shutdown round trip.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

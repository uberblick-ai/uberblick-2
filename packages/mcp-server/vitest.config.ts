import { defineConfig } from "vitest/config";

// `mise run test-os`, the macOS CI job, runs only the suites whose behaviour
// can differ by OS: file modes, locks and paths, signals and process
// lifecycles. List a suite here when it tests such a seam.
const osSensitive = [
  "config",
  "database-workspace",
  "dev-hub-config",
  "device-login",
  "device-shutdown",
  "device-sync-refusal",
  "document-data",
  "durability",
  "log",
  "pending-shutdown",
  "search-store",
  "server-close-reentry",
  "serving-engine",
  "shutdown",
  "shutdown-sync",
  "shutdown-timeout",
  "stdin-eof",
  "store",
  "store-open",
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
    // Allow sequential connect/sync/shutdown and restart waits on real sockets,
    // child processes and SQLite files. Exceed WAIT_TIMEOUT_MS in test/helpers.ts
    // so named waits diagnose a missing condition before the test deadline.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Socket, process and timer waits leave workers idle; allow oversubscription.
    maxWorkers: "150%",
  },
});

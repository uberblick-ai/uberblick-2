import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
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

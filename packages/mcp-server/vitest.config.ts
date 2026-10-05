import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // The hub-backed suites bind real sockets, spawn a real stdio server and
    // open real SQLite files. Ephemeral ports and temp directories keep them
    // safe in parallel, but the timeouts have to allow a full
    // connect/sync/shutdown round trip — and a reconnect after a hub restart.
    //
    // Deliberately well above the deadline any one wait here uses (see
    // WAIT_TIMEOUT_MS in test/helpers.ts): a test makes several waits in
    // sequence, and whichever timeout fires first is the one that gets to
    // explain the failure. A bare "test timed out in 30000ms" names nothing
    // and is what a loaded machine used to produce; the named wait says which
    // condition never arrived, which is the difference between a diagnosis and
    // a re-run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Most of a test here is spent waiting on sockets, child processes and
    // timers, not computing: at the default of one fewer worker than cores the
    // suite left over half the machine idle. Oversubscribe instead.
    maxWorkers: "150%",
  },
});

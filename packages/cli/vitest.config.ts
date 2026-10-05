import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // CI output, as in packages/schema/vitest.config.ts.
    reporters: process.env.CI ? ["dot"] : ["default"],
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // Builds the `ub` the spawning suites run, once for the whole run. See
    // test/global-setup.ts for why a bundler, and why the output lives where
    // it does.
    globalSetup: ["test/global-setup.ts"],
    // Most suites here spawn the real `ub` binary, which boots the MCP server,
    // opens a real SQLite file and gives the hub a bounded chance to answer.
    // Temp XDG directories and dead ports keep them safe in parallel, but the
    // timeouts have to allow a full spawn/connect/shutdown round trip.
    //
    // Deliberately well above the sum of the waits any one test makes in
    // sequence — the longest chains here are `ub init`'s concurrency test (four
    // rounds, each bounded by the 25 s `runUbAsync` gives a spawned run) and
    // `ub open`'s port-release test (two starts and two interrupts, each
    // bounded by WAIT_TIMEOUT_MS in test/helpers.ts). Whichever timeout fires
    // first is the one that gets to explain the failure, and a bare "test timed
    // out in 30000ms" names nothing — which is what a loaded machine used to
    // produce here. The named wait says which condition never arrived, and that
    // is the difference between a diagnosis and a re-run.
    testTimeout: 150_000,
    hookTimeout: 150_000,
    // Most of a test here is spent waiting on sockets, child processes and
    // timers, not computing: at the default of one fewer worker than cores the
    // suite left over half the machine idle. Oversubscribe instead.
    maxWorkers: "150%",
  },
});

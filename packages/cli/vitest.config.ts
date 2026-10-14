import { defineConfig } from "vitest/config";

// `mise run test-os`, the macOS CI job, runs only the suites whose behaviour
// can differ by OS: file modes, locks and paths, signals and process
// lifecycles. List a suite here when it tests such a seam.
const osSensitive = [
  "auth",
  "auth-browser",
  "auth-device-name",
  "auth-protocol",
  "auth-status",
  "auth-store",
  "browser",
  "browser-key",
  "cli",
  "config",
  "data-sync",
  "doctor",
  "doctor-persistence",
  "hub",
  "hub-backup-restore",
  "hub-host",
  "init-lock",
  "install",
  "launcher",
  "local-browser-server",
  "mise-welcome",
  "open",
  "open-account",
  "open-ports",
  "open-presence-name",
  "open-workspaces",
  "project-binding",
  "remote",
  "serve",
  "status",
  "storage",
  "storage-layout",
  "update",
  "workspace-create",
  "workspace-main-repository",
  "workspace-promotion",
  "workspace-registry",
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
    // Builds the `ub` the spawning suites run, once for the whole run. See
    // test/global-setup.ts for why a bundler, and why the output lives where
    // it does.
    // The binding setup checks the shared parent's bytes after all workers finish.
    globalSetup: ["test/global-setup.ts", "test/binding-fixtures.ts"],
    // Most suites here spawn the real `ub` binary, which boots the MCP server,
    // opens a real SQLite file and gives the hub a bounded chance to answer.
    // Temp XDG directories and dead ports keep them safe in parallel, but the
    // timeouts have to allow a full spawn/connect/shutdown round trip.
    //
    // Deliberately well above the sum of the waits any one test makes in
    // sequence — concurrent workspace creation is bounded by the 25 s
    // `runUbAsync` gives each spawned run, and
    // `ub open`'s port-release test (two starts and two interrupts, each
    // bounded by WAIT_TIMEOUT_MS in test/helpers.ts). Whichever timeout fires
    // first is the one that gets to explain the failure, and a bare "test timed
    // out in 30000ms" names nothing. The named wait says which condition never
    // arrived so the failure can be diagnosed.
    testTimeout: 150_000,
    hookTimeout: 150_000,
    // Most of a test here is spent waiting on sockets, child processes and
    // timers, not computing, so oversubscribe to use the cores during waits.
    maxWorkers: "150%",
  },
});

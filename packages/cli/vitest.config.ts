import { defineConfig } from "vitest/config";
import { vitestBudgets } from "../../scripts/vitest-budget-config.mjs";

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
  "init-lock",
  "install",
  "launcher",
  "local-browser-server",
  "open",
  "open-account",
  "open-detach-startup",
  "open-ports",
  "open-presence-name",
  "open-workspaces",
  "open-workspaces-detach",
  "open-workspaces-lifecycle",
  "project-binding",
  "project-binding-ownership",
  "remote",
  "serve",
  "status",
  "storage",
  "storage-layout",
  "update",
  "workspace",
  "workspace-binding-guard",
  "workspace-create",
  "workspace-detach",
  "workspace-fork",
  "workspace-main-repository",
  "workspace-promotion",
  "workspace-registry",
  "worktree-launcher",
];

export default defineConfig({
  test: {
    include:
      process.env.UB_TEST_SCOPE === "os"
        ? osSensitive.map((name) => `test/${name}.test.ts`)
        : ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    ...vitestBudgets("cli"),
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // Builds the `ub` the spawning suites run, once for the whole run. See
    // test/global-setup.ts for why a bundler, and why the output lives where
    // it does.
    // The binding setup checks the shared parent's bytes after all workers finish.
    globalSetup: ["test/global-setup.ts", "test/binding-fixtures.ts"],
    // Named waits expire inside the complete-attempt budget so their own
    // condition names remain visible when setup or shutdown fails.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Standalone runs use one worker per core. The root test commands supply
    // an integer VITEST_MAX_WORKERS from their shared machine budget.
    maxWorkers: "100%",
  },
});

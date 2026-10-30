import { defineConfig } from "vitest/config";
import { vitestBudgets } from "../../scripts/vitest-budget-config.mjs";

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
  "history-cache",
  "history-cache-garbage",
  "history-holds",
  "history-mirror-cache",
  "history-refresher-role",
  "history-refresher",
  "host-entry",
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
  "workspace-fork",
  "workspace-history",
  "workspace-removal",
  "workspace-detach",
];

const osOnly = process.env.UB_TEST_SCOPE === "os";
const core = "test/**/*.core.test.ts";
const processes = "test/**/*.process.test.ts";

function suites(suffix: string): string[] {
  return osOnly
    ? osSensitive.map((name) => `test/${name}${suffix}.test.ts`)
    : [`test/**/*${suffix}.test.ts`];
}

export default defineConfig({
  test: {
    environment: "node",
    ...vitestBudgets("mcp-server"),
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // Standalone runs use one worker per core; root runs share a machine budget.
    maxWorkers: "100%",
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          include: [...suites(".core"), ...(osOnly ? [] : ["src/**/*.test.ts"])],
          // Only transport-free, in-memory tests share a module graph.
          // Module mocks and MCP boundary tests stay in the isolated tier.
          isolate: false,
          testTimeout: 10_000,
          hookTimeout: 10_000,
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: suites("{,.*}"),
          exclude: [core, processes],
          isolate: true,
          // Exceed the named real-time waits so their diagnostics arrive first.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "process",
          include: suites(".process"),
          isolate: true,
          globalSetup: ["test/process-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

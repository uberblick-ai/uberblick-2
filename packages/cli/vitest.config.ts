import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Most suites here spawn the real `ub` binary, which boots the MCP server,
    // opens a real SQLite file and gives the hub a bounded chance to answer.
    // Temp XDG directories and dead ports keep them safe in parallel, but the
    // timeouts have to allow a full spawn/connect/shutdown round trip.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

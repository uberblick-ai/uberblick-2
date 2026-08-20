import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // The hub-backed suites bind real sockets, spawn a real stdio server and
    // open real SQLite files. Ephemeral ports and temp directories keep them
    // safe in parallel, but the timeouts have to allow a full
    // connect/sync/shutdown round trip — and a reconnect after a hub restart.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

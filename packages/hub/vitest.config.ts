import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Every suite binds real sockets and opens real SQLite files. They use
    // ephemeral ports and temp directories, so they are safe in parallel, but
    // the timeouts have to allow for a full connect/sync/shutdown round trip.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

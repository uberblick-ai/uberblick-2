import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Output shaped like ub-agents' CI: one dot per test under CI, and a
    // test's console output only when it fails. Node 25+ enables Web Storage by
    // default and warns once per worker that no `--localstorage-file` was given;
    // no suite uses Node's localStorage, so the workers run without it.
    reporters: process.env.CI ? ["dot"] : ["default"],
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
  },
});

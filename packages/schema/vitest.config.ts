import { defineConfig } from "vitest/config";
import { vitestBudgets } from "../../scripts/vitest-budget-config.mjs";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // A test's console output is shown only when it fails. Node 25+ enables Web Storage by
    // default and warns once per worker that no `--localstorage-file` was given;
    // no suite uses Node's localStorage, so the workers run without it.
    ...vitestBudgets("schema"),
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
  },
});

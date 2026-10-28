import { fileURLToPath } from "node:url";

export function vitestBudgets(name) {
  return {
    runner: fileURLToPath(new URL(`../packages/${name}/test/budget-runner.ts`, import.meta.url)),
    reporters: [
      process.env.CI ? "dot" : "default",
      [fileURLToPath(new URL("./vitest-budget-reporter.mjs", import.meta.url)), { name }],
    ],
  };
}

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DEFAULT_TEST_BUDGET_MS, testBudget } from "./test-duration-budget.mjs";

const requireVitest = createRequire(new URL("../packages/schema/package.json", import.meta.url));
const { JUnitReporter, experimental_getRunnerTask } = await import(pathToFileURL(requireVitest.resolve("vitest/node")).href);

function budgetDetails(test) {
  const exception = test.meta().testBudget;
  try { return { budgetMs: testBudget(exception), exception }; }
  catch (error) { return { budgetMs: DEFAULT_TEST_BUDGET_MS, exception, budgetDeclarationError: error.message }; }
}

export default class BudgetReporter {
  constructor({ name }) { this.name = name; }

  async onInit(ctx) {
    if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) return;
    this.directory = join(process.env.RUNNER_TEMP, "vitest-results");
    try {
      this.junit = new JUnitReporter({
        outputFile: join(this.directory, `${this.name}.xml`),
        includeConsoleOutput: false,
        classnameTemplate: "",
      });
      await this.junit.onInit(ctx);
    } catch (error) {
      this.junit = undefined;
      console.warn(`Could not initialize ${this.name} JUnit report: ${error.message}`);
    }
  }

  onTestRunStart() { this.started = performance.now(); }

  async onTestRunEnd(modules, errors, reason) {
    if (!this.directory) return;
    try {
      for (const file of modules) for (const test of file.children.allTests()) {
        // Vitest retains mode=skip after a dynamic skip has been corrected to a
        // failed complete attempt. JUnit needs the final status, not that flag.
        if (test.result().state === "failed" && test.meta().completeAttemptBudgetMs !== undefined) {
          const task = experimental_getRunnerTask(test);
          if (task.mode === "skip") task.mode = "run";
        }
      }
      const files = modules.map((file) => ({
        file: file.relativeModuleId,
        project: file.project.name,
        ...file.diagnostic(),
        sharedHooks: [file, ...file.children.allSuites()].flatMap((suite) =>
          (suite.meta().sharedHookDurations ?? []).map((hook) => ({ suite: suite.fullName ?? file.relativeModuleId, ...hook }))),
        tests: [...file.children.allTests()].map((test) => ({
          name: test.fullName,
          durationMs: test.diagnostic()?.duration ?? 0,
          ...budgetDetails(test),
          state: test.result().state,
        })),
      }));
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(join(this.directory, `${this.name}-durations.json`), `${JSON.stringify({
        normalBudgetMs: DEFAULT_TEST_BUDGET_MS,
        suiteWallMs: performance.now() - this.started,
        files,
      }, null, 2)}\n`);
    } catch (error) {
      console.warn(`Could not collect ${this.name} duration report: ${error.message}`);
    }
    try { await this.junit?.onTestRunEnd(modules, errors, reason); }
    catch (error) { console.warn(`Could not collect ${this.name} JUnit report: ${error.message}`); }
  }
}

import { performance } from "node:perf_hooks";
import { budgetFailure, testBudget } from "./test-duration-budget.mjs";

function fail(test, error) {
  test.result ??= {};
  test.result.state = "fail";
  test.result.errors ??= [];
  test.result.errors.push({ name: error.name, message: error.message, stack: error.stack });
}

function testName(test) {
  const names = [test.name];
  let suite = test.suite;
  while (suite && suite !== test.file) {
    names.unshift(suite.name);
    suite = suite.suite;
  }
  return `${test.file.name} > ${names.join(" > ")}`;
}

function declaredBudget(test, config) {
  const budget = testBudget(test.meta.testBudget);
  const timeout = test.timeout ?? config.testTimeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > budget) {
    throw new Error(`${testName(test)} declares timeout ${timeout} ms outside its complete-attempt budget ${budget} ms. Keep a positive phase timeout within the budget or declare a test-budget exception with purpose, allowanceMs and maintainer approval or open decision.`);
  }
  return budget;
}

export const withTestBudgets = (TestRunner) => class BudgetRunner extends TestRunner {
  onCollected(files) {
    const validate = (task) => {
      if (task.type === "test") declaredBudget(task, this.config);
      else task.tasks.forEach(validate);
    };
    files.forEach(validate);
  }

  async onBeforeRunTask(test) {
    await super.onBeforeRunTask(test);
    test.meta.attemptStartedAt = Date.now();
    try {
      declaredBudget(test, this.config);
    } catch (error) {
      test.mode = "run";
      fail(test, error);
    }
  }

  onAfterRunTask(test) {
    super.onAfterRunTask(test);
    this.enforceBudget(test);
  }

  enforceBudget(test) {
    try {
      const budget = testBudget(test.meta.testBudget);
      if (test.result.duration > budget) {
        test.mode = "run";
        fail(test, budgetFailure(testName(test), test.result.duration, budget));
      }
      test.meta.completeAttemptBudgetMs = budget;
    } catch (error) { fail(test, error); }
  }

  async onAfterRunSuite(suite) {
    // Dynamic skips finish their cleanup and record duration, then return
    // before onAfterRunTask. Finalize those attempts before the suite update.
    for (const test of suite.tasks) {
      if (test.type !== "test" || test.meta.completeAttemptBudgetMs !== undefined
        || test.result?.duration === undefined) continue;
      test.result.startTime ??= test.meta.attemptStartedAt;
      this.enforceBudget(test);
      await this.onTaskUpdate([[test.id, test.result, test.meta]], []);
      if (test.result.state === "fail") suite.result.state = "fail";
    }
    await super.onAfterRunSuite(suite);
  }

  async onBeforeRunSuite(suite) {
    await super.onBeforeRunSuite(suite);
    const hooks = TestRunner.getSuiteHooks(suite);
    suite.meta.sharedHookDurations = [];
    for (const name of ["beforeAll", "afterAll"]) {
      hooks[name] = hooks[name].map((hook) => {
        const measured = async (...args) => {
          const started = performance.now();
          try {
            const cleanup = await hook(...args);
            if (typeof cleanup !== "function") return cleanup;
            return async () => {
              const cleanupStarted = performance.now();
              try { return await cleanup(); }
              finally { suite.meta.sharedHookDurations.push({ name: `${name} cleanup`, durationMs: performance.now() - cleanupStarted }); }
            };
          } finally {
            suite.meta.sharedHookDurations.push({ name, durationMs: performance.now() - started });
          }
        };
        return Object.assign(measured, hook);
      });
    }
  }
};

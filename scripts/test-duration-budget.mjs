export const DEFAULT_TEST_BUDGET_MS = 60_000;

export function testBudget(exception) {
  if (exception === undefined) return DEFAULT_TEST_BUDGET_MS;
  if (!exception || typeof exception !== "object"
    || !Number.isFinite(exception.allowanceMs) || exception.allowanceMs <= DEFAULT_TEST_BUDGET_MS
    || typeof exception.purpose !== "string" || !exception.purpose.trim()
    || typeof exception.decision !== "string" || !exception.decision.trim()) {
    throw new Error("A test-budget exception must declare its purpose, allowanceMs above 60000, and maintainer approval or open decision in decision.");
  }
  return exception.allowanceMs;
}

export function budgetFailure(name, durationMs, budgetMs) {
  return new Error(`Test duration budget exceeded: ${name} took ${durationMs.toFixed(1)} ms; budget ${budgetMs} ms including its own setup, execution and cleanup. Declare a test-budget exception with its purpose, allowanceMs, and maintainer approval or open decision; see .agents/development.md#bound-duration-and-verify-the-improvement.`);
}

export function vitestBudgetException(exception) {
  return { timeout: testBudget(exception), meta: { testBudget: exception } };
}

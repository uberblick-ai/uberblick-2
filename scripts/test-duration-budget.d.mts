export const DEFAULT_TEST_BUDGET_MS: number;
export interface TestBudgetException {
  purpose: string;
  allowanceMs: number;
  decision: string;
}
export function testBudget(exception?: unknown): number;
export function budgetFailure(name: string, durationMs: number, budgetMs: number): Error;
export function vitestBudgetException(exception: TestBudgetException): {
  timeout: number;
  meta: { testBudget: TestBudgetException; __vitest_label__?: string };
};

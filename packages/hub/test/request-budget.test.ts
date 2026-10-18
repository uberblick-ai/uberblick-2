import { describe, expect, it } from "vitest";
import { RequestBudget } from "../src/request-budget.js";

describe("request budget", () => {
  it("retains each accepted request until its own window boundary", () => {
    let now = 0;
    const budget = new RequestBudget(2, 100, 100, () => now);
    expect(budget.take("client")).toBe(true);
    now = 99;
    expect(budget.take("client")).toBe(true);
    expect(budget.take("client")).toBe(false);
    now = 100;
    expect(budget.take("client")).toBe(true);
    now = 198;
    expect(budget.take("client")).toBe(false);
    now = 199;
    expect(budget.take("client")).toBe(true);
  });

  it("shares account and workspace allowances without spending either on a refusal", () => {
    const budget = new RequestBudget(1, 100, 100, () => 0);
    expect(budget.take("account-a", "workspace-a")).toBe(true);
    expect(budget.take("account-a", "workspace-b")).toBe(false);
    expect(budget.take("account-b", "workspace-b")).toBe(true);
    expect(budget.take("account-c", "workspace-b")).toBe(false);
    expect(budget.take("account-c", "workspace-c")).toBe(true);
    // Identical values in different dimensions refer to separate principals.
    expect(budget.take("workspace-a", "account-a")).toBe(true);
  });

  it("bounds retained requests without letting address churn erase live debt", () => {
    let now = 0;
    const budget = new RequestBudget(2, 100, 3, () => now);
    expect(budget.take("client-a")).toBe(true);
    expect(budget.take("client-a")).toBe(true);
    now = 50;
    expect(budget.take("client-b")).toBe(true);
    for (let index = 0; index < 1000; index++) {
      expect(budget.take(`new-client-${index}`)).toBe(false);
    }
    expect(budget.take("client-a")).toBe(false);
    now = 100;
    expect(budget.take("client-a")).toBe(true);
    expect(budget.take("client-c")).toBe(true);
    expect(budget.take("client-d")).toBe(false);
  });

  it("reserves allowances before admitted callers begin asynchronous work", async () => {
    const budget = new RequestBudget(3, 100, 100, () => 0);
    const admitted = await Promise.all(Array.from({ length: 100 }, async () => {
      const accepted = budget.take("client");
      await Promise.resolve();
      return accepted;
    }));
    expect(admitted.filter(Boolean)).toHaveLength(3);
  });
});

import { expect, it } from "vitest";

it("proves that a failed package and its aggregate recover on the next attempt", () => {
  expect(process.env.GITHUB_RUN_ATTEMPT).not.toBe("1");
});

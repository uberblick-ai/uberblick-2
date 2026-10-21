// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertNoViolations } from "../e2e/accessibility-assertions.js";
import type {
  AccessibilityExclusion,
  AxeViolation,
} from "../e2e/accessibility-assertions.js";

function violation(id: string, ...targets: AxeViolation["nodes"][number]["target"][]): AxeViolation {
  return {
    id,
    description: "A scanned control violates its accessibility rule",
    help: "Controls must meet this rule",
    helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
    impact: "serious",
    tags: ["wcag2a"],
    nodes: targets.map((target) => ({
      target,
      html: "<button></button>",
      any: [],
      all: [],
      none: [],
      failureSummary: "Fix the scanned control",
    })),
  };
}

const exclusion: AccessibilityExclusion = {
  rule: "target-size",
  target: ["#tracked-control"],
  issue: "https://github.com/uberblick-ai/uberblick-2/issues/1216",
};

describe("accessibility exclusions", () => {
  it("fails on a seeded violation and identifies its rule and element", () => {
    const unnamed = violation("button-name", ["#seeded-unnamed-button"]);
    expect(() => assertNoViolations([unnamed], [exclusion])).toThrow(
      /button-name:[\s\S]*#seeded-unnamed-button[\s\S]*Fix the scanned control/,
    );
  });

});

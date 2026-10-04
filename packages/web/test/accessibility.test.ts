import { describe, expect, it } from "vitest";
import {
  assertNoViolations,
  unexpectedViolations,
} from "../e2e/accessibility-assertions.js";
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
  it("excludes only the named rule on the exact target", () => {
    const targetSize = violation("target-size", ["#tracked-control"], ["#new-control"]);
    const unnamed = violation("button-name", ["#tracked-control"]);
    const results = unexpectedViolations([targetSize, unnamed], [exclusion]);

    expect(results).toEqual([
      { ...targetSize, nodes: [targetSize.nodes[1]] },
      unnamed,
    ]);
    // Filtering must not destroy the original scan evidence.
    expect(targetSize.nodes).toHaveLength(2);
    expect(() => assertNoViolations([targetSize, unnamed], [exclusion])).toThrow(/button-name/);
  });

  it("matches the complete target path, including frame and shadow selectors", () => {
    const tracked = violation("target-size", ["#frame", ["#shadow-host", "#tracked-control"]]);
    const nestedExclusion: AccessibilityExclusion = {
      ...exclusion,
      target: ["#frame", ["#shadow-host", "#tracked-control"]],
    };
    expect(unexpectedViolations([tracked], [nestedExclusion])).toEqual([]);
    expect(unexpectedViolations([tracked], [exclusion])).toEqual([tracked]);
    expect(unexpectedViolations([tracked], [{ ...nestedExclusion, target: ["#frame"] }])).toEqual([tracked]);
  });

  it("fails on a seeded violation and identifies its rule and element", () => {
    const unnamed = violation("button-name", ["#seeded-unnamed-button"]);
    expect(() => assertNoViolations([unnamed], [exclusion])).toThrow(
      /button-name:[\s\S]*#seeded-unnamed-button[\s\S]*Fix the scanned control/,
    );
  });

  it("accepts a clean scan or one containing only the tracked violation", () => {
    expect(() => assertNoViolations([])).not.toThrow();
    expect(() => assertNoViolations([
      violation("target-size", ["#tracked-control"]),
    ], [exclusion])).not.toThrow();
  });
});

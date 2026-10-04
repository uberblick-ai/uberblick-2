import type AxeBuilder from "@axe-core/playwright";

/** Axe's WCAG 2.0, 2.1 and 2.2 level A/AA rule groups. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/** The linked issue must be open when the exclusion is adopted. */
export interface AccessibilityExclusion {
  rule: string;
  target: AxeViolation["nodes"][number]["target"];
  issue: `https://github.com/uberblick-ai/uberblick-2/issues/${number}`;
}

/** Filter results, rather than disabling a rule or omitting an entire element. */
export function unexpectedViolations(
  violations: readonly AxeViolation[],
  exclusions: readonly AccessibilityExclusion[] = [],
): AxeViolation[] {
  return violations.flatMap((violation) => {
    const nodes = violation.nodes.filter((node) => !exclusions.some((exclusion) =>
      exclusion.rule === violation.id &&
      JSON.stringify(exclusion.target) === JSON.stringify(node.target),
    ));
    return nodes.length === 0 ? [] : [{ ...violation, nodes }];
  });
}

export function assertNoViolations(
  violations: readonly AxeViolation[],
  exclusions: readonly AccessibilityExclusion[] = [],
): void {
  const unexpected = unexpectedViolations(violations, exclusions);
  if (unexpected.length === 0) return;
  const details = unexpected.map((violation) => [
    `${violation.id}: ${violation.help} (${violation.helpUrl})`,
    ...violation.nodes.map((node) =>
      `  ${JSON.stringify(node.target)}\n  ${node.failureSummary ?? node.html}`,
    ),
  ].join("\n")).join("\n\n");
  throw new Error(`Accessibility violations:\n${details}`);
}

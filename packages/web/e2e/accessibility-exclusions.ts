import type { Page } from "@playwright/test";
import type { AccessibilityExclusion, AxeViolation } from "./accessibility-assertions.js";

// Match a single rule and exact axe target. Never omit an element from the scan
// or disable a rule: other rules on this element and siblings must still fail.
const exclusions: readonly AccessibilityExclusion[] = [
  { rule: "aria-hidden-focus", target: ["#root"], issue: "https://github.com/uberblick-ai/uberblick-2/issues/1236" },
  { rule: "target-size", target: [".ub-peer-more"], issue: "https://github.com/uberblick-ai/uberblick-2/issues/1223" },
  { rule: "target-size", target: [".ub-comment"], issue: "https://github.com/uberblick-ai/uberblick-2/issues/1239" },
];

const elementExclusions = [
  { rule: "scrollable-region-focusable", selector: '[data-slot="caret-menu-content"] [role="listbox"][aria-label="Block types"]', issue: "https://github.com/uberblick-ai/uberblick-2/issues/1237" },
  { rule: "target-size", selector: '.ub-peers > .ub-peer-control[data-peer-id]:nth-child(2)', issue: "https://github.com/uberblick-ai/uberblick-2/issues/1223" },
  { rule: "target-size", selector: '.ub-peers > .ub-peer-control[data-peer-id]:nth-child(3)', issue: "https://github.com/uberblick-ai/uberblick-2/issues/1223" },
] as const;

/** Resolve unstable axe selectors (React ids or utility classes) to one element.
 * A selector must identify exactly one node; a sibling is never excluded.
 * Frame/shadow targets are not resolved by this page-only mapping.
 */
export async function scanExclusions(page: Page, violations: readonly AxeViolation[]): Promise<AccessibilityExclusion[]> {
  const resolved: AccessibilityExclusion[] = [...exclusions];
  for (const exclusion of elementExclusions) {
    for (const violation of violations.filter((rule) => rule.id === exclusion.rule)) {
      for (const node of violation.nodes) {
        const [target] = node.target;
        if (node.target.length !== 1 || typeof target !== "string") continue;
        const matches = await page.evaluate(({ selector, target }) => {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 1) throw new Error(`Accessibility exclusion is ambiguous: ${selector}`);
          const targets = document.querySelectorAll(target);
          return elements.length === 1 && targets.length === 1 && elements[0] === targets[0];
        }, { selector: exclusion.selector, target });
        if (matches) resolved.push({ rule: exclusion.rule, target: node.target, issue: exclusion.issue });
      }
    }
  }
  return resolved;
}

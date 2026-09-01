/**
 * #628's throwaway prototype: the only thing that notices when the human half
 * of a behavior and the machine half stop pointing at each other.
 *
 * A scenario in `e2e/scenarios/` names a spec file and a test title; the test
 * carries the scenario id as a Playwright annotation. Neither end knows about
 * the other at runtime, so on its own the link is *silent* — rename the test
 * and the suite still passes, rename the scenario and the evidence is still
 * filed. This test is what turns either break into a failure, and it runs in
 * `mise run test`, where a rename is made.
 *
 * It reads source text, which is the cheapest thing that works and the most
 * obvious thing to break: it recognises a literal title and a literal
 * annotation, so a title built from a variable, or a scenario named through a
 * constant, would read as a broken link. That fragility is a finding of the
 * spike, not an oversight — see the PR paper on #628.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioDir = resolve(webRoot, "e2e/scenarios");
const e2eDir = resolve(webRoot, "e2e");

/** `Scenario:` and `Test:` are the whole format; everything else is prose for a person. */
function readScenario(file: string): { id: string; spec: string; title: string } {
  const text = readFileSync(resolve(scenarioDir, file), "utf8");
  const id = /^Scenario: (.+)$/m.exec(text)?.[1]?.trim();
  const target = /^Test: (.+)$/m.exec(text)?.[1]?.trim();
  if (id === undefined || target === undefined) {
    throw new Error(`${file} needs both a "Scenario:" and a "Test:" line`);
  }
  const divider = target.indexOf("›");
  if (divider === -1) throw new Error(`${file}'s "Test:" line needs "<spec> › <title>"`);
  return { id, spec: target.slice(0, divider).trim(), title: target.slice(divider + 1).trim() };
}

/**
 * Every scenario annotation in the e2e suite, with the test it is attached to:
 * the nearest `test(` above it, and the title that opens that call.
 */
function annotatedTests(): { spec: string; title: string; id: string }[] {
  const found: { spec: string; title: string; id: string }[] = [];
  const annotation = /type:\s*"scenario",\s*description:\s*"([^"]+)"/g;
  for (const name of readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts"))) {
    const text = readFileSync(resolve(e2eDir, name), "utf8");
    for (const match of text.matchAll(annotation)) {
      const id = match[1];
      const declaration = text.lastIndexOf("test(", match.index);
      const title = /^test\(\s*"([^"]+)"/.exec(text.slice(declaration))?.[1];
      if (id === undefined || title === undefined) {
        throw new Error(`a scenario annotation in ${name} is not on a test with a literal title`);
      }
      found.push({ spec: `e2e/${name}`, title, id });
    }
  }
  return found;
}

describe("scenario ↔ test links", () => {
  const scenarios = readdirSync(scenarioDir)
    .filter((f) => f.endsWith(".md"))
    .map(readScenario);

  it("has at least one scenario to check", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("resolves every scenario to a test that exists and names it back", () => {
    for (const scenario of scenarios) {
      const spec = resolve(webRoot, scenario.spec);
      expect(existsSync(spec), `${scenario.id} names a spec that does not exist`).toBe(true);
      const match = annotatedTests().find(
        (t) => t.spec === scenario.spec && t.title === scenario.title,
      );
      expect(match, `${scenario.id} names no annotated test in ${scenario.spec}`).toBeDefined();
      expect(match?.id).toBe(scenario.id);
    }
  });

  it("resolves every annotated test to a scenario file that names it back", () => {
    for (const test of annotatedTests()) {
      const file = resolve(scenarioDir, `${test.id}.md`);
      expect(existsSync(file), `${test.title} annotates an unknown scenario`).toBe(true);
      const scenario = readScenario(`${test.id}.md`);
      expect(scenario.spec).toBe(test.spec);
      expect(scenario.title).toBe(test.title);
    }
  });
});

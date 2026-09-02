/**
 * The executable link between a repository scenario and the Playwright test
 * that defends it (#668).
 *
 * A scenario in `e2e/scenarios/` names a registered test as
 * `e2e/<spec> › <test's own title>`. The test names the scenario with a
 * Playwright `scenario` annotation. Playwright's JSON list is the authority for
 * the machine half: this catches commented-out tests and accepts titles built
 * from variables or constants without trying to parse TypeScript source.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = resolve(webRoot, "e2e");
const scenarioDir = resolve(e2eDir, "scenarios");

interface Scenario {
  id: string;
  spec: string;
  title: string;
}

interface RegisteredTest {
  spec: string;
  title: string;
  scenarioIds: string[];
}

/** `Scenario:` and `Test:` are the whole format; everything else is prose. */
function readScenario(file: string): Scenario {
  const text = readFileSync(resolve(scenarioDir, file), "utf8");
  const idLines = text.match(/^Scenario: (.+)$/gm) ?? [];
  const testLines = text.match(/^Test: (.+)$/gm) ?? [];
  if (idLines.length !== 1 || testLines.length !== 1) {
    throw new Error(`${file} needs exactly one "Scenario:" and one "Test:" line`);
  }

  const id = idLines[0]?.slice("Scenario: ".length).trim() ?? "";
  if (`${id}.md` !== file) {
    throw new Error(`${file}'s scenario id must match its filename`);
  }

  const target = testLines[0]?.slice("Test: ".length).trim() ?? "";
  const parts = target.split(" › ");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`${file}'s "Test:" line needs "e2e/<spec> › <title>"`);
  }
  return { id, spec: parts[0] ?? "", title: parts[1] ?? "" };
}

function diagnostic(error: JSONReport["errors"][number]): string {
  return (
    error.message?.trim() ||
    error.stack?.trim() ||
    JSON.stringify(error) ||
    "unknown Playwright error"
  );
}

/** Ask Playwright which tests it actually registered, without launching a browser. */
function registeredTests(): RegisteredTest[] {
  const packageFile = require.resolve("@playwright/test/package.json");
  const cli = resolve(dirname(packageFile), "cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, "test", "--list", "--reporter=json"],
    { cwd: webRoot, encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw new Error(`Playwright test enumeration failed: ${result.error.message}`);
  }

  let report: JSONReport;
  try {
    report = JSON.parse(result.stdout) as JSONReport;
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim() || "no JSON output";
    throw new Error(`Playwright test enumeration failed: ${detail}`);
  }

  const diagnostics = report.errors.map(diagnostic).filter(Boolean);
  if (result.status !== 0 || diagnostics.length > 0) {
    const detail = diagnostics.join("\n") || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`Playwright test enumeration failed:\n${detail}`);
  }

  const found: RegisteredTest[] = [];
  const visit = (suite: JSONReportSuite): void => {
    for (const spec of suite.specs) {
      const file = relative(e2eDir, resolve(e2eDir, spec.file)).split(sep).join("/");
      const scenarioIds = [
        ...new Set(
          spec.tests
            .flatMap((test) => test.annotations)
            .filter((annotation) => annotation.type === "scenario")
            .map((annotation) => annotation.description?.trim() ?? ""),
        ),
      ];
      found.push({ spec: `e2e/${file}`, title: spec.title, scenarioIds });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);

  if (found.length === 0) {
    throw new Error("Playwright test enumeration listed no tests");
  }
  return found;
}

describe("scenario ↔ test links", () => {
  const scenarios = readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".md"))
    .map(readScenario);
  const registered = registeredTests();
  const annotated = registered.filter((test) => test.scenarioIds.length > 0);

  it("has at least one link to check", () => {
    expect(scenarios.length).toBeGreaterThan(0);
    expect(annotated.length).toBeGreaterThan(0);
  });

  it("resolves every scenario to exactly one registered test that names it back", () => {
    for (const scenario of scenarios) {
      const matches = registered.filter(
        (test) => test.spec === scenario.spec && test.title === scenario.title,
      );
      expect(matches, `${scenario.id} must name exactly one registered test`).toHaveLength(1);
      expect(matches[0]?.scenarioIds).toEqual([scenario.id]);
    }
  });

  it("resolves every annotated test to exactly one scenario file that names it back", () => {
    for (const test of annotated) {
      expect(test.scenarioIds, `${test.spec} › ${test.title}`).toHaveLength(1);
      const matches = scenarios.filter((scenario) => scenario.id === test.scenarioIds[0]);
      expect(matches, `${test.spec} › ${test.title} must name one scenario`).toHaveLength(1);
      expect(matches[0]?.spec).toBe(test.spec);
      expect(matches[0]?.title).toBe(test.title);
    }
  });
});

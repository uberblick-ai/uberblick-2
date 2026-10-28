import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { budgetFailure, testBudget } from "./test-duration-budget.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "packages/schema/node_modules/vitest/vitest.mjs");
const api = join(root, "packages/schema/node_modules/vitest/dist/index.js");
const runner = join(root, "packages/schema/test/budget-runner.ts");
const reporter = join(root, "scripts/vitest-budget-reporter.mjs");

function fixture(source, check, { blockedReports = false, sharedSetup = false, environment = "node" } = {}) {
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
    `vitest-budgets-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  try {
    const clock = join(scratch, "clock.mjs");
    if (environment === "jsdom") writeFileSync(join(scratch, "budget-runner.mjs"), `
import { TestRunner } from ${JSON.stringify(api)};
import { withTestBudgets } from ${JSON.stringify(join(root, "scripts/vitest-budget-runner.mjs"))};
export default withTestBudgets(TestRunner);
`);
    // Advance the worker's monotonic clock without sleeping for a minute.
    // Vitest captures this clock before importing tests and measures the whole
    // lifecycle with it, including the cleanup after onTestFinished.
    writeFileSync(clock, `
const nativeNow = performance.now.bind(performance);
let offset = 0;
globalThis.advanceBudgetClock = (ms) => { offset += ms; };
Object.defineProperty(globalThis, "performance", { value: {
  now: () => nativeNow() + offset,
  mark: performance.mark.bind(performance),
  measure: performance.measure.bind(performance),
}, configurable: true });
`);
    writeFileSync(join(scratch, "vitest.config.mjs"), `
export default { test: {
  runner: ${JSON.stringify(environment === "jsdom" ? join(scratch, "budget-runner.mjs") : runner)},
  reporters: ["dot", [${JSON.stringify(reporter)}, {name:"fixture"}]],
  include:["fixture.test.mjs"],
  environment:${JSON.stringify(environment)},
  maxWorkers:1,
  testTimeout:60000,
  hookTimeout:60000,
  globalSetup: ${sharedSetup ? JSON.stringify(join(scratch, "setup.mjs")) : "[]"},
  execArgv:["--import", ${JSON.stringify(clock)}],
} };
`);
    if (sharedSetup) writeFileSync(join(scratch, "setup.mjs"), `
import { measureSharedSetup } from ${JSON.stringify(join(root, "scripts/report-shared-setup.mjs"))};
export default async function setup() {
  await measureSharedSetup("fixture shared startup", "setup", () => new Promise((resolve) => setTimeout(resolve, 10)));
  return () => measureSharedSetup("fixture shared startup", "cleanup", () => new Promise((resolve) => setTimeout(resolve, 10)));
}
`);
    writeFileSync(join(scratch, "fixture.test.mjs"), `
import { afterEach, aroundEach, beforeAll, beforeEach, describe, onTestFinished, test } from ${JSON.stringify(api)};
const advance = (ms) => globalThis.advanceBudgetClock(ms);
${source}
`);
    if (blockedReports) writeFileSync(join(scratch, "blocked"), "report output is a file");
    const result = spawnSync(process.execPath, [vitest, "run", "--config", join(scratch, "vitest.config.mjs")], {
      cwd: scratch,
      env: { ...process.env, CI: "true", GITHUB_ACTIONS: "true", RUNNER_TEMP: blockedReports ? join(scratch, "blocked") : scratch },
      encoding: "utf8", timeout: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, output);
    check(result, output, scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("Vitest rejects complete costs split between body, hooks, fixtures and cleanup", () => {
  fixture(`
describe("own hooks", () => {
  beforeEach(() => advance(25000));
  afterEach(() => advance(25000));
  test("body and hooks", () => advance(25000));
});
describe("returned cleanup", () => {
  beforeEach(() => { advance(25000); return () => advance(25000); });
  test("body and returned cleanup", () => advance(25000));
});
describe("finished cleanup", () => {
  test("body and onTestFinished", () => {
    advance(35000);
    onTestFinished(() => advance(35000));
  });
});
describe("around fixture", () => {
  aroundEach(async (run) => { advance(25000); await run(); advance(25000); });
  test("body and aroundEach", () => advance(25000));
});
const withFixture = test.extend({ resource: async ({}, use) => {
  advance(25000); await use(1); advance(25000);
} });
withFixture("body and test fixture", ({ resource }) => { if (resource) advance(25000); });
`, (result, output, scratch) => {
    assert.equal(result.status, 1, output);
    const report = JSON.parse(readFileSync(join(scratch, "vitest-results/fixture-durations.json"), "utf8"));
    assert.equal(report.files[0].tests.length, 5, "nested tests are retained");
    for (const entry of report.files[0].tests) {
      assert.equal(entry.state, "failed");
      assert.ok(entry.durationMs >= 70_000, entry.name);
      assert.equal(entry.budgetMs, 60_000);
      assert.match(output, new RegExp(entry.name.split(" > ").at(-1)));
    }
    assert.match(output, /budget 60000 ms including its own setup, execution and cleanup/);
    assert.match(output, /maintainer approval or open decision/);
    const junit = readFileSync(join(scratch, "vitest-results/fixture.xml"), "utf8");
    assert.equal((junit.match(/<failure /g) ?? []).length, 5);
  });
});

test("Vitest reports shared file hooks separately and accepts a declared longer test", () => {
  fixture(`
beforeAll(() => {});
describe("nested", () => {
  beforeAll(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); advance(90000); }, 120000);
  test("normal test excludes shared setup", () => {});
  test("declared exception", {timeout:120000, meta:{testBudget:{
    purpose:"Controlled complete-lifecycle verification", allowanceMs:120000,
    decision:"https://github.com/uberblick-ai/uberblick-2/issues/2427",
  }}}, () => advance(90000));
});
`, (result, output, scratch) => {
    assert.equal(result.status, 0, output);
    const report = JSON.parse(readFileSync(join(scratch, "vitest-results/fixture-durations.json"), "utf8"));
    const file = report.files[0];
    assert.equal(file.tests.length, 2);
    assert.ok(file.tests[0].durationMs < 60_000);
    assert.ok(file.tests[1].durationMs >= 90_000);
    assert.equal(file.tests[1].budgetMs, 120_000);
    assert.equal(file.sharedHooks.length, 2);
    assert.equal(file.sharedHooks[1].name, "beforeAll");
    assert.ok(file.sharedHooks[1].durationMs >= 9);
    assert.ok(file.duration >= 180_000);
    const shared = readFileSync(join(scratch, "vitest-results/shared-setup.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(shared.map((entry) => entry.phase), ["setup", "cleanup"]);
    assert.ok(shared.every((entry) => entry.durationMs >= 9));
  }, { sharedSetup: true });
});

test("Vitest refuses undeclared allowances even on skipped opt-in tests", () => {
  fixture(`test.skip("undeclared opt-in", {timeout:120000}, () => {});`, (result, output) => {
    assert.equal(result.status, 1, output);
    assert.match(output, /undeclared opt-in declares timeout 120000 ms outside its complete-attempt budget 60000 ms/);
  });
});

test("Vitest budget runners load in jsdom as well as Node", () => {
  fixture(`test("jsdom runner", () => {});`, (result, output) => {
    assert.equal(result.status, 0, output);
  }, { environment: "jsdom" });
});

test("Vitest enforces attempted dynamic skips and still retains malformed declarations", () => {
  fixture(`
describe("dynamic skips", () => {
  afterEach(() => advance(35000));
  test("skip after scenario work", (context) => { advance(35000); context.skip(); });
});
test("completed test retained", () => {});
test.skip("invalid declaration retained", {meta:{testBudget:{allowanceMs:120000}}}, () => {});
`, (result, output, scratch) => {
    assert.equal(result.status, 1, output);
    const report = JSON.parse(readFileSync(join(scratch, "vitest-results/fixture-durations.json"), "utf8"));
    assert.equal(report.files[0].tests.length, 3);
    assert.match(report.files[0].tests[2].budgetDeclarationError, /purpose, allowanceMs/);
  });
  fixture(`
describe("dynamic skips", () => {
  afterEach(() => advance(35000));
  test("skip after scenario work", (context) => { advance(35000); context.skip(); });
});
`, (result, output, scratch) => {
    assert.equal(result.status, 1, output);
    assert.match(output, /skip after scenario work took 700/);
    const report = JSON.parse(readFileSync(join(scratch, "vitest-results/fixture-durations.json"), "utf8"));
    assert.equal(report.files[0].tests[0].state, "failed");
    assert.ok(report.files[0].tests[0].durationMs >= 70000);
    const junit = readFileSync(join(scratch, "vitest-results/fixture.xml"), "utf8");
    assert.match(junit, /<failure /);
    assert.doesNotMatch(junit, /<skipped\/>/);
  });
});

test("Vitest report failures preserve passing and failing suite results", () => {
  for (const fail of [false, true]) {
    fixture(`test("result survives reporting", () => { ${fail ? 'throw new Error("intentional suite failure");' : ""} });`, (result, output) => {
      assert.equal(result.status, fail ? 1 : 0, output);
      assert.match(output, /Could not initialize fixture JUnit report/);
      assert.match(output, /Could not collect fixture duration report/);
    }, { blockedReports: true, sharedSetup: true });
  }
});

test("budget exceptions require purpose, allowance and a decision reference", () => {
  assert.equal(testBudget(), 60_000);
  for (const exception of [{}, { purpose: "probe", allowanceMs: 120_000 },
    { purpose: "", allowanceMs: 120_000, decision: "#2458" },
    { purpose: "probe", allowanceMs: 60_000, decision: "#2458" }]) {
    assert.throws(() => testBudget(exception), /purpose, allowanceMs/);
  }
  assert.match(budgetFailure("named test", 75_000, 60_000).message, /named test took 75000.0 ms; budget 60000 ms/);
});

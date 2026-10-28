import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runNodeTests } from "./run-node-tests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = pathToFileURL(join(root, "scripts/run-node-tests.mjs")).href;

function fixture(context, source, {
	budgetMs = 60_000, reportFails = false, additionalSource, relativeGlob = false,
} = {}) {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
		`node-test-budgets-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	context.after(() => rmSync(scratch, { recursive: true, force: true }));
	const clock = join(scratch, "clock.mjs");
	writeFileSync(clock, `const nativeNow = performance.now.bind(performance);
let offset = 0;
Object.defineProperty(performance, "now", { value: () => nativeNow() + offset });
export function advance(milliseconds) { offset += milliseconds; }
`);
	const file = join(scratch, "fixture.test.mjs");
	const files = [file];
	const reportPath = reportFails ? join(file, "report.json") : join(scratch, "report.json");
	writeFileSync(file, `import { before, after, beforeEach, afterEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { advance } from "./clock.mjs";
${source}`);
	if (additionalSource) {
		const additional = join(scratch, "additional.test.mjs");
		writeFileSync(additional, `import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
${additionalSource}`);
		files.push(additional);
	}
	const entry = join(scratch, "run.mjs");
	writeFileSync(entry, `import { runNodeTests } from ${JSON.stringify(runner)};
const result = await runNodeTests(${JSON.stringify(relativeGlob ? ["*.test.mjs"] : files)}, ${JSON.stringify({ budgetMs, reportPath })});
process.exitCode = result.success ? 0 : 1;
`);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	// run() supplies execArgv, so inherit the clock preloader through NODE_OPTIONS.
	env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(clock).href}`;
	const result = spawnSync(process.execPath, [entry], {
		cwd: relativeGlob ? scratch : root, env, encoding: "utf8", timeout: 15_000,
	});
	assert.equal(result.error, undefined, result.stderr);
	return { ...result, fixtureFile: file, output: `${result.stdout}\n${result.stderr}`,
		report: reportFails ? undefined : JSON.parse(readFileSync(reportPath, "utf8")) };
}

test("node:test budgets include each hook and context cleanup across complete attempts", (context) => {
	const result = fixture(context, `
beforeEach(async () => { await delay(0); advance(20_000); });
afterEach(async () => { await delay(0); advance(20_000); });
test("complete attempt", async (t) => {
  t.after(async () => { await delay(0); advance(20_000); });
  await delay(0);
  advance(20_000);
});
`);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /complete attempt.*[\d.]+\s*ms.*60000\s*ms/i);
	assert.match(result.output, /purpose|maintainer|exception/i);
	const [attempt] = result.report.tests;
	assert.ok(attempt.durationMs >= 80_000, JSON.stringify(attempt));
	assert.equal(attempt.budgetMs, 60_000);
	assert.equal(attempt.status, "failed");
});

test("node:test reports shared hooks once per file with a relative glob from another cwd", (context) => {
	const result = fixture(context, `
before(() => { advance(100_000); });
after(() => { advance(100_000); });
test("small root test", () => { advance(10_000); });
describe("nested", () => {
  before(() => { advance(100_000); });
  after(() => { advance(100_000); });
  test("small test", (t, done) => {
    t.after((t, done) => { advance(5_000); setImmediate(done); });
    advance(5_000);
    setImmediate(done);
  });
});
`, { relativeGlob: true });
	assert.equal(result.status, 0, result.output);
	assert.deepEqual(result.report.tests.map((attempt) => attempt.name), ["small root test", "nested > small test"]);
	for (const attempt of result.report.tests) {
		assert.ok(attempt.durationMs >= 10_000, JSON.stringify(attempt));
		assert.ok(attempt.durationMs < 60_000, JSON.stringify(attempt));
	}
	assert.equal(result.report.files.length, 1, JSON.stringify(result.report.files));
	const [file] = result.report.files;
	assert.equal(file.file, result.fixtureFile);
	assert.ok(file.totalMs > 0, JSON.stringify(file));
	assert.ok(file.sharedSetupMs >= 100_000 && file.sharedSetupMs < 160_000, JSON.stringify(file));
	assert.ok(file.sharedCleanupMs >= 200_000 && file.sharedCleanupMs < 260_000, JSON.stringify(file));
	assert.ok(file.sharedBetweenAttemptsMs >= 100_000, JSON.stringify(file));
	assert.ok(file.processSetupCleanupMs >= 0);
	assert.ok(result.report.wallTimeMs >= file.totalMs);
	assert.ok(result.report.sharedRun.setupMs >= 0);
	assert.ok(result.report.sharedRun.cleanupMs >= 0);
	assert.ok(result.report.sharedRun.betweenFilesMs >= 0);
});

test("node:test retains failed attempts including a failing beforeEach and afterEach cleanup", (context) => {
	const result = fixture(context, `
before(() => { advance(100_000); });
beforeEach(() => { advance(15_000); throw new Error("setup failed"); });
afterEach(() => { advance(15_000); });
test("setup failure", () => {});
`);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /setup failed/);
	assert.equal(result.report.tests[0].status, "failed");
	assert.ok(result.report.tests[0].durationMs >= 30_000);
	assert.ok(result.report.tests[0].durationMs < 60_000, JSON.stringify(result.report.tests));
	assert.ok(result.report.files[0].sharedSetupMs >= 100_000);
});

test("node:test report writes are best effort for passing and failing suites", (context) => {
	for (const fails of [false, true]) {
		const result = fixture(context, `test("result is preserved", () => { ${fails ? 'throw new Error("fixture failure");' : ""} });`,
			{ reportFails: true });
		assert.equal(result.status, fails ? 1 : 0, result.output);
		assert.match(result.output, /Could not write node:test duration report/);
	}
});

test("node:test does not accept an undeclared budget above the normal allowance", async () => {
	await assert.rejects(runNodeTests([], { budgetMs: 60_001 }), /declared maintainer exception/);
	await assert.rejects(runNodeTests([], { budgetMs: Number.NaN }), /positive/);
});

test("malformed timing-like output cannot change a node:test suite's result", (context) => {
	const result = fixture(context, `
test("ordinary output", (t) => {
  console.log("\\u001euberblick:node-test-end not-json");
  console.log('\\u001euberblick:node-test-end null');
  console.log('\\u001euberblick:node-test-end {}');
  t.diagnostic("uberblick:node-test-start not-json");
  t.diagnostic("uberblick:node-test-start null");
  t.diagnostic("uberblick:node-test-start {}");
});
`);
	assert.equal(result.status, 0, result.output);
	assert.equal(result.report.tests.length, 1);
	assert.equal(result.report.tests[0].status, "passed");
	assert.equal(result.report.incomplete, false);
});

test("concurrent tests with identical names retain their own complete durations", (context) => {
	const result = fixture(context, `
test("parent", { concurrency: true }, async (t) => {
  let secondStarted;
  const bothStarted = new Promise((resolve) => { secondStarted = resolve; });
  const first = t.test("same name", async () => {
    await bothStarted;
    advance(10_000);
  });
  const second = t.test("same name", async () => {
    secondStarted();
    await first;
    advance(70_000);
  });
  await Promise.all([first, second]);
});
`);
	assert.equal(result.status, 1, result.output);
	const children = result.report.tests.filter((entry) => entry.name === "parent > same name")
		.sort((left, right) => left.durationMs - right.durationMs);
	assert.equal(children.length, 2);
	assert.equal(children[0].status, "passed");
	assert.equal(children[1].status, "failed");
	assert.ok(children[0].durationMs >= 10_000 && children[0].durationMs < 60_000);
	assert.ok(children[1].durationMs >= 80_000);
});

test("node:test retains the CLI's parallel file execution", {
	skip: availableParallelism() < 3 ? "The Node CLI uses one file worker on this host" : undefined,
}, (context) => {
	function barrier(own, other) {
		return `
import { existsSync, writeFileSync } from "node:fs";
test("both files start", async () => {
  writeFileSync(new URL(${JSON.stringify(own)}, import.meta.url), "ready");
  const deadline = performance.now() + 2000;
  while (!existsSync(new URL(${JSON.stringify(other)}, import.meta.url))) {
    if (performance.now() > deadline) throw new Error("Other file did not start in parallel");
    await delay(10);
  }
});
`;
	}
	const result = fixture(context, barrier("first.ready", "second.ready"), {
		additionalSource: barrier("second.ready", "first.ready"),
	});
	assert.equal(result.status, 0, result.output);
	assert.equal(result.report.tests.length, 2);
});

test("dynamic skips retain their complete-attempt budget while static skips do no work", (context) => {
	const result = fixture(context, `
beforeEach(() => { advance(35_000); });
test("dynamic skip", (t) => { advance(35_000); t.skip("runtime condition"); });
test.skip("static skip", () => { throw new Error("must not run"); });
`);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /dynamic skip.*budget 60000 ms/);
	const dynamic = result.report.tests.find((entry) => entry.name === "dynamic skip");
	const skipped = result.report.tests.find((entry) => entry.name === "static skip");
	assert.equal(dynamic.status, "failed");
	assert.ok(dynamic.durationMs >= 70_000);
	assert.equal(skipped.status, "skipped");
	assert.ok(skipped.durationMs < 35_000);
});

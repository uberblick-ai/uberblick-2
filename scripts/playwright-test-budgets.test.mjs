import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import TimingReporter from "../packages/web/e2e/timing-reporter.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/web/package.json"));
const reporterPath = join(root, "packages/web/e2e/timing-reporter.ts");

function scratch() {
	return mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `playwright-budgets-${process.env.UB_AGENTS_RUN ?? "local"}-`));
}

function run(source, setup = "") {
	const directory = scratch();
	try {
		writeFileSync(join(directory, "proof.spec.mjs"), `import playwright from ${JSON.stringify(require.resolve("@playwright/test"))};
const { test: base } = playwright;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
${source}\n`);
		writeFileSync(join(directory, "global-setup.mjs"), `import { recordRunTiming } from ${JSON.stringify(join(root, "packages/web/e2e/shared-timing.ts"))};
export default async function (config) { ${setup} }\n`);
		writeFileSync(join(directory, "playwright.config.mjs"), `export default {
testDir: ${JSON.stringify(directory)}, outputDir: ${JSON.stringify(join(directory, "results"))},
workers: 1, timeout: 60000, retries: 0, globalSetup: './global-setup.mjs',
reporter: [[${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(join(directory, "results/test-durations.json"))} }]],
};\n`);
		const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", join(directory, "playwright.config.mjs")], {
			cwd: root, encoding: "utf8", timeout: 20_000,
		});
		assert.equal(result.error, undefined, String(result.error));
		assert.ok(existsSync(join(directory, "results/test-durations.json")), result.stderr || result.stdout);
		const report = JSON.parse(readFileSync(join(directory, "results/test-durations.json"), "utf8"));
		return { ...result, report };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("Playwright reports hooks and independently timed fixtures as a complete attempt, with file and run setup separate", () => {
	const { status, report, stderr } = run(`
const test = base.extend({ ownFixture: [async ({}, use) => { await delay(30); await use('own'); await delay(30); }, { timeout: 1000 }] });
test.beforeAll(async () => { console.log('e2e timing: harness startup 120 ms'); await delay(120); });
test.afterAll(async () => { await delay(120); });
test.beforeEach(async () => { await delay(30); });
test.afterEach(async () => { await delay(30); });
test('complete attempt', async ({ ownFixture }) => { if (ownFixture !== 'own') throw new Error('fixture missing'); await delay(30); });`, `
recordRunTiming(config, 'bundle build', 17);
recordRunTiming(config, 'global setup', 20);
return async () => { recordRunTiming(config, 'global cleanup', 5); };`);
	assert.equal(status, 0, stderr);
	const [attempt] = report.tests;
	assert.ok(attempt.durationMs >= 140, JSON.stringify(attempt));
	assert.ok(attempt.durationMs - attempt.runnerDurationMs >= 40, "independent fixture timeout slots count");
	assert.ok(attempt.durationMs < 300, "shared hooks stay outside the test budget");
	assert.equal(report.shared.filter(value => value.scope === "file").length, 2);
	assert.ok(report.shared.filter(value => value.scope === "file").every(value => value.durationMs >= 110));
	assert.deepEqual(report.components.map(value => [value.scope, value.purpose]), [
		["file", "harness startup"], ["run", "bundle build"], ["run", "global setup"], ["run", "global cleanup"],
	]);
});

test("an undeclared enlarged Playwright timeout fails the actual suite", () => {
	const { status, stderr, report } = run(`base('undeclared', async () => { base.setTimeout(90000); });`);
	assert.equal(status, 1);
	assert.match(stderr, /undeclared.*runner timeout 90000 ms exceeds declared budget 60000 ms/);
	assert.equal(report.status, "failed");
});

test("a declared existing exception survives without granting its allowance to ordinary tests", () => {
	const { status, report, stderr } = run(`
base('allowed', { annotation: { type: 'test-budget', description: JSON.stringify({ purpose: 'Existing mixed workload', allowanceMs: 360000, decision: 'https://github.com/uberblick-ai/uberblick-2/issues/2440' }) } }, async () => { base.setTimeout(360000); });
base('ordinary', async () => {});`);
	assert.equal(status, 0, stderr);
	assert.deepEqual(report.tests.map(value => value.budgetMs), [360_000, 60_000]);
});

test("failed file setup and per-test teardown retain their own duration records", () => {
	const sharedFailure = run(`
base.beforeAll(async () => { await delay(15); throw new Error('file setup failed'); });
base('file setup failure', async () => {});`);
	assert.equal(sharedFailure.status, 1);
	assert.equal(sharedFailure.report.tests[0].status, "failed");
	assert.ok(sharedFailure.report.shared.some(value => value.purpose === "beforeAll hook" && value.durationMs >= 10));
	const ownFailure = run(`
const test = base.extend({ ownFixture: [async ({}, use) => { await use('own'); await delay(30); throw new Error('own cleanup failed'); }, { timeout: 1000 }] });
test('own cleanup failure', async ({ ownFixture }) => { if (ownFixture !== 'own') throw new Error('fixture missing'); });`);
	assert.equal(ownFailure.status, 1);
	assert.equal(ownFailure.report.tests[0].status, "failed");
	assert.ok(ownFailure.report.tests[0].durationMs >= 25);
});

test("failed global setup still retains its shared measurements and failed result", () => {
	const { status, report } = run(`base('never starts', async () => {});`, `recordRunTiming(config, 'global setup', 13); throw new Error('global setup failed');`);
	assert.equal(status, 1);
	assert.equal(report.status, "failed");
	assert.deepEqual(report.tests, []);
	assert.equal(report.components[0].purpose, "global setup");
});

test("a malformed exception declaration fails with its test and the exception route", () => {
	const { status, report, stderr } = run(`base('malformed exception', { annotation: { type: 'test-budget', description: 'not JSON' } }, async () => {});`);
	assert.equal(status, 1);
	assert.equal(report.status, "failed");
	assert.match(stderr, /malformed exception.*invalid duration allowance/);
	assert.match(stderr, /purpose, allowanceMs and maintainer approval or open decision/);
});

test("the complete Playwright attempt fails on accumulated setup, body and cleanup cost", async () => {
	const directory = scratch();
	try {
		const reporter = new TimingReporter();
		reporter.onBegin({ projects: [{ outputDir: directory }] });
		const testCase = {
			titlePath: () => ["project", "file", "split setup and cleanup"],
			location: { file: "proof.spec.ts", line: 1 }, timeout: 60_000,
			parent: { project: () => ({ name: "proof" }) },
		};
		const result = {
			startTime: new Date(1000), duration: 40_000, status: "passed", annotations: [],
			workerIndex: 0, retry: 0,
			steps: [{ startTime: new Date(41_000), duration: 21_000 }],
		};
		reporter.onTestEnd(testCase, result);
		reporter.onStdOut("e2e timing: harness start", testCase, result);
		reporter.onStdOut("up 12 ms\ne2e timing: controls fixture startup 8 ms\n", testCase, result);
		assert.deepEqual(await reporter.onEnd({ status: "passed" }), { status: "failed" });
		const report = JSON.parse(readFileSync(join(directory, "test-durations.json"), "utf8"));
		assert.equal(report.tests[0].durationMs, 61_000);
		assert.deepEqual(report.components.map(value => value.durationMs), [12, 8]);
		assert.match(report.violations[0], /split setup and cleanup/);
		assert.match(report.violations[0], /61000/);
		assert.match(report.violations[0], /60000/);
		assert.match(report.violations[0], /exception|approval|decision/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("attempted Playwright skips retain their budget while unstarted static skips cost zero", async () => {
	const directory = scratch();
	try {
		const reporter = new TimingReporter();
		reporter.onBegin({ projects: [{ outputDir: directory }] });
		for (const attempted of [false, true]) {
			reporter.onTestEnd({
				titlePath: () => [attempted ? "runtime skip after work" : "unstarted static skip"],
				location: { file: "proof.spec.ts", line: 1 }, timeout: 60_000,
				parent: { project: () => ({ name: "proof" }) },
			}, {
				startTime: new Date(1000), duration: attempted ? 40_000 : 0,
				status: "skipped", annotations: [], workerIndex: 0, retry: 0,
				steps: attempted ? [{ startTime: new Date(41_000), duration: 21_000 }] : [],
			});
		}
		assert.deepEqual(await reporter.onEnd({ status: "passed" }), { status: "failed" });
		const report = JSON.parse(readFileSync(join(directory, "test-durations.json"), "utf8"));
		assert.deepEqual(report.tests.map(value => value.durationMs), [0, 61_000]);
		assert.equal(report.violations.length, 1);
		assert.match(report.violations[0], /runtime skip after work took 61000/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("duration report write failures preserve the suite result", async () => {
	const reporter = new TimingReporter();
	reporter.onBegin({ projects: [{ outputDir: reporterPath }] });
	assert.equal(await reporter.onEnd({ status: "passed" }), undefined);
	assert.equal(await reporter.onEnd({ status: "failed" }), undefined);
	assert.equal(await reporter.onEnd({ status: "interrupted" }), undefined);
	assert.equal(await reporter.onEnd({ status: "timedout" }), undefined);
});

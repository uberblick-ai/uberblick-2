import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runUnitTests, unitTestPlan } from "./run-unit-tests.mjs";

test("all concurrent package pools share the declared machine budget", () => {
	for (const [scope, cores, budget, concurrency, workers] of [
		["all", 4, 12, 3, 4],
		["os", 3, 9, 3, 3],
	]) {
		const plan = unitTestPlan(scope, cores);
		assert.deepEqual([plan.budget, plan.concurrency, plan.workers], [budget, concurrency, workers]);
	}
	for (const scope of ["all", "os"]) {
		for (const cores of [1, 2, 3, 4, 8, 32]) {
			const plan = unitTestPlan(scope, cores);
			assert.ok(plan.workers >= 1);
			assert.ok(plan.concurrency >= 2);
			assert.ok(plan.concurrency * plan.workers <= plan.budget);
		}
	}
});

test("shared invocations preserve package failures and scope without changing the caller's worker setting", () => {
	const env = { VITEST_MAX_WORKERS: "99", EXISTING: "kept" };
	const calls = [];
	const result = runUnitTests("os", {
		cores: 4,
		env,
		log() {},
		spawn(command, args, options) {
			calls.push({ command, args, options });
			return { status: 7 };
		},
	});
	assert.equal(result, 7);
	assert.equal(calls.length, 1);
	const [{ command, args, options }] = calls;
	assert.equal(command, "pnpm");
	assert.deepEqual(args, [
		"--filter", "@uberblick/cli",
		"--filter", "@uberblick/mcp-server",
		"--filter", "@uberblick/hub",
		"--no-sort", "--no-bail", "--workspace-concurrency", "3", "test",
	]);
	assert.equal(options.stdio, "inherit");
	assert.equal(options.env.UB_TEST_SCOPE, "os");
	assert.equal(options.env.VITEST_MAX_WORKERS, String(unitTestPlan("os", 4).workers));
	assert.equal(options.env.EXISTING, "kept");
	assert.deepEqual(env, { VITEST_MAX_WORKERS: "99", EXISTING: "kept" });
});

test("a killed package runner cannot report success", () => {
	assert.equal(runUnitTests("all", {
		cores: 4,
		env: {},
		log() {},
		spawn() { return { status: null, signal: "SIGTERM" }; },
	}), 128 + constants.signals.SIGTERM);
});

test("an invalid scope fails before starting any suites", () => {
	assert.throws(() => unitTestPlan("unknown", 4), /usage:/);
});

test("GitHub collection preserves a failing runner's status and moves its package timings out of the checkout", (t) => {
	const base = mkdtempSync(join(tmpdir(), `unit-tests-${process.env.UB_AGENTS_RUN ?? "local"}-`));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	mkdirSync(bin);
	const fakePnpm = join(bin, "pnpm");
	writeFileSync(fakePnpm, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nif (process.argv.includes("--report-summary")) writeFileSync("pnpm-exec-summary.json", JSON.stringify({ executionStatus: { example: { status: "failure", duration: 12 } } }));\nprocess.exit(7);\n`);
	chmodSync(fakePnpm, 0o755);
	const runnerTemp = join(base, "runner-temp");
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run-unit-tests.mjs", import.meta.url)), "all"], {
		cwd: base,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: "true", RUNNER_TEMP: runnerTemp },
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(result.status, 7, result.stderr);
	assert.equal(existsSync(join(base, "pnpm-exec-summary.json")), false);
	assert.equal(JSON.parse(readFileSync(join(runnerTemp, "vitest-results", "package-times.json"), "utf8")).executionStatus.example.status, "failure");
});

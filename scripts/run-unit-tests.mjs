#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { join } from "node:path";

const WORKERS_PER_CORE = 4;
const OS_PACKAGES = ["@uberblick/cli", "@uberblick/mcp-server", "@uberblick/hub"];

export function unitTestPlan(scope, cores, setting) {
	if (scope !== "all" && scope !== "os") {
		throw new Error("usage: node scripts/run-unit-tests.mjs [all|os]");
	}
	const args = scope === "all"
		? ["-r"]
		: OS_PACKAGES.flatMap((name) => ["--filter", name]);
	args.push("--no-sort", "--no-bail");
	if (setting === "baseline") {
		return { args: [...args, "test"], cores, budget: null };
	}
	const multiplier = setting ? Number(setting) : WORKERS_PER_CORE;
	if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
		throw new Error("UB_TEST_WORKER_BUDGET must be a positive integer multiplier or baseline");
	}
	const budget = multiplier * cores;
	if (!Number.isSafeInteger(budget) || budget < 1) {
		throw new Error("The worker budget must be a positive safe integer");
	}
	const concurrency = Math.min(4, budget, scope === "os" ? OS_PACKAGES.length : 5);
	const workers = Math.floor(budget / concurrency);
	args.push("--workspace-concurrency", String(concurrency), "test");
	return { args, cores, budget, concurrency, workers };
}

export function runUnitTests(scope, {
	env = process.env,
	cores = availableParallelism(),
	spawn = spawnSync,
	log = console.log,
	warn = console.warn,
} = {}) {
	const plan = unitTestPlan(scope, cores, env.UB_TEST_WORKER_BUDGET);
	const childEnv = { ...env };
	if (scope === "os") childEnv.UB_TEST_SCOPE = "os";
	if (plan.budget === null) {
		delete childEnv.VITEST_MAX_WORKERS;
		log(`Unit tests: baseline package pools on ${plan.cores} available cores`);
	} else {
		childEnv.VITEST_MAX_WORKERS = String(plan.workers);
		log(`Unit tests: ${plan.budget} worker budget on ${plan.cores} available cores; ${plan.concurrency} concurrent packages × ${plan.workers} workers`);
	}
	const reportTimes = env.GITHUB_ACTIONS === "true" && env.RUNNER_TEMP;
	if (reportTimes) plan.args.splice(plan.args.length - 1, 0, "--report-summary");
	const result = spawn("pnpm", plan.args, { env: childEnv, stdio: "inherit" });
	if (reportTimes) {
		try {
			const directory = join(env.RUNNER_TEMP, "vitest-results");
			mkdirSync(directory, { recursive: true });
			copyFileSync("pnpm-exec-summary.json", join(directory, "package-times.json"));
			rmSync("pnpm-exec-summary.json");
		} catch (error) {
			warn(`Could not collect package timings: ${error.message}`);
		}
	}
	if (result.error) throw result.error;
	return result.status ?? 128 + (constants.signals[result.signal] ?? 1);
}

if (import.meta.main) {
	try {
		process.exitCode = runUnitTests(process.argv[2] ?? "all");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

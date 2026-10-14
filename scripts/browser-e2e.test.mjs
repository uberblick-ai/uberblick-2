import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, ".github/workflows/ci.yml");
const absentWorkflow = existsSync(workflowPath)
	? undefined
	: ".github/workflows is absent from the isolated review context";
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const browserJobs = ["e2e-chromium-1", "e2e-chromium-2", "e2e-webkit-1", "e2e-webkit-2", "e2e-workload"];

function job(id) {
	const body = workflow.match(new RegExp(`^ {2}${id}:\\n((?: {4}.*\\n|\\n)*)`, "m"))?.[0];
	assert.ok(body, `the browser job ${id} must exist`);
	return body;
}

test("the one required browser gate rejects failure, cancellation and skips", { skip: absentWorkflow }, () => {
	assert.equal(workflow.match(/^ {4}name: browser e2e$/gm)?.length, 1);
	const gate = job("e2e");
	assert.match(gate, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
	const dependencies = gate.match(/^ {4}needs: \[([^\]]+)\]$/m)?.[1].split(", ");
	assert.deepEqual(dependencies, browserJobs);
	const command = gate.match(/^ {6}- run: (.+)$/m)?.[1];
	assert.ok(command, "the aggregate must execute its result check");
	function probe(results, succeeds) {
		const script = command.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, name) => {
			assert.ok(browserJobs.includes(name), `unexpected dependency ${name}`);
			return results[name] ?? "";
		});
		const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
		assert.equal(result.status === 0, succeeds, `${JSON.stringify(results)}: ${result.stderr}`);
	}
	const success = Object.fromEntries(browserJobs.map((id) => [id, "success"]));
	probe(success, true);
	for (const id of browserJobs) {
		for (const status of ["failure", "cancelled", "skipped", undefined]) {
			probe({ ...success, [id]: status }, false);
		}
	}
});

function list(arguments_) {
	const web = join(root, "packages/web");
	const require = createRequire(join(web, "package.json"));
	const cli = require.resolve("@playwright/test/cli");
	const result = spawnSync(process.execPath, [cli, "test", "--list", "--reporter=json", ...arguments_], {
		cwd: web,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
		env: {
			...process.env,
			PLAYWRIGHT_JSON_OUTPUT_NAME: "",
			PLAYWRIGHT_JSON_OUTPUT_FILE: "",
		},
	});
	assert.equal(result.status, 0, result.stderr || String(result.error));
	return JSON.parse(result.stdout);
}

function cases(report) {
	const result = [];
	function visit(suite, parents = []) {
		const titles = [...parents, suite.title];
		for (const spec of suite.specs ?? []) {
			for (const testCase of spec.tests) {
				result.push({
					key: JSON.stringify([testCase.projectName, spec.file, spec.line, spec.column, ...titles, spec.title]),
					file: `${testCase.projectName}:${spec.file}`,
				});
			}
		}
		for (const child of suite.suites ?? []) visit(child, titles);
	}
	for (const suite of report.suites) visit(suite);
	return result;
}

test("CI selections partition the full browser suite exactly once without splitting shared files", {
	skip: absentWorkflow,
	timeout: 120_000,
}, () => {
	const argumentsByJob = browserJobs.map((id) => {
		const body = job(id);
		assert.match(body, /^ {4}runs-on: ubuntu-latest$/m);
		assert.doesNotMatch(body, /^ {4}(?:needs|if|continue-on-error):/m);
		const arguments_ = body.match(/^ {8}run: mise run e2e (.+)$/m)?.[1];
		assert.ok(arguments_, `the browser job ${id} must execute its suite`);
		return arguments_;
	});
	assert.equal(argumentsByJob[4], "--project=chromium-workload --no-deps");
	const complete = list([]);
	assert.equal(complete.config.fullyParallel, false);
	assert.equal(complete.config.workers, 2);
	assert.ok(complete.config.projects.every((project) => project.retries === 0));
	const completeCases = cases(complete);
	const selections = argumentsByJob.map((arguments_) => cases(list(arguments_.split(" "))));
	const selected = selections.flat().map(({ key }) => key);
	assert.equal(new Set(selected).size, selected.length, "no project case may run in more than one job");
	assert.deepEqual(selected.sort(), completeCases.map(({ key }) => key).sort(), "every retained case must run");
	for (const [first, second] of [[0, 1], [2, 3]]) {
		const firstShardFiles = new Set(selections[first].map(({ file }) => file));
		assert.ok(selections[second].every(({ file }) => !firstShardFiles.has(file)), "shared-harness files stay on one shard");
	}
});

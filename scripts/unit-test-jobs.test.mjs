import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unitTestPlan } from "./run-unit-tests.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, ".github/workflows/ci.yml");
const absentWorkflow = existsSync(workflowPath)
	? undefined
	: ".github/workflows is absent from the isolated review context";
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const linuxJobs = ["lint", "unit-tests"];

function job(id) {
	const body = workflow.match(new RegExp(`^ {2}${id}:\\n((?: {4}.*\\n|\\n)*)`, "m"))?.[0];
	assert.ok(body, `the ${id} job must exist`);
	return body;
}

function unitJobs() {
	const entries = job("unit-tests").match(/^ {8}include:\n((?: {10}.*\n|\n)*)/m)?.[1];
	assert.ok(entries, "the Linux package jobs have explicit selections");
	return entries.split(/^ {10}- /m).slice(1).map((entry) => ({
		id: entry.match(/^id: ([\w-]+)$/m)?.[1],
		name: entry.match(/^ {12}name: (.+)$/m)?.[1],
		command: entry.match(/^ {12}command: (.+)$/m)?.[1],
	}));
}

test("the required Linux aggregate rejects every unsuccessful dependency result", { skip: absentWorkflow }, () => {
	assert.equal(workflow.match(/^ {4}name: lint, typecheck and tests$/gm)?.length, 1);
	const gate = job("checks");
	assert.match(gate, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
	assert.doesNotMatch(gate, /continue-on-error:/);
	assert.deepEqual(gate.match(/^ {4}needs: \[([^\]]+)\]$/m)?.[1].split(", "), linuxJobs);
	const command = gate.match(/^ {6}- run: (.+)$/m)?.[1];
	assert.ok(command, "the aggregate executes its dependency result check");
	function probe(results, succeeds) {
		const script = command.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, name) => {
			assert.ok(linuxJobs.includes(name), `unexpected dependency ${name}`);
			return results[name] ?? "";
		});
		const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
		assert.equal(result.status === 0, succeeds, `${JSON.stringify(results)}: ${result.stderr}`);
	}
	const success = Object.fromEntries(linuxJobs.map((id) => [id, "success"]));
	probe(success, true);
	for (const id of linuxJobs) {
		for (const status of ["failure", "cancelled", "skipped", undefined]) {
			probe({ ...success, [id]: status }, false);
		}
	}
});

test("Linux package jobs run independently and scripts remain eligible after a package failure", {
	skip: absentWorkflow,
}, () => {
	const body = job("unit-tests");
	assert.match(body, /^ {4}name: \$\{\{ matrix.name \}\}$/m);
	assert.match(body, /^ {4}runs-on: ubuntu-latest$/m);
	assert.match(body, /^ {6}fail-fast: false$/m);
	assert.doesNotMatch(body, /^ {4}(?:needs|if|continue-on-error):/m);
	assert.doesNotMatch(body, /UB_TEST_SCOPE|VITEST_MAX_WORKERS/);
	const steps = body.split(/^ {6}- /m).slice(1);
	const packages = steps.find((step) => /id: test-packages\n/.test(step));
	assert.ok(packages, "the package suite has an observable result");
	assert.match(packages, /^ {8}run: \$\{\{ matrix.command \}\}$/m);
	assert.doesNotMatch(packages, /continue-on-error:/);
	const scripts = steps.filter((step) => /^ {8}run: mise exec -- pnpm run test:scripts$/m.test(step));
	assert.equal(scripts.length, 1, "the root script suites have one invocation");
	assert.ok(steps.indexOf(scripts[0]) > steps.indexOf(packages));
	assert.match(scripts[0], /^if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' && matrix\.id == 'hub-schema-scripts' \}\}$/m);
	assert.doesNotMatch(scripts[0], /continue-on-error:/);
});

test("Linux jobs partition every workspace package exactly once, including packages added later", {
	skip: absentWorkflow,
}, () => {
	const entries = unitJobs();
	assert.deepEqual(entries.map(({ id }) => id).sort(), ["cli", "hub-schema-scripts", "mcp-server", "web"]);
	const assignments = new Map();
	for (const { id, name, command } of entries) {
		const standalone = command?.match(/^mise exec -- pnpm --filter (@[\w/-]+) test$/);
		const shared = command?.match(/^mise exec -- node scripts\/run-unit-tests\.mjs ([\w-]+)$/);
		let names;
		if (standalone) {
			names = [standalone[1]];
			assert.equal(name, `${id} tests`, "a standalone check names its package");
			assert.equal(standalone[1], `@uberblick/${id}`);
		} else {
			assert.ok(shared, `${id} must run a recognized package selection`);
			assert.equal(id, "hub-schema-scripts");
			assert.equal(name, "hub, schema and scripts tests");
			const plan = unitTestPlan(shared[1], 4);
			names = plan.args.flatMap((argument, index) => argument === "--filter" ? [plan.args[index + 1]] : []);
			assert.deepEqual(names, ["@uberblick/hub", "@uberblick/schema"]);
			assert.ok(plan.args.includes("--no-bail"), "one shared package failure does not skip the other");
		}
		for (const packageName of names) {
			assert.equal(assignments.has(packageName), false, `${packageName} must have one Linux owner`);
			assignments.set(packageName, id);
		}
	}
	const manifests = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
		.map((entry) => JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")));
	assert.deepEqual([...assignments.keys()].sort(), manifests.map(({ name }) => name).sort(),
		"assign every package under packages/ to a Linux job before adding it");
	for (const manifest of manifests) assert.ok(manifest.scripts?.test, `${manifest.name} runs its unit suite`);
});

test("lint and typecheck still run after an earlier check fails, and macOS keeps test-os", {
	skip: absentWorkflow,
}, () => {
	const lint = job("lint");
	assert.match(lint, /^ {4}name: lint and typecheck$/m);
	assert.match(lint, /^ {4}runs-on: ubuntu-latest$/m);
	assert.doesNotMatch(lint, /^ {4}(?:needs|if|continue-on-error):/m);
	const steps = lint.split(/^ {6}- /m).slice(1);
	for (const command of ["lint", "typecheck"]) {
		const step = steps.find((entry) => new RegExp(`^ {8}run: mise run ${command}$`, "m").test(entry));
		assert.ok(step, `${command} stays in the shared lint job`);
		assert.match(step, /if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' \}\}/);
		assert.doesNotMatch(step, /continue-on-error:/);
	}
	const macos = job("macos");
	assert.match(macos, /^ {4}name: macOS tests$/m);
	assert.match(macos, /^ {4}runs-on: macos-latest$/m);
	assert.match(macos, /^ {8}run: mise run test-os$/m);
	const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
	assert.equal(scripts.test, "node scripts/run-unit-tests.mjs all && pnpm run test:scripts");
	assert.match(scripts["test:scripts"], /"scripts\/\*\.test\.mjs"/);
	assert.match(scripts["test:os"], /^node scripts\/run-unit-tests\.mjs os && /);
});

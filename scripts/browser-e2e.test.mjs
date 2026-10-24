import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, ".github/workflows/ci.yml");
const absentWorkflow = existsSync(workflowPath)
	? undefined
	: ".github/workflows is absent from the isolated review context";
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const browserJobs = [
	"e2e-chromium-1",
	"e2e-chromium-2",
	"e2e-chromium-3",
	"e2e-webkit-1",
	"e2e-webkit-2",
	"e2e-webkit-3",
	"e2e-workload",
];

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

test("WebKit images match the pinned browser package and need no host-package installation", {
	skip: absentWorkflow,
}, () => {
	const { devDependencies } = JSON.parse(readFileSync(join(root, "packages/web/package.json"), "utf8"));
	for (const id of browserJobs.filter((id) => id.startsWith("e2e-webkit-"))) {
		const body = job(id);
		const image = body.match(/^ {6}image: mcr\.microsoft\.com\/playwright:v([^@]+)@sha256:[a-f0-9]{64}$/m)?.[1];
		assert.equal(image, `${devDependencies["@playwright/test"]}-noble`);
		assert.doesNotMatch(body, /install-deps|apt-get|apt install/);
		assert.doesNotMatch(body, /path: ~\/\.cache\/ms-playwright/);
	}
});

test("failed browser suites upload isolated attempt output without changing their result", { skip: absentWorkflow }, () => {
	for (const id of browserJobs) {
		const body = job(id);
		assert.doesNotMatch(body, /^ {4}(?:if|continue-on-error):/m);
		const steps = body.split(/^ {6}- /m).slice(1);
		const suite = steps.find((step) => /^ {8}run: mise run e2e /m.test(step));
		assert.ok(suite, `${id} executes a browser suite`);
		assert.match(suite, /^ {8}id: browser-suite$/m);
		assert.doesNotMatch(suite, /continue-on-error:/);
		const uploads = steps.filter((step) => step.includes("uses: actions/upload-artifact@"));
		assert.equal(uploads.length, 1, `${id} has one output upload`);
		const [upload] = uploads;
		assert.ok(steps.indexOf(upload) > steps.indexOf(suite));
		assert.match(upload, /^ {8}if: \$\{\{ always\(\) && steps\.browser-suite\.outcome == 'failure' \}\}$/m);
		assert.match(upload, /^ {8}continue-on-error: true$/m);
		assert.match(upload, /^ {8}timeout-minutes: 1$/m);
		assert.match(upload, /^ {8}uses: actions\/upload-artifact@[a-f0-9]{40}(?: #.*)?$/m);
		assert.match(upload, /^ {10}name: playwright-\$\{\{ github\.job \}\}-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}$/m);
		assert.match(upload, /^ {10}path: packages\/web\/test-results\/$/m);
		assert.doesNotMatch(upload, /^ {10}overwrite: true$/m);
	}
});

test("interactive projects retain first-failure traces while workload timings stay untraced", async () => {
	const { default: config } = await import("../packages/web/playwright.config.ts");
	assert.equal(config.retries, 0);
	for (const project of config.projects) {
		const use = { ...config.use, ...project.use };
		assert.equal(use.trace, project.name === "chromium-workload" ? "off" : "retain-on-failure", project.name);
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
	assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
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
	assert.equal(argumentsByJob[browserJobs.indexOf("e2e-workload")], "--project=chromium-workload --no-deps");
	const complete = list([]);
	assert.equal(complete.config.fullyParallel, false);
	assert.equal(complete.config.workers, 2);
	assert.ok(complete.config.projects.every((project) => project.retries === 0));
	const completeCases = cases(complete);
	const selections = argumentsByJob.map((arguments_) => cases(list(arguments_.split(" "))));
	const selected = selections.flat().map(({ key }) => key);
	assert.equal(new Set(selected).size, selected.length, "no project case may run in more than one job");
	assert.deepEqual(selected.sort(), completeCases.map(({ key }) => key).sort(), "every retained case must run");
	const fileOwners = new Map();
	for (const [index, selection] of selections.entries()) {
		for (const { file } of selection) {
			assert.ok(!fileOwners.has(file) || fileOwners.get(file) === index, `${file} must stay on one browser job`);
			fileOwners.set(file, index);
		}
	}
});

test("a new spec runs on exactly one Chromium job without changing the workflow or file list", {
	skip: absentWorkflow,
	timeout: 120_000,
}, () => {
	const directory = mkdtempSync(join(tmpdir(), "browser-partition-"));
	try {
		const require = createRequire(join(root, "packages/web/package.json"));
		const configPath = join(directory, "playwright.config.mjs");
		writeFileSync(configPath, `import config from ${JSON.stringify(join(root, "packages/web/playwright.config.ts"))};
export default { ...config, testDir: ${JSON.stringify(directory)}, globalSetup: undefined, reporter: "json" };\n`);
		writeFileSync(join(directory, "new-unlisted.spec.mjs"), `import playwright from ${JSON.stringify(require.resolve("@playwright/test"))};
const { test } = playwright;
test("first new case", () => {});
test("second new case", () => {});\n`);
		const selections = browserJobs.filter((id) => id.startsWith("e2e-chromium-")).map((id) => {
			const arguments_ = job(id).match(/^ {8}run: mise run e2e (.+)$/m)?.[1];
			assert.ok(arguments_);
			return cases(list([...arguments_.split(" "), `--config=${configPath}`, "--pass-with-no-tests"]));
		});
		assert.equal(selections.flat().length, 2, "both new cases run exactly once");
		assert.equal(selections.filter((selection) => selection.length > 0).length, 1, "the new file stays on one job");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

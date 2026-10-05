import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(dirname(here));
const script = join(repoRoot, "bin/run-e2e.sh");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), `uberblick-${process.env.UB_AGENTS_RUN ?? "test"}-e2e-runner-`));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const cacheParent = process.env.UB_AGENTS_SCRATCH ?? join(homedir(), ".cache");
	mkdirSync(cacheParent, { recursive: true });
	const cache = mkdtempSync(join(cacheParent, `uberblick-${process.env.UB_AGENTS_RUN ?? "test"}-e2e-runner-test-`));
	const log = join(root, "commands.log");

	for (const command of ["pnpm", "fnox"]) {
		const path = join(bin, command);
		const statusVariable = command === "pnpm" ? "E2E_TEST_INSTALL_STATUS" : "E2E_TEST_STATUS";
		writeFileSync(
			path,
			`#!/bin/sh\nprintf '%s\\t%s' "$TMPDIR" "$PWD" >> "$E2E_TEST_LOG"\nfor arg do printf '\\t%s' "$arg" >> "$E2E_TEST_LOG"; done\nprintf '\\n' >> "$E2E_TEST_LOG"\nexit "\${${statusVariable}:-0}"\n`,
		);
		chmodSync(path, 0o755);
	}
	const df = join(bin, "df");
	writeFileSync(
		df,
		`#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'fixture 9999999 1 %s 1%% /fixture\\n' "$E2E_TEST_AVAILABLE_KIB"\n`,
	);
	chmodSync(df, 0o755);

	function run({ args = [], available = "2097152", status = "0", installStatus = "0" } = {}) {
		return spawnSync("sh", [script, ...args], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				E2E_TEST_AVAILABLE_KIB: available,
				E2E_TEST_LOG: log,
				E2E_TEST_INSTALL_STATUS: installStatus,
				E2E_TEST_STATUS: status,
				PATH: `${bin}:${process.env.PATH}`,
				XDG_CACHE_HOME: cache,
			},
		});
	}

	return {
		cache,
		log,
		remove() {
			rmSync(root, { recursive: true, force: true });
			rmSync(cache, { recursive: true, force: true });
		},
		run,
	};
}

test("the browser install and suite share private storage that is always removed", (t) => {
	const first = fixture();
	t.after(() => first.remove());

	let result = first.run();
	assert.equal(result.status, 0, result.stderr);
	const calls = readFileSync(first.log, "utf8").trim().split("\n");
	assert.equal(calls.length, 2);
	const [installTmp, installCwd] = calls[0].split("\t");
	const [suiteTmp, suiteCwd] = calls[1].split("\t");
	// This exact install argument list permits engine downloads, never host
	// package installation (install-deps or --with-deps).
	assert.deepEqual(calls[0].split("\t").slice(2), [
		"--filter", "@uberblick/web", "exec", "playwright", "install", "chromium", "webkit",
	]);
	assert.deepEqual(calls[1].split("\t").slice(2), [
		"exec", "--if-missing", "warn", "--", "pnpm", "--filter", "@uberblick/web", "run", "e2e",
	]);
	assert.equal(installCwd, repoRoot);
	assert.equal(suiteCwd, repoRoot);
	assert.equal(suiteTmp, installTmp);
	assert.match(installTmp, /\/uberblick\/e2e\/run\.[^/]+$/);
	assert.doesNotMatch(installTmp, /^\/(?:private\/)?tmp(?:\/|$)/);
	assert.equal(existsSync(installTmp), false);

	const failed = fixture();
	t.after(() => failed.remove());
	result = failed.run({ status: "23" });
	assert.equal(result.status, 23);
	const failedCalls = readFileSync(failed.log, "utf8").trim().split("\n");
	assert.equal(failedCalls.length, 2, "a failed browser suite must propagate its exit status");
	const [failedTmp] = failedCalls[1].split("\t");
	assert.equal(existsSync(failedTmp), false);
});

test("an engine download failure stops the suite and removes private storage", (t) => {
	const current = fixture();
	t.after(() => current.remove());
	const result = current.run({ installStatus: "19" });
	assert.equal(result.status, 19);
	const calls = readFileSync(current.log, "utf8").trim().split("\n");
	assert.equal(calls.length, 1);
	const [installTmp] = calls[0].split("\t");
	assert.equal(existsSync(installTmp), false);
});

test("Playwright arguments keep their boundaries and order", (t) => {
	const current = fixture();
	t.after(() => current.remove());

	const result = current.run({
		args: ["--project=chromium", "--repeat-each=3", "outline.spec.ts", "--grep", "focused name"],
	});
	assert.equal(result.status, 0, result.stderr);
	const [, suite] = readFileSync(current.log, "utf8").trim().split("\n");
	assert.deepEqual(suite.split("\t").slice(-5), [
		"--project=chromium",
		"--repeat-each=3",
		"outline.spec.ts",
		"--grep",
		"focused name",
	]);
});

test("insufficient capacity stops before browsers and cleans the private directory", (t) => {
	const current = fixture();
	t.after(() => current.remove());

	const result = current.run({ available: "1048575" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /at least 1048576 KiB is required/);
	assert.match(result.stderr, /Browsers were not started/);
	assert.equal(existsSync(current.log), false);
	assert.deepEqual(readdirSync(join(current.cache, "uberblick/e2e")), []);
});

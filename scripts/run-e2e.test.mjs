import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "run-e2e.sh");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "uberblick-e2e-runner-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const cacheParent = join(homedir(), ".cache");
	mkdirSync(cacheParent, { recursive: true });
	const cache = mkdtempSync(join(cacheParent, "uberblick-e2e-runner-test-"));
	const log = join(root, "commands.log");

	for (const command of ["pnpm", "fnox"]) {
		const path = join(bin, command);
		writeFileSync(
			path,
			`#!/bin/sh\nprintf '%s\\t%s\\n' "$TMPDIR" "$*" >> "$E2E_TEST_LOG"\nexit "\${E2E_TEST_STATUS:-0}"\n`,
		);
		chmodSync(path, 0o755);
	}
	const df = join(bin, "df");
	writeFileSync(
		df,
		`#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'fixture 9999999 1 %s 1%% /fixture\\n' "$E2E_TEST_AVAILABLE_KIB"\n`,
	);
	chmodSync(df, 0o755);

	function run({ available = "2097152", status = "0" } = {}) {
		return spawnSync("sh", [script], {
			encoding: "utf8",
			env: {
				...process.env,
				E2E_TEST_AVAILABLE_KIB: available,
				E2E_TEST_LOG: log,
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
	const [installTmp] = calls[0].split("\t");
	const [suiteTmp] = calls[1].split("\t");
	assert.equal(suiteTmp, installTmp);
	assert.match(installTmp, /\/uberblick\/e2e\/run\.[^/]+$/);
	assert.doesNotMatch(installTmp, /^\/(?:private\/)?tmp(?:\/|$)/);
	assert.equal(existsSync(installTmp), false);

	const failed = fixture();
	t.after(() => failed.remove());
	result = failed.run({ status: "23" });
	assert.equal(result.status, 23);
	const [failedTmp] = readFileSync(failed.log, "utf8").trim().split("\t");
	assert.equal(existsSync(failedTmp), false);
});

test("insufficient capacity stops before Chromium and cleans the private directory", (t) => {
	const current = fixture();
	t.after(() => current.remove());

	const result = current.run({ available: "1048575" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /at least 1048576 KiB is required/);
	assert.match(result.stderr, /Chromium was not started/);
	assert.equal(existsSync(current.log), false);
	assert.deepEqual(readdirSync(join(current.cache, "uberblick/e2e")), []);
});

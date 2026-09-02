import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/housekeeping.sh");

function fixture(t) {
	const base = mkdtempSync(join(tmpdir(), "housekeeping-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	mkdirSync(bin);
	return { base, bin, calls: join(base, "docker-calls") };
}

function fakeDocker(bin, body) {
	const path = join(bin, "docker");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function environment(bin, calls) {
	return {
		...process.env,
		HOUSEKEEPING_CALLS: calls,
		PATH: `${bin}:${process.env.PATH}`,
	};
}

test("cleans the current and older review images plus stale Docker artifacts", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  *"before=uberblick-review:test-sha"*) printf "older-b\\nolder-a\\nolder-a\\n" ;;\n' +
			'  "image ls -q uberblick-review:test-sha") printf "current-image\\n" ;;\n' +
			'esac\n' +
			'exit 0',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.equal(result.status, 0, result.stderr);
	const commands = readFileSync(calls, "utf8");
	assert.match(commands, /image rm -f older-a older-b/);
	assert.match(commands, /image rm -f uberblick-review:test-sha/);
	assert.match(commands, /container prune -f/);
	assert.match(commands, /image prune -f/);
	assert.match(commands, /image prune -a -f --filter until=168h/);
	assert.match(commands, /builder prune -f --filter until=168h/);
});

test("cleans all review images when this run's image is already absent", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  "image ls -q uberblick-review:test-sha") ;;\n' +
			'  "image ls -q --filter reference=uberblick-review") printf "remaining-b\\nremaining-a\\n" ;;\n' +
			'esac\n' +
			'exit 0',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(calls, "utf8"), /image rm -f remaining-a remaining-b/);
});

test("reports a failing Docker cleanup and exits nonzero", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'if [ "$1 $2" = "image ls" ]; then\n' +
			'  case "$*" in *"uberblick-review:test-sha"*) exit 0 ;; esac\n' +
			'  printf "old-image\\n"\n' +
			'  exit 0\n' +
			'fi\n' +
			'exit 17',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker image rm -f old-image/);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker container prune -f/);
});

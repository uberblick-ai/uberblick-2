import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "bin/housekeeping.sh");

function fixture(t) {
	// `realpathSync` because macOS `tmpdir()` is `/var/folders/...`, a symlink
	// into `/private/var`, and `git worktree list` reports the resolved path.
	// Comparing the script's output against an unresolved path matches nothing
	// there, which is why every worktree case failed on Darwin.
	const base = realpathSync(
		mkdtempSync(
			join(tmpdir(), `housekeeping-${process.env.UB_AGENTS_RUN ?? "local"}-`),
		),
	);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	mkdirSync(bin);
	return { base, bin, calls: join(base, "docker-calls") };
}

function fakeDocker(bin, body) {
	fakeExecutable(bin, "docker", body);
}

function fakeExecutable(bin, name, body) {
	const path = join(bin, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function environment(bin, calls, overrides = {}) {
	return {
		...process.env,
		HOUSEKEEPING_CALLS: calls,
		HOUSEKEEPING_DOCKER_OS: "Docker Engine",
		PATH: `${bin}:${process.env.PATH}`,
		...overrides,
	};
}

test("cleans every named and expired review image plus dangling images and bounded build cache", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  *"reference=uberblick-review"*"until=24h"*) printf "expired-b\\nexpired-a\\nexpired-a\\n" ;;\n' +
			'  *"reference=uberblick-review"*) printf "expired-b\\nexpired-a\\nrecent-peer\\n" ;;\n' +
			'  "image ls -q uberblick-review:test-sha") printf "current-image\\n" ;;\n' +
			'  "image ls -q uberblick-review:merge-sha") printf "merged-image\\n" ;;\n' +
			"esac\n" +
			"exit 0",
	);

	const result = spawnSync("sh", [script, "test-sha", "merge-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.equal(result.status, 0, result.stderr);
	const commands = readFileSync(calls, "utf8");
	assert.match(commands, /image rm -f expired-a expired-b/);
	assert.doesNotMatch(commands, /image rm -f .*recent-peer/);
	assert.match(
		commands,
		/image rm -f uberblick-review:test-sha uberblick-review:merge-sha/,
	);
	assert.doesNotMatch(commands, /container prune|image prune -a|volume prune/);
	assert.match(commands, /image prune -f/);
	assert.match(commands, /builder prune -f --max-used-space 1GB/);
	assert.match(commands, /builder prune -f --filter until=168h/);
	assert.match(commands, /builder prune -f --min-free-space 5GB/);
});

test("keeps stopped containers, their tagged images, volumes and old worktrees", (t) => {
	const { base, bin, calls } = fixture(t);
	const stopped = join(base, "stopped-container");
	const tagged = join(base, "tagged-hub-image");
	const volume = join(base, "hub-volume");
	const worktree = join(base, ".claude", "worktrees", "abandoned");
	for (const path of [stopped, tagged, volume, worktree]) {
		mkdirSync(path, { recursive: true });
	}
	fakeDocker(
		bin,
		`
printf '%s\\n' "$*" >> "$HOUSEKEEPING_CALLS"
case "$*" in
  "container prune"*) rmdir "$HOUSEKEEPING_DOCKER_ROOT/stopped-container" ;;
  "image prune -a"*) rmdir "$HOUSEKEEPING_DOCKER_ROOT/tagged-hub-image" ;;
  "volume prune"*) rmdir "$HOUSEKEEPING_DOCKER_ROOT/hub-volume" ;;
  info*) printf '%s\\n' "$HOUSEKEEPING_DOCKER_ROOT" ;;
  *) printf 'Total reclaimed space: 0B\\n' ;;
esac
`,
	);
	fakeExecutable(
		bin,
		"git",
		'printf "git %s\\n" "$*" >> "$HOUSEKEEPING_CALLS"',
	);
	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, { HOUSEKEEPING_DOCKER_ROOT: base }),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(
		readFileSync(calls, "utf8"),
		/container prune|image prune -a|volume prune|git /,
	);
	for (const path of [stopped, tagged, volume, worktree]) {
		assert.equal(existsSync(path), true, path);
	}
});

test("an absent named image does not suppress other named or expired images", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  "image ls -q uberblick-review:absent-sha") ;;\n' +
			'  "image ls -q uberblick-review:merge-sha") printf "merged-image\\n" ;;\n' +
			'  *"reference=uberblick-review"*"until=24h"*) printf "expired-b\\nexpired-a\\n" ;;\n' +
			'  *"reference=uberblick-review"*) printf "expired-b\\nexpired-a\\nrecent-peer\\n" ;;\n' +
			"esac\n" +
			"exit 0",
	);

	const result = spawnSync("sh", [script, "absent-sha", "merge-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.equal(result.status, 0, result.stderr);
	const commands = readFileSync(calls, "utf8");
	assert.match(commands, /image rm -f expired-a expired-b/);
	assert.doesNotMatch(commands, /image rm -f .*recent-peer/);
	assert.match(commands, /image rm -f uberblick-review:merge-sha/);
	assert.doesNotMatch(commands, /image rm -f .*uberblick-review:absent-sha/);
});

test("dry-run lists every selected image and removes none", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  "image ls -q uberblick-review:test-sha") printf "current-image\\n" ;;\n' +
			'  "image ls -q uberblick-review:merge-sha") printf "merged-image\\n" ;;\n' +
			'  *"reference=uberblick-review"*"until=24h"*) printf "expired-image\\n" ;;\n' +
			'  "info --format"*) printf "%s\\n" "$HOUSEKEEPING_DOCKER_ROOT" ;;\n' +
			"esac\n" +
			"exit 0",
	);

	const result = spawnSync(
		"sh",
		[script, "test-sha", "merge-sha", "--dry-run"],
		{
			cwd: base,
			encoding: "utf8",
			env: environment(bin, calls, { HOUSEKEEPING_DOCKER_ROOT: base }),
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /would: docker image rm -f expired-image/);
	assert.match(
		result.stdout,
		/would: docker image rm -f uberblick-review:test-sha uberblick-review:merge-sha/,
	);
	assert.doesNotMatch(readFileSync(calls, "utf8"), /image rm/);
});

test("resolves every image selection before removing any", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  "image ls -q uberblick-review:first-sha") printf "first-image\\n" ;;\n' +
			'  "image ls -q uberblick-review:second-sha") exit 17 ;;\n' +
			'  "info --format"*) printf "%s\\n" "$HOUSEKEEPING_DOCKER_ROOT" ;;\n' +
			'  *) printf "Total reclaimed space: 0B\\n" ;;\n' +
			"esac\n" +
			"exit 0",
	);

	const result = spawnSync("sh", [script, "first-sha", "second-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, { HOUSEKEEPING_DOCKER_ROOT: base }),
	});

	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/housekeeping: failed \(17\): docker image ls uberblick-review:second-sha/,
	);
	assert.doesNotMatch(readFileSync(calls, "utf8"), /image rm/);
});

test("rejects no arguments and --dry-run alone before invoking Docker", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(bin, 'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"');

	for (const args of [[], ["--dry-run"]]) {
		const result = spawnSync("sh", [script, ...args], {
			cwd: base,
			encoding: "utf8",
			env: environment(bin, calls),
		});

		assert.equal(result.status, 2);
		assert.match(
			result.stderr,
			/usage: sh bin\/housekeeping\.sh <review sha>\.\.\. \[--dry-run\]/,
		);
	}
	assert.equal(existsSync(calls), false);
});

test("reports a failing Docker cleanup and exits nonzero", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'if [ "$1 $2" = "image ls" ]; then\n' +
			'  case "$*" in *"uberblick-review:test-sha"*) exit 0 ;; esac\n' +
			'  printf "old-image\\n"\n' +
			"  exit 0\n" +
			"fi\n" +
			"exit 17",
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls),
	});

	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/housekeeping: failed \(17\): docker image rm -f old-image/,
	);
	assert.match(
		result.stderr,
		/housekeeping: failed \(17\): docker builder prune -f --max-used-space 1GB/,
	);
});

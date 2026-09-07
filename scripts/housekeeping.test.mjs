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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/housekeeping.sh");

function fixture(t) {
	// `realpathSync` because macOS `tmpdir()` is `/var/folders/...`, a symlink
	// into `/private/var`, and `git worktree list` reports the resolved path.
	// Comparing the script's output against an unresolved path matches nothing
	// there, which is why every worktree case failed on Darwin.
	const base = realpathSync(mkdtempSync(join(tmpdir(), "housekeeping-")));
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

function successfulDocker(bin) {
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$1 $2" in\n' +
			'  "info --format")\n' +
			'    case "$3" in\n' +
			'      "{{.DockerRootDir}}") printf "%s\\n" "$HOUSEKEEPING_DOCKER_ROOT" ;;\n' +
			'      "{{.OperatingSystem}}") printf "%s\\n" "$HOUSEKEEPING_DOCKER_OS" ;;\n' +
			'    esac\n' +
			'    ;;\n' +
			'  "image ls") ;;\n' +
			'  *) printf "Total reclaimed space: 0B\\n" ;;\n' +
			'esac\n' +
			'exit 0',
	);
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function worktreeScenario(t) {
	const { base, bin, calls } = fixture(t);
	runGit(base, ["init", "-q"]);
	runGit(base, ["config", "user.email", "housekeeping@example.test"]);
	runGit(base, ["config", "user.name", "Housekeeping Test"]);
	writeFileSync(join(base, "tracked"), "tracked\n");
	runGit(base, ["add", "tracked"]);
	runGit(base, ["commit", "-q", "-m", "fixture"]);

	const worktreeRoot = join(base, ".claude", "worktrees");
	mkdirSync(worktreeRoot, { recursive: true });
	const clean = join(worktreeRoot, "clean");
	const dirty = join(worktreeRoot, "dirty");
	const locked = join(worktreeRoot, "locked");
	const current = join(worktreeRoot, "current");
	const young = join(worktreeRoot, "young");
	const outside = join(base, "outside-worktree");
	for (const [branch, path] of [
		["clean", clean],
		["dirty", dirty],
		["locked", locked],
		["current", current],
		["young", young],
		["outside", outside],
	]) {
		runGit(base, ["worktree", "add", "-q", "-b", branch, path]);
	}
	writeFileSync(join(dirty, "untracked"), "keep me\n");
	runGit(base, ["worktree", "lock", locked]);
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	for (const path of [clean, dirty, locked, current, outside]) {
		utimesSync(path, old, old);
	}
	successfulDocker(bin);
	const env = environment(bin, calls, {
		HOUSEKEEPING_DOCKER_ROOT: base,
		HOUSEKEEPING_WARN_FREE_GB: "0",
		HOUSEKEEPING_WORKTREE_MAX_AGE_H: "1",
	});

	return { bin, clean, current, dirty, env, locked, outside, young };
}

function proveWorktreeCleanup({ clean, current, dirty, env, locked, outside, young }) {
	const dryRun = spawnSync("sh", [script, "test-sha", "--dry-run"], {
		cwd: current,
		encoding: "utf8",
		env,
	});
	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.match(
		dryRun.stdout,
		/would: docker builder prune -f --min-free-space 5GB/,
	);
	assert.ok(dryRun.stdout.includes(`would: git worktree remove ${clean} (2h old)`));
	assert.ok(
		dryRun.stdout.includes(`would keep (2h old): ${dirty} -- modified or untracked files`),
	);
	assert.ok(dryRun.stdout.includes(`would keep (2h old): ${locked} -- locked`));
	assert.equal(dryRun.stdout.includes(current), false);
	assert.equal(dryRun.stdout.includes(young), false);
	assert.equal(dryRun.stdout.includes(outside), false);
	assert.equal(existsSync(clean), true);

	const realRun = spawnSync("sh", [script, "test-sha"], {
		cwd: current,
		encoding: "utf8",
		env,
	});
	assert.equal(realRun.status, 0, realRun.stderr);
	assert.ok(realRun.stdout.includes(`housekeeping: removed worktree (2h old): ${clean}`));
	assert.ok(realRun.stdout.includes(`housekeeping: kept worktree (2h old): ${dirty}`));
	assert.ok(realRun.stdout.includes(`housekeeping: kept worktree (2h old): ${locked}`));
	assert.equal(realRun.stdout.includes(current), false);
	assert.equal(realRun.stdout.includes(young), false);
	assert.equal(realRun.stdout.includes(outside), false);
	assert.equal(existsSync(clean), false);
	assert.equal(existsSync(dirty), true);
	assert.equal(existsSync(locked), true);
	assert.equal(existsSync(current), true);
	assert.equal(existsSync(young), true);
	assert.equal(existsSync(outside), true);
}

test("cleans every named and expired review image plus stale Docker artifacts", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  *"reference=uberblick-review"*"until=24h"*) printf "expired-b\\nexpired-a\\nexpired-a\\n" ;;\n' +
			'  *"reference=uberblick-review"*) printf "expired-b\\nexpired-a\\nrecent-peer\\n" ;;\n' +
			'  "image ls -q uberblick-review:test-sha") printf "current-image\\n" ;;\n' +
			'  "image ls -q uberblick-review:merge-sha") printf "merged-image\\n" ;;\n' +
			'esac\n' +
			'exit 0',
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
	assert.match(commands, /container prune -f --filter until=168h/);
	assert.match(commands, /image prune -f/);
	assert.match(commands, /image prune -a -f --filter until=168h/);
	assert.match(commands, /builder prune -f --filter until=168h/);
	assert.match(commands, /builder prune -f --min-free-space 5GB/);
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
			'esac\n' +
			'exit 0',
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
			'esac\n' +
			'exit 0',
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
			'esac\n' +
			'exit 0',
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

test("reports each prune's reclaimed space and honors the configured cache floor", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$*" in\n' +
			'  info*) printf "%s\\n" "$HOUSEKEEPING_DOCKER_ROOT" ;;\n' +
			'  "image ls"*) ;;\n' +
			'  "container prune"*) printf "Total reclaimed space: 12MB\\n" ;;\n' +
			'  "image prune -f") printf "new Docker output format\\n" ;;\n' +
			'  "image prune -a"*) printf "Total reclaimed space: 3.1GB\\n" ;;\n' +
			'  "builder prune -f --filter"*) printf "Total:\\t2.5GB\\n" ;;\n' +
			'  "builder prune -f --min-free-space 7GB") printf "Total:\\t0B\\n" ;;\n' +
			'esac\n' +
			'exit 0',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, {
			HOUSEKEEPING_DOCKER_ROOT: base,
			HOUSEKEEPING_MIN_FREE: "7GB",
		}),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/housekeeping: reclaimed 12MB: docker container prune -f --filter until=168h/,
	);
	assert.match(result.stdout, /housekeeping: reclaimed unparsed: docker image prune -f/);
	assert.match(
		result.stdout,
		/housekeeping: reclaimed 3\.1GB: docker image prune -a -f --filter until=168h/,
	);
	assert.match(
		result.stdout,
		/housekeeping: reclaimed 2\.5GB: docker builder prune -f --filter until=168h/,
	);
	assert.match(
		result.stdout,
		/housekeeping: reclaimed 0B: docker builder prune -f --min-free-space 7GB/,
	);
});

test("warns with Docker's filesystem when its free space is below the threshold", (t) => {
	const { base, bin, calls } = fixture(t);
	successfulDocker(bin);
	fakeExecutable(
		bin,
		"df",
		'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"\n' +
			'printf "/dev/docker 9999999 0 2097152 0%% %s\\n" "$HOUSEKEEPING_DOCKER_ROOT"',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, {
			HOUSEKEEPING_DOCKER_ROOT: base,
			HOUSEKEEPING_WARN_FREE_GB: "3",
		}),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(
			`housekeeping: WARNING low disk: /dev/docker has 2GB free under 3GB threshold \\(docker root ${base}\\)`,
		),
	);
});

test("measures the host volume containing Docker Desktop's data", (t) => {
	const { base, bin, calls } = fixture(t);
	const home = join(base, "home");
	const desktopData = join(
		home,
		"Library",
		"Containers",
		"com.docker.docker",
		"Data",
		"vms",
		"0",
		"data",
	);
	mkdirSync(desktopData, { recursive: true });
	const diskImage = join(desktopData, "Docker.raw");
	writeFileSync(diskImage, "");
	successfulDocker(bin);
	const dfCalls = join(base, "df-calls");
	fakeExecutable(
		bin,
		"df",
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_DF_CALLS"\n' +
			'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"\n' +
			'printf "/dev/desktop 9999999 0 4194304 0%% %s\\n" "$2"',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, {
			HOME: home,
			HOUSEKEEPING_DOCKER_OS: "Docker Desktop",
			HOUSEKEEPING_DOCKER_ROOT: base,
			HOUSEKEEPING_DF_CALLS: dfCalls,
			HOUSEKEEPING_WARN_FREE_GB: "3",
		}),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/housekeeping: disk ok: \/dev\/desktop has 4GB free \(threshold 3GB\)/,
	);
	assert.doesNotMatch(result.stderr, /could not determine Docker root/);
	assert.equal(readFileSync(dfCalls, "utf8"), `-Pk ${diskImage}\n`);
	assert.ok(
		readFileSync(calls, "utf8").includes("info --format {{.OperatingSystem}}"),
	);
});

test("does not substitute another filesystem when Docker's root is unavailable", (t) => {
	const { base, bin, calls } = fixture(t);
	fakeDocker(
		bin,
		'printf "%s\\n" "$*" >> "$HOUSEKEEPING_CALLS"\n' +
			'case "$1 $2" in\n' +
			'  "info --format") exit 17 ;;\n' +
			'  "image ls") ;;\n' +
			'  *) printf "Total reclaimed space: 0B\\n" ;;\n' +
			'esac\n' +
			'exit 0',
	);
	fakeExecutable(bin, "df", 'printf "called\\n" >> "$HOUSEKEEPING_DF_CALLS"');
	const dfCalls = join(base, "df-calls");

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, { HOUSEKEEPING_DF_CALLS: dfCalls }),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /housekeeping: WARNING could not determine Docker root/);
	assert.equal(existsSync(dfCalls), false);

	successfulDocker(bin);
	const invalidDfCalls = join(base, "invalid-df-calls");
	const invalidRoot = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, calls, {
			HOUSEKEEPING_DF_CALLS: invalidDfCalls,
			HOUSEKEEPING_DOCKER_ROOT: join(base, "missing"),
		}),
	});

	assert.equal(invalidRoot.status, 0, invalidRoot.stderr);
	assert.match(invalidRoot.stderr, /housekeeping: WARNING could not determine Docker root/);
	assert.equal(existsSync(invalidDfCalls), false);

	successfulDocker(bin);
	const desktopCalls = join(base, "desktop-docker-calls");
	const desktopDfCalls = join(base, "desktop-df-calls");
	const emptyHome = join(base, "empty-home");
	mkdirSync(
		join(
			emptyHome,
			"Library",
			"Containers",
			"com.docker.docker",
			"Data",
			"vms",
			"0",
			"data",
		),
		{ recursive: true },
	);
	const missingDesktopData = spawnSync("sh", [script, "test-sha"], {
		cwd: base,
		encoding: "utf8",
		env: environment(bin, desktopCalls, {
			HOME: emptyHome,
			HOUSEKEEPING_DOCKER_OS: "Docker Desktop",
			HOUSEKEEPING_DOCKER_ROOT: base,
			HOUSEKEEPING_DF_CALLS: desktopDfCalls,
		}),
	});

	assert.equal(missingDesktopData.status, 0, missingDesktopData.stderr);
	assert.match(
		missingDesktopData.stderr,
		/housekeeping: WARNING could not determine Docker Desktop data location/,
	);
	assert.equal(existsSync(desktopDfCalls), false);
	assert.match(
		readFileSync(desktopCalls, "utf8"),
		/builder prune -f --min-free-space 5GB/,
	);
});

test("dry-run and real cleanup agree on removable, dirty, locked, and current worktrees", (t) => {
	proveWorktreeCleanup(worktreeScenario(t));
});

test("uses BSD stat when GNU stat is unavailable", (t) => {
	const scenario = worktreeScenario(t);
	fakeExecutable(
		scenario.bin,
		"stat",
		'case "$1 $2" in\n' +
			'  "-c %Y") exit 1 ;;\n' +
			'  "-f %m") exec date -r "$3" +%s ;;\n' +
			'  *) exit 2 ;;\n' +
			'esac',
	);
	proveWorktreeCleanup(scenario);
});

test("keeps and reports a worktree when neither stat dialect can read its age", (t) => {
	const scenario = worktreeScenario(t);
	fakeExecutable(scenario.bin, "stat", "exit 1");

	const dryRun = spawnSync("sh", [script, "test-sha", "--dry-run"], {
		cwd: scenario.current,
		encoding: "utf8",
		env: scenario.env,
	});
	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.ok(
		dryRun.stdout.includes(
			`would keep (age unavailable): ${scenario.clean} -- could not read worktree age`,
		),
	);

	const realRun = spawnSync("sh", [script, "test-sha"], {
		cwd: scenario.current,
		encoding: "utf8",
		env: scenario.env,
	});
	assert.equal(realRun.status, 0, realRun.stderr);
	assert.ok(
		realRun.stdout.includes(
			`housekeeping: kept worktree (age unavailable): ${scenario.clean} -- could not read worktree age`,
		),
	);
	assert.equal(existsSync(scenario.clean), true);
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
			/usage: housekeeping\.sh <review sha>\.\.\. \[--dry-run\]/,
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
	assert.match(
		result.stderr,
		/housekeeping: failed \(17\): docker container prune -f --filter until=168h/,
	);
});

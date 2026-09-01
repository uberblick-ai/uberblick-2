import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/housekeeping.sh");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
	return result.stdout.trim();
}

function fixture(t) {
	const base = mkdtempSync(join(tmpdir(), "housekeeping-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const origin = join(base, "origin.git");
	const checkout = join(base, "checkout");
	run("git", ["init", "--bare", "--initial-branch=main", origin]);
	run("git", ["clone", origin, checkout]);
	run("git", ["-C", checkout, "config", "user.email", "test@example.com"]);
	run("git", ["-C", checkout, "config", "user.name", "Housekeeping Test"]);
	writeFileSync(join(checkout, "seed"), "seed\n");
	run("git", ["-C", checkout, "add", "seed"]);
	run("git", ["-C", checkout, "commit", "-m", "seed"]);
	run("git", ["-C", checkout, "push", "origin", "main"]);

	const bin = join(base, "bin");
	mkdirSync(bin);
	return { base, bin, checkout };
}

function fakeDocker(bin, body) {
	const path = join(bin, "docker");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function environment(bin, extra = {}) {
	return { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra };
}

function ageWorktree(worktree) {
	const gitDir = run("git", ["-C", worktree, "rev-parse", "--git-dir"]);
	const absoluteGitDir = resolve(worktree, gitDir);
	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	utimesSync(join(absoluteGitDir, "HEAD"), old, old);
	utimesSync(join(absoluteGitDir, "index"), old, old);
}

test("keeps an old dirty worktree and removes an old clean worktree", (t) => {
	const { base, bin, checkout } = fixture(t);
	const clean = join(base, "clean");
	const dirty = join(base, "dirty");
	run("git", ["-C", checkout, "worktree", "add", "--detach", clean, "HEAD"]);
	run("git", ["-C", checkout, "worktree", "add", "--detach", dirty, "HEAD"]);
	ageWorktree(clean);
	ageWorktree(dirty);
	writeFileSync(join(dirty, "valuable-uncommitted.txt"), "keep me\n");
	fakeDocker(bin, "exit 0");

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`keep   ${dirty} \\(dirty\\)`));
	assert.match(result.stdout, new RegExp(`remove ${clean} \\(detached, idle a day\\)`));
	assert.match(run("git", ["-C", checkout, "worktree", "list", "--porcelain"]), new RegExp(dirty));
	assert.doesNotMatch(run("git", ["-C", checkout, "worktree", "list", "--porcelain"]), new RegExp(clean));
});

test("reports a failing Docker cleanup and exits nonzero", (t) => {
	const { base, bin, checkout } = fixture(t);
	const calls = join(base, "docker-calls");
	fakeDocker(
		bin,
		'if [ "$1 $2" = "image ls" ]; then\n' +
			'  case "$*" in *"uberblick-review:test-sha"*) exit 0 ;; esac\n' +
			'  printf "old-image\\n"\n' +
			'  exit 0\n' +
			'fi\n' +
			'printf "%s\\n" "$*" >> "$HOUSEKEEPING_DOCKER_CALLS"\n' +
			'exit 17',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin, { HOUSEKEEPING_DOCKER_CALLS: calls }),
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker image rm -f old-image/);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker container prune -f/);
});

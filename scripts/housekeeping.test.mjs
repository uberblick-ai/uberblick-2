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

function environment(bin) {
	return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

function ageWorktree(worktree) {
	const gitDir = run("git", ["-C", worktree, "rev-parse", "--git-dir"]);
	const absoluteGitDir = resolve(worktree, gitDir);
	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	utimesSync(join(absoluteGitDir, "HEAD"), old, old);
	utimesSync(join(absoluteGitDir, "index"), old, old);
}

test("removes only old worktrees whose work is still reachable", (t) => {
	const { base, bin, checkout } = fixture(t);
	const clean = join(base, "clean");
	const dirty = join(base, "dirty");
	const locked = join(base, "locked");
	const unmerged = join(base, "unmerged");
	run("git", ["-C", checkout, "worktree", "add", "--detach", clean, "HEAD"]);
	run("git", ["-C", checkout, "worktree", "add", "--detach", dirty, "HEAD"]);
	run("git", ["-C", checkout, "worktree", "add", "--detach", locked, "HEAD"]);
	run("git", ["-C", checkout, "worktree", "add", "--detach", unmerged, "HEAD"]);
	writeFileSync(join(unmerged, "committed-work"), "keep me too\n");
	run("git", ["-C", unmerged, "add", "committed-work"]);
	run("git", ["-C", unmerged, "commit", "-m", "unmerged work"]);
	ageWorktree(clean);
	ageWorktree(dirty);
	ageWorktree(locked);
	ageWorktree(unmerged);
	writeFileSync(join(dirty, "valuable-uncommitted.txt"), "keep me\n");
	run("git", ["-C", checkout, "worktree", "lock", locked]);
	fakeDocker(bin, "exit 0");

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`keep   ${dirty} \\(dirty\\)`));
	assert.match(result.stdout, new RegExp(`keep   ${locked} \\(locked\\)`));
	assert.match(result.stdout, new RegExp(`keep   ${unmerged} \\(unmerged commits\\)`));
	assert.match(result.stdout, new RegExp(`remove ${clean} \\(detached, idle a day\\)`));
	const worktrees = run("git", ["-C", checkout, "worktree", "list", "--porcelain"]);
	for (const kept of [dirty, locked, unmerged]) assert.match(worktrees, new RegExp(kept));
	assert.doesNotMatch(worktrees, new RegExp(clean));
});

test("keeps worktrees for live branches and remote-query failures", (t) => {
	const { base, bin, checkout } = fixture(t);
	const worktree = join(base, "remote-branch");
	run("git", ["-C", checkout, "worktree", "add", "-b", "still-open", worktree, "HEAD"]);
	writeFileSync(join(worktree, "remote-work"), "still in progress\n");
	run("git", ["-C", worktree, "add", "remote-work"]);
	run("git", ["-C", worktree, "commit", "-m", "remote work"]);
	run("git", ["-C", checkout, "push", "origin", "still-open"]);
	ageWorktree(worktree);
	fakeDocker(bin, "exit 0");
	const liveBranch = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin),
	});
	assert.equal(liveBranch.status, 0, liveBranch.stderr);
	assert.match(liveBranch.stdout, new RegExp(`keep   ${worktree} \\(still-open still open\\)`));
	assert.match(
		run("git", ["-C", checkout, "worktree", "list", "--porcelain"]),
		new RegExp(worktree),
	);

	const realGit = run("sh", ["-c", "command -v git"]);
	const fakeGit = join(bin, "git");
	writeFileSync(
		fakeGit,
		`#!/bin/sh\nif [ "$1" = "ls-remote" ]; then exit 17; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
	);
	chmodSync(fakeGit, 0o755);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin),
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /git ls-remote --heads origin/);
	assert.match(
		run("git", ["-C", checkout, "worktree", "list", "--porcelain"]),
		new RegExp(worktree),
	);
});

test("reports a failing Docker cleanup and exits nonzero", (t) => {
	const { bin, checkout } = fixture(t);
	fakeDocker(
		bin,
		'if [ "$1 $2" = "image ls" ]; then\n' +
			'  case "$*" in *"uberblick-review:test-sha"*) exit 0 ;; esac\n' +
			'  printf "old-image\\n"\n' +
			'  exit 0\n' +
			'fi\n' +
			'exit 17',
	);

	const result = spawnSync("sh", [script, "test-sha"], {
		cwd: checkout,
		encoding: "utf8",
		env: environment(bin),
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker image rm -f old-image/);
	assert.match(result.stderr, /housekeeping: failed \(17\): docker container prune -f/);
});

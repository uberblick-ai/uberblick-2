import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/cleanup-agent-worktree.py");

function fixture(t) {
	const base = realpathSync(
		mkdtempSync(
			join(tmpdir(), `agent-cleanup-${process.env.UB_AGENTS_RUN ?? "local"}-`),
		),
	);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const run = randomUUID().replaceAll("-", "");
	const operator = join(base, "operator");
	const worktree = join(operator, ".ub-agents", "worktrees", run);
	mkdirSync(worktree, { recursive: true });
	const tasks = join(base, `claude-${process.getuid()}`);
	mkdirSync(tasks);
	const slug = (path) => path.replaceAll(/[^a-zA-Z0-9]/g, "-");
	const task = join(tasks, slug(worktree));
	const sharedTask = join(tasks, slug(operator));
	const peerTask = join(
		tasks,
		slug(join(operator, ".ub-agents", "worktrees", "f".repeat(32))),
	);
	for (const path of [task, sharedTask, peerTask]) {
		mkdirSync(path);
		writeFileSync(join(path, "keep-or-delete"), "task\n");
	}
	const env = {
		...process.env,
		TMPDIR: base,
		UB_AGENTS_RUN: run,
		UB_AGENTS_WORKTREE: worktree,
	};
	return {
		base,
		env,
		operator,
		peerTask,
		run,
		sharedTask,
		task,
		tasks,
		worktree,
	};
}

function invoke(f, overrides = {}, code) {
	const result = spawnSync("python3", code ? ["-c", code, script] : [script], {
		cwd: f.operator,
		env: { ...f.env, ...overrides },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result;
}

test("configured hook removes all run scratch and only its private Claude tasks, and retries safely", (t) => {
	const f = fixture(t);
	const config = readFileSync(join(root, "ub-agents.yaml"), "utf8");
	assert.ok(
		config.includes(
			"cleanup:\n  command: [python3, scripts/cleanup-agent-worktree.py]\n  timeout-seconds: 60",
		),
	);
	const selected = [
		join(f.base, `prefix-${f.run}-suffix`),
		join(f.base, `.${f.run}-hidden`),
		join(f.base, f.run),
	];
	for (const path of selected.slice(0, 2)) {
		mkdirSync(join(path, "nested"), { recursive: true });
		writeFileSync(join(path, "nested", "file"), "scratch\n");
	}
	writeFileSync(selected[2], "scratch file\n");
	const unrelated = join(f.base, "unrelated");
	mkdirSync(unrelated);
	const nestedMatch = join(unrelated, f.run);
	writeFileSync(nestedMatch, "keep nested match\n");
	invoke(f);
	for (const path of [...selected, f.task])
		assert.equal(existsSync(path), false, path);
	for (const path of [nestedMatch, f.sharedTask, f.peerTask, f.worktree])
		assert.equal(existsSync(path), true, path);
	assert.equal(invoke(f).stderr, "");
	assert.equal(existsSync(nestedMatch), true);
});

test("removes matching links and nested links without following their targets", (t) => {
	const f = fixture(t);
	const target = join(f.base, "unrelated-target");
	mkdirSync(target);
	writeFileSync(join(target, "keep"), "untouched\n");
	const link = join(f.base, `link-${f.run}`);
	symlinkSync(target, link);
	const scratch = join(f.base, `directory-${f.run}`);
	mkdirSync(scratch);
	symlinkSync(target, join(scratch, "nested-link"));
	symlinkSync(join(f.base, "missing"), join(f.base, `broken-${f.run}`));
	rmSync(f.task, { recursive: true });
	symlinkSync(target, f.task);
	invoke(f);
	for (const path of [link, scratch, f.task, join(f.base, `broken-${f.run}`)]) {
		assert.throws(() => lstatSync(path), { code: "ENOENT" });
	}
	assert.equal(readFileSync(join(target, "keep"), "utf8"), "untouched\n");
});

test("missing, empty and malformed run ids remove nothing", (t) => {
	const f = fixture(t);
	const scratch = join(f.base, `scratch-${f.run}`);
	mkdirSync(scratch);
	for (const run of [
		undefined,
		"",
		"abc",
		"a".repeat(31),
		"a".repeat(33),
		"A".repeat(32),
		`${f.run}\n`,
		"*".repeat(32),
	]) {
		assert.equal(invoke(f, { UB_AGENTS_RUN: run }).stderr, "");
		assert.equal(existsSync(scratch), true);
		assert.equal(existsSync(f.task), true);
	}
});

test("legacy launcher inputs cannot authorize cleanup", (t) => {
	const f = fixture(t);
	const scratch = join(f.base, `scratch-${f.run}`);
	mkdirSync(scratch);
	// Construct retired names so the repository contains only current names.
	const legacyRun = ["UB", "AGENT", "RUN"].join("_");
	const legacyWorktreeVariable = ["UB", "AGENT", "WORKTREE"].join("_");
	const legacyWorktree = join(
		f.operator,
		[".ub", "agent"].join("-"),
		"worktrees",
		f.run,
	);
	mkdirSync(legacyWorktree, { recursive: true });
	const legacyTask = join(f.tasks, legacyWorktree.replaceAll(/[^a-zA-Z0-9]/g, "-"));
	mkdirSync(legacyTask);
	writeFileSync(join(legacyTask, "keep"), "legacy task\n");
	invoke(f, {
		UB_AGENTS_RUN: undefined,
		UB_AGENTS_WORKTREE: undefined,
		[legacyRun]: f.run,
		[legacyWorktreeVariable]: legacyWorktree,
	});
	for (const path of [scratch, f.task, legacyTask])
		assert.equal(existsSync(path), true, path);

	invoke(f, { UB_AGENTS_WORKTREE: legacyWorktree });
	assert.equal(existsSync(scratch), false);
	for (const path of [f.task, legacyTask, f.sharedTask, f.peerTask])
		assert.equal(existsSync(path), true, path);
});

test("task cleanup requires this operator checkout's exact private-worktree path", (t) => {
	const f = fixture(t);
	for (const path of [
		undefined,
		"",
		f.operator,
		f.peerTask,
		`${f.worktree}/`,
		`${f.worktree}/../${f.run}`,
		join(f.base, ".ub-agents", "worktrees", f.run),
	]) {
		invoke(f, { UB_AGENTS_WORKTREE: path });
		for (const task of [f.task, f.sharedTask, f.peerTask])
			assert.equal(existsSync(task), true);
	}
	// Even the exact spelling is rejected if its path redirects through a link.
	rmSync(f.worktree, { recursive: true });
	symlinkSync(f.operator, f.worktree);
	assert.match(invoke(f).stderr, /agent cleanup:/);
	assert.equal(existsSync(f.task), true);
});

test("a symlinked Claude parent cannot redirect deletion into another directory", (t) => {
	const f = fixture(t);
	const target = join(f.base, "redirected-tasks");
	rmSync(f.tasks, { recursive: true });
	mkdirSync(target);
	const redirected = join(target, f.task.split("/").at(-1));
	mkdirSync(redirected);
	symlinkSync(target, f.tasks);
	assert.match(invoke(f).stderr, /agent cleanup:/);
	assert.equal(existsSync(redirected), true);
});

test("temp entries owned by another uid are preserved", (t) => {
	const f = fixture(t);
	const scratch = join(f.base, `scratch-${f.run}`);
	mkdirSync(scratch);
	// Run as a different logical uid: the fixtures retain their real filesystem
	// ownership. This requires no privileged chown or extra user on CI.
	invoke(
		f,
		{},
		"import os, runpy, sys; uid = os.getuid(); os.getuid = lambda: uid + 1; runpy.run_path(sys.argv[1], run_name='__main__')",
	);
	assert.equal(existsSync(scratch), true);
	assert.equal(existsSync(f.task), true);
});

test("foreign descendants and a foreign Claude parent are preserved", (t) => {
	const f = fixture(t);
	const scratch = join(f.base, `scratch-${f.run}`);
	mkdirSync(scratch);
	const foreign = join(scratch, "foreign");
	const owned = join(scratch, "owned");
	writeFileSync(foreign, "foreign\n");
	writeFileSync(owned, "owned\n");
	// Inject foreign uid metadata without requiring privileged fixture setup.
	const result = invoke(
		f,
		{},
		"import os, runpy, sys\noriginal = os.stat\ndef foreign(name, *args, **kwargs):\n result = original(name, *args, **kwargs)\n if name == 'foreign' or name == f'claude-{os.getuid()}':\n  fields = list(result)\n  fields[4] += 1\n  return os.stat_result(fields)\n return result\nos.stat = foreign\nrunpy.run_path(sys.argv[1], run_name='__main__')",
	);
	assert.match(result.stderr, /agent cleanup:.*Directory not empty/);
	assert.equal(existsSync(foreign), true);
	assert.equal(existsSync(owned), false);
	assert.equal(existsSync(f.task), true);
});

test("a failed removal reports stderr, continues cleanup and still exits zero", (t) => {
	const f = fixture(t);
	const blocked = join(f.base, `blocked-${f.run}`);
	mkdirSync(blocked);
	writeFileSync(join(blocked, "file"), "keep\n");
	const result = invoke(
		f,
		{},
		"import os, runpy, sys, tempfile\ntempfile.gettempdir()\noriginal = os.unlink\ndef denied(name, *args, **kwargs):\n if name == 'file': raise PermissionError('injected removal failure')\n return original(name, *args, **kwargs)\nos.unlink = denied\nrunpy.run_path(sys.argv[1], run_name='__main__')",
	);
	assert.match(result.stderr, /agent cleanup:.*injected removal failure/);
	assert.equal(existsSync(join(blocked, "file")), true);
	assert.equal(existsSync(f.task), false);
	// A subsequent run succeeds once the removal failure recovers.
	invoke(f);
	assert.equal(existsSync(blocked), false);
});

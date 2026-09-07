import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/run-codex-role.mjs");
const skill = join(root, ".claude/skills/next-issue/SKILL.md");

function fixture(
	t,
	{ claim = "found", claimUpdatedAt, codexExit = "0", deadlineSeconds, role = "implementer" } = {},
) {
	const base = mkdtempSync(join(tmpdir(), "codex-role-runner-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	const scratch = join(base, "scratch");
	const worktree = join(base, "worktree");
	mkdirSync(bin);
	mkdirSync(scratch);
	mkdirSync(worktree);
	const runId = `codex-${role}-20260902T191751Z-test`;
	writeFileSync(join(scratch, `${runId}.prompt`), "bounded assignment\n");

	writeFileSync(
		join(bin, "codex"),
		`#!/bin/sh
if [ "$1" = "--version" ]; then
	printf '%s\n' 'codex-test 1.0'
	exit 0
fi
printf '%s\n' "$*" > "$CODEX_TEST_ARGS"
printf '%s\n' "codex output" >&2
if [ -n "\${CODEX_TEST_PGID:-}" ]; then
	ps -o pgid= -p $$ | tr -d ' ' > "$CODEX_TEST_PGID"
	if [ "\${CODEX_TEST_IGNORE_SIGNALS:-}" = 1 ]; then
		trap '' INT TERM HUP QUIT
	fi
	if [ "\${CODEX_TEST_EXIT_AFTER_PGID:-}" = 1 ]; then
		exit "\${CODEX_TEST_EXIT:-0}"
	fi
	while :; do sleep 1; done
fi
exit "\${CODEX_TEST_EXIT:-0}"
`,
	);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh
printf '%s\n' "$*" >> "$CODEX_TEST_GIT"
last=
for arg in "$@"; do last=$arg; done
rm -rf "$last"
`,
	);
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh
case "$1 $2" in
	"repo view") printf '%s\n' 'uberblick-ai/uberblick-2' ;;
	"api --paginate")
		case "$CODEX_TEST_CLAIM" in
			found)
				if [ -n "\${CODEX_TEST_CLAIM_UPDATED_AT:-}" ]; then
					since=\${3#*since=}
					since=\${since%%&*}
					node -e 'process.exit(Date.parse(process.argv[1]) >= Date.parse(process.argv[2]) ? 0 : 1)' "$CODEX_TEST_CLAIM_UPDATED_AT" "$since" || exit 0
				fi
				printf '%s\n' "$CODEX_TEST_CLAIM_LINE"
				;;
			not-found) ;;
			unknown) exit 23 ;;
		esac
		;;
	*) exit 2 ;;
esac
`,
	);
	for (const command of ["codex", "git", "gh"]) chmodSync(join(bin, command), 0o755);

	return {
		base,
		bin,
		runId,
		scratch,
		worktree,
		env: {
			...process.env,
			CODEX_TEST_ARGS: join(base, "codex-args"),
			CODEX_TEST_CLAIM: claim,
			...(claimUpdatedAt === undefined
				? {}
				: { CODEX_TEST_CLAIM_UPDATED_AT: claimUpdatedAt }),
			CODEX_TEST_CLAIM_LINE: role === "implementer"
				? `Implementer: codex ${runId}`
				: `Claim: ${role} ${runId}`,
			CODEX_TEST_EXIT: codexExit,
			CODEX_TEST_GIT: join(base, "git-calls"),
			CODEX_TEST_RUN_ID: runId,
			...(deadlineSeconds === undefined
				? {}
				: { CODEX_RUNNER_DEADLINE_SECONDS: String(deadlineSeconds) }),
			PATH: `${bin}:${process.env.PATH}`,
		},
	};
}

async function waitForPgid(path) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const value = readFileSync(path, "utf8").trim();
			if (/^[1-9][0-9]*$/.test(value)) return Number(value);
		}
		await delay(20);
	}
	assert.fail("Codex double never published its process group");
}

function groupExists(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForGroupGone(pgid) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (!groupExists(pgid)) return;
		await delay(20);
	}
	assert.fail(`process group ${pgid} remained alive`);
}

function capture(child) {
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	return new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout })),
	);
}

test("reports a real nonzero exit and removes the normal run worktree", (t) => {
	const current = fixture(t, { codexExit: "23" });
	const pgidFile = join(current.base, "run-pgid");
	const result = spawnSync(
		process.execPath,
		[script, "implementer", current.runId, current.worktree, current.scratch],
		{
			encoding: "utf8",
			env: {
				...current.env,
				CODEX_TEST_EXIT_AFTER_PGID: "1",
				CODEX_TEST_PGID: pgidFile,
			},
		},
	);

	assert.equal(result.status, 23, result.stderr);
	assert.match(result.stdout, /ended normally after \d+s with exit code 23/);
	assert.equal(readFileSync(join(current.scratch, `${current.runId}.status`), "utf8"), "23\n");
	assert.equal(existsSync(current.worktree), false);
	assert.match(readFileSync(current.env.CODEX_TEST_GIT, "utf8"), /worktree remove/);
	assert.match(
		readFileSync(current.env.CODEX_TEST_ARGS, "utf8"),
		/--dangerously-bypass-approvals-and-sandbox/,
	);
	assert.equal(existsSync(join(current.scratch, `${current.runId}.log`)), true);
	assert.equal(groupExists(Number(readFileSync(pgidFile, "utf8").trim())), false);
});

test("runs an implementation reviewer sandboxed, owning its worktree like any entry role", (t) => {
	const current = fixture(t, { role: "implementation-reviewer" });
	const result = spawnSync(
		process.execPath,
		[script, "implementation-reviewer", current.runId, current.worktree, current.scratch],
		{ encoding: "utf8", env: current.env },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(current.worktree), false);
	assert.match(readFileSync(current.env.CODEX_TEST_GIT, "utf8"), /worktree remove/);
	assert.doesNotMatch(readFileSync(current.env.CODEX_TEST_ARGS, "utf8"), /dangerously-bypass/);
	assert.match(readFileSync(current.env.CODEX_TEST_ARGS, "utf8"), /-s workspace-write/);
});

test("a vanished run group reports found and not-found claim states before cleanup", async (t) => {
	for (const [claim, report] of [
		["found", "found"],
		["not-found", "not found"],
	]) {
		const current = fixture(t, { claim });
		const pgidFile = join(current.base, "run-pgid");
		const child = spawn(
			process.execPath,
			[script, "implementer", current.runId, current.worktree, current.scratch],
			{
				env: { ...current.env, CODEX_TEST_PGID: pgidFile },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

		process.kill(-(await waitForPgid(pgidFile)), "SIGKILL");
		const [status] = await new Promise((resolve) =>
			child.once("close", (...args) => resolve(args)),
		);

		assert.equal(status, 1, stderr);
		assert.equal((stdout.match(/Lost Codex run/g) ?? []).length, 1);
		assert.match(stdout, new RegExp(`Lost Codex run ${current.runId} \\(implementer\\)`));
		assert.match(stdout, new RegExp(`after \\d+s; durable claim: ${report}\\.`));
		assert.equal(existsSync(join(current.scratch, `${current.runId}.status`)), false);
		assert.equal(existsSync(join(current.scratch, `${current.runId}.log`)), true);
		assert.equal(existsSync(current.worktree), true);
		assert.equal(existsSync(current.env.CODEX_TEST_GIT), false);
	}
});

test("termination signals reap even a run group that ignores them", async (t) => {
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
		const current = fixture(t);
		const pgidFile = join(current.base, "run-pgid");
		const child = spawn(
			process.execPath,
			[script, "implementer", current.runId, current.worktree, current.scratch],
			{
				env: {
					...current.env,
					CODEX_TEST_IGNORE_SIGNALS: "1",
					CODEX_TEST_PGID: pgidFile,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const completed = capture(child);
		const pgid = await waitForPgid(pgidFile);
		t.after(() => {
			if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
		});

		child.kill(signal);
		const result = await completed;

		assert.equal(result.code, 1, result.stderr);
		assert.equal(result.signal, null);
		assert.match(result.stdout, /Lost Codex run/);
		assert.doesNotMatch(result.stdout, /ended normally|reached its deadline/);
		assert.equal(existsSync(join(current.scratch, `${current.runId}.status`)), false);
		assert.equal(existsSync(join(current.scratch, `${current.runId}.log`)), true);
		assert.equal(groupExists(pgid), false, `${signal} left process group ${pgid} alive`);
	}
});

test("the detached group enforces its deadline after the supervisor is killed", async (t) => {
	const current = fixture(t, { deadlineSeconds: 1 });
	const pgidFile = join(current.base, "run-pgid");
	const child = spawn(
		process.execPath,
		[script, "implementer", current.runId, current.worktree, current.scratch],
		{
			env: {
				...current.env,
				CODEX_TEST_IGNORE_SIGNALS: "1",
				CODEX_TEST_PGID: pgidFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const pgid = await waitForPgid(pgidFile);
	t.after(() => {
		if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
	});

	child.kill("SIGKILL");
	const [code, signal] = await new Promise((resolve) =>
		child.once("close", (...args) => resolve(args)),
	);
	assert.equal(code, null);
	assert.equal(signal, "SIGKILL");
	await waitForGroupGone(pgid);
	assert.equal(existsSync(join(current.scratch, `${current.runId}.status`)), false);
	assert.equal(existsSync(join(current.scratch, `${current.runId}.log`)), true);
});

test("a failed deadline marker does not disable detached group enforcement", async (t) => {
	const current = fixture(t, { deadlineSeconds: 1 });
	const pgidFile = join(current.base, "run-pgid");
	const child = spawn(
		process.execPath,
		[script, "implementer", current.runId, current.worktree, current.scratch],
		{
			env: {
				...current.env,
				CODEX_TEST_IGNORE_SIGNALS: "1",
				CODEX_TEST_PGID: pgidFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const pgid = await waitForPgid(pgidFile);
	chmodSync(current.scratch, 0o500);
	try {
		child.kill("SIGKILL");
		const [code, signal] = await new Promise((resolve) =>
			child.once("close", (...args) => resolve(args)),
		);
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		await waitForGroupGone(pgid);
		assert.equal(existsSync(join(current.scratch, `${current.runId}.deadline`)), false);
	} finally {
		chmodSync(current.scratch, 0o700);
		if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
	}
});

test("a live supervisor reports deadline expiry distinctly and preserves recovery state", async (t) => {
	const current = fixture(t, { deadlineSeconds: 1 });
	const pgidFile = join(current.base, "run-pgid");
	const child = spawn(
		process.execPath,
		[script, "implementer", current.runId, current.worktree, current.scratch],
		{
			env: {
				...current.env,
				CODEX_TEST_IGNORE_SIGNALS: "1",
				CODEX_TEST_PGID: pgidFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const completed = capture(child);
	const pgid = await waitForPgid(pgidFile);
	t.after(() => {
		if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
	});

	const result = await completed;

	assert.equal(result.code, 1, result.stderr);
	assert.equal(result.signal, null);
	assert.match(result.stdout, /reached its deadline/);
	assert.doesNotMatch(result.stdout, /Lost Codex run|ended normally/);
	assert.match(result.stdout, /durable claim: found/);
	assert.match(result.stdout, /Worktree preserved and registered/);
	assert.equal(existsSync(join(current.scratch, `${current.runId}.status`)), false);
	assert.equal(existsSync(join(current.scratch, `${current.runId}.log`)), true);
	assert.equal(groupExists(pgid), false);
});

test("a reviewer's own claim is found when its run is lost, and its worktree is kept", async (t) => {
	const current = fixture(t, {
		claimUpdatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
		role: "implementation-reviewer",
	});
	const pgidFile = join(current.base, "run-pgid");
	const child = spawn(
		process.execPath,
		[script, "implementation-reviewer", current.runId, current.worktree, current.scratch],
		{
			env: { ...current.env, CODEX_TEST_PGID: pgidFile },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const completed = capture(child);

	process.kill(-(await waitForPgid(pgidFile)), "SIGKILL");
	const result = await completed;

	assert.equal(result.code, 1, result.stderr);
	assert.match(result.stdout, /durable claim: found/);
	assert.match(result.stdout, /Worktree preserved and registered/);
	assert.equal(existsSync(current.worktree), true);
});

test("an indeterminate claim lookup keeps the lost run worktree registered", async (t) => {
	const current = fixture(t, { claim: "unknown" });
	const pgidFile = join(current.base, "run-pgid");
	const result = spawn(
		process.execPath,
		[script, "issue-preparer", current.runId, current.worktree, current.scratch],
		{
			env: { ...current.env, CODEX_TEST_PGID: pgidFile },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	result.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));

	process.kill(-(await waitForPgid(pgidFile)), "SIGKILL");
	const [status] = await new Promise((resolve) => result.once("close", (...args) => resolve(args)));

	assert.equal(status, 1);
	assert.match(stdout, /durable claim: could not be determined\./);
	assert.match(stdout, /Worktree preserved and registered/);
	assert.equal(existsSync(current.worktree), true);
	assert.equal(existsSync(current.env.CODEX_TEST_GIT), false);
	assert.doesNotMatch(readFileSync(current.env.CODEX_TEST_ARGS, "utf8"), /dangerously-bypass/);
	assert.match(readFileSync(current.env.CODEX_TEST_ARGS, "utf8"), /-s workspace-write/);
});

test("the interactive launcher never exposes the runner as an entry surface", () => {
	const text = readFileSync(skill, "utf8");
	assert.doesNotMatch(text, /run-codex-role/);
	assert.match(text, /`ub launch <role> \[--model claude\|codex\]`/);
});

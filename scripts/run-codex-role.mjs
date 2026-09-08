#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const usage = "usage: run-codex-role.mjs <role> <run-id> <worktree> <scratch>";
const roles = new Set(["issue-preparer", "implementer", "integrator", "implementation-reviewer"]);
const [role, runId, worktree, scratch] = process.argv.slice(2);

function failUsage() {
	process.stderr.write(`${usage}\n`);
	process.exit(2);
}

if (
	process.argv.length !== 6 ||
	!roles.has(role) ||
	!runId ||
	!/^[A-Za-z0-9_-]+$/.test(runId)
)
	failUsage();

const prompt = join(scratch, `${runId}.prompt`);
const log = join(scratch, `${runId}.log`);
const last = join(scratch, `${runId}.last`);
const statusFile = join(scratch, `${runId}.status`);
const deadlineFile = join(scratch, `${runId}.deadline`);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const RUN_DEADLINE_SECONDS = 3 * 60 * 60;
const GROUP_TERMINATION_GRACE_SECONDS = 1;
// Outlast the watchdog's group-termination grace before giving up the liveness poll.
const GROUP_REAP_WAIT_MS = GROUP_TERMINATION_GRACE_SECONDS * 1000 + 800;
const CLAIM_LOOKBACK_MS = 30 * 60 * 1000;

function configuredDeadline() {
	const value = process.env.CODEX_RUNNER_DEADLINE_SECONDS;
	if (value === undefined) return RUN_DEADLINE_SECONDS;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		process.stderr.write("CODEX_RUNNER_DEADLINE_SECONDS must be a positive integer.\n");
		process.exit(2);
	}
	return parsed;
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

if (!isDirectory(worktree) || !isDirectory(scratch) || !existsSync(prompt)) {
	process.stderr.write(
		`Codex run ${runId} was not started: worktree, scratch directory, or prompt is missing.\n`,
	);
	process.exit(2);
}

const codexCheck = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (codexCheck.error?.code === "ENOENT") {
	process.stderr.write(`Codex run ${runId} was not started: codex is not installed.\n`);
	process.exit(2);
}

rmSync(statusFile, { force: true });
rmSync(last, { force: true });
rmSync(deadlineFile, { force: true });
const startedAt = new Date();
const runDeadlineSeconds = configuredDeadline();

const codexArgs = ["exec", "-C", worktree];
if (role === "implementer") {
	codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
} else {
	codexArgs.push(
		"-s",
		"workspace-write",
		"-c",
		"sandbox_workspace_write.network_access=true",
	);
}
codexArgs.push("-o", last, "-");

// The shell, Codex and watchdog share one detached process group, while this
// Node process remains its supervisor. The shell writes the sentinel only
// after Codex returns and the watchdog is gone, so termination cannot
// masquerade as a normal exit or leave deadline machinery behind.
const command = `
status_file=$1
prompt=$2
log=$3
deadline_file=$4
deadline_seconds=$5
grace_seconds=$6
shift 6

# Ignored dispositions survive the fork and exec of sleep. Install them in
# the parent first so the watchdog is protected from the moment it exists,
# then restore the run shell before starting Codex.
trap '' INT TERM HUP QUIT
(
	sleeper=
	stop_watchdog() {
		[ -z "$sleeper" ] || kill -KILL "$sleeper" 2>/dev/null || :
		[ -z "$sleeper" ] || wait "$sleeper" 2>/dev/null || :
		exit 0
	}
	trap stop_watchdog USR1
	sleep "$deadline_seconds" &
	sleeper=$!
	wait "$sleeper" || exit $?
	trap - USR1
	# Reporting is best-effort; a failed marker must not disable deadline enforcement.
	(umask 077 && printf 'expired\\n' > "$deadline_file") || :
	kill -TERM "-$$" 2>/dev/null || :
	sleep "$grace_seconds"
	kill -KILL "-$$" 2>/dev/null || :
) &
watchdog=$!
trap - INT TERM HUP QUIT
"$@" < "$prompt" > "$log" 2>&1
status=$?
kill -USR1 "$watchdog" 2>/dev/null || :
wait "$watchdog" 2>/dev/null || :
(umask 077 && printf "%s\\n" "$status" > "$status_file") || exit 126
exit "$status"
`;
const run = spawn(
	"/bin/sh",
	[
		"-c",
		command,
		"run-codex-role",
		statusFile,
		prompt,
		log,
		deadlineFile,
		String(runDeadlineSeconds),
		String(GROUP_TERMINATION_GRACE_SECONDS),
		"codex",
		...codexArgs,
	],
	{
		cwd: root,
		detached: true,
		stdio: "ignore",
	},
);

function signalGroup(signal) {
	if (run.pid === undefined) return false;
	try {
		process.kill(-run.pid, signal);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
		throw error;
	}
}

function groupExists() {
	return signalGroup(0);
}

async function waitForGroupExit() {
	const limit = Date.now() + GROUP_REAP_WAIT_MS;
	while (groupExists() && Date.now() < limit) await delay(20);
}

let stopPromise;
const signalHandlers = new Map();
for (const signal of FORWARDED) {
	const handler = () => {
		if (stopPromise !== undefined) return;
		stopPromise = (async () => {
			signalGroup(signal);
			await delay(GROUP_TERMINATION_GRACE_SECONDS * 1000);
			signalGroup("SIGKILL");
			await waitForGroupExit();
		})();
	};
	signalHandlers.set(signal, handler);
	process.on(signal, handler);
}

const completion = await new Promise((resolve) => {
	run.once("error", (error) => resolve({ error }));
	run.once("close", (code, signal) => resolve({ code, signal }));
});
if (stopPromise !== undefined) await stopPromise;
for (const [signal, handler] of signalHandlers) process.off(signal, handler);
if (existsSync(deadlineFile)) await waitForGroupExit();
const duration = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));

function removeWorktree() {
	const removed = spawnSync("git", ["-C", root, "worktree", "remove", "--force", worktree], {
		encoding: "utf8",
	});
	if (removed.status === 0) return true;
	process.stderr.write(`Codex run ${runId}: worktree cleanup failed; preserved at ${worktree}.\n`);
	return false;
}

let unreadableSentinel = false;
if (stopPromise === undefined && !existsSync(deadlineFile) && existsSync(statusFile)) {
	const statusText = readFileSync(statusFile, "utf8").trim();
	if (!/^(?:0|[1-9][0-9]{0,2})$/.test(statusText) || Number(statusText) > 255) {
		unreadableSentinel = true;
	} else {
		const status = Number(statusText);
		removeWorktree();
		process.stdout.write(
			`Codex run ${runId} (${role}) ended normally after ${duration}s with exit code ${status}.\n`,
		);
		process.exit(status);
	}
}

function claimState() {
	const repoResult = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (repoResult.status !== 0) return "could not be determined";
	const repo = repoResult.stdout.trim();
	if (!repo) return "could not be determined";

	const since = new Date(startedAt.getTime() - CLAIM_LOOKBACK_MS).toISOString();
	const commentsResult = spawnSync(
		"gh",
		[
			"api",
			"--paginate",
			`repos/${repo}/issues/comments?since=${since}&per_page=100`,
			"--jq",
			".[].body",
		],
		{ cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	if (commentsResult.status !== 0) return "could not be determined";

	// These exact durable lines are owned by `.agents/roles/README.md` and
	// `.github/ISSUE_SPEC.md`; keep this lookup aligned if their grammar moves.
	const claimLine = role === "implementer"
		? `Implementer: codex ${runId}`
		: `Claim: ${role} ${runId}`;
	return commentsResult.stdout.split(/\r?\n/).includes(claimLine) ? "found" : "not found";
}

const state = claimState();
if (existsSync(deadlineFile)) {
	await new Promise((resolve) =>
		process.stdout.write(
			`Codex run ${runId} (${role}) reached its deadline after ${duration}s; durable claim: ${state}.\n` +
				`Log preserved at ${log}.\n`,
			resolve,
		),
	);
	process.stdout.write(
		`Worktree preserved and registered at ${worktree} because the run reached its deadline.\n`,
	);
	process.exit(1);
}
const sentinelDetail = unreadableSentinel ? "completion sentinel unreadable; " : "";
await new Promise((resolve) =>
	process.stdout.write(
		`Lost Codex run ${runId} (${role}) after ${duration}s; ${sentinelDetail}durable claim: ${state}.\n` +
			`Log preserved at ${log}.\n`,
		resolve,
	),
);
process.stdout.write(
	`Worktree preserved and registered at ${worktree} because the run was lost.\n`,
);

if (completion.error) {
	process.stderr.write(`Codex run ${runId}: supervisor observed ${completion.error.message}.\n`);
}
process.exit(1);

#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "usage: run-codex-role.mjs <role> <run-id> <worktree> <scratch>";
const roles = new Set(["issue-preparer", "implementer", "integrator", "program-coordinator"]);
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
const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
const startedAt = new Date();

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

// The shell and Codex share a detached process group, while this Node process
// remains its supervisor. The shell writes the sentinel only after Codex
// returns, so a kill of the whole run group cannot masquerade as an exit code.
const command = `
status_file=$1
prompt=$2
log=$3
shift 3
"$@" < "$prompt" > "$log" 2>&1
status=$?
(umask 077 && printf "%s\\n" "$status" > "$status_file") || exit 126
exit "$status"
`;
const run = spawn(
	"/bin/sh",
	["-c", command, "run-codex-role", statusFile, prompt, log, "codex", ...codexArgs],
	{
		cwd: root,
		detached: true,
		stdio: "ignore",
	},
);

const completion = await new Promise((resolve) => {
	run.once("error", (error) => resolve({ error }));
	run.once("close", (code, signal) => resolve({ code, signal }));
});
const duration = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));

function removeWorktree() {
	const removed = spawnSync("git", ["-C", root, "worktree", "remove", "--force", worktree], {
		encoding: "utf8",
	});
	if (removed.status === 0) return true;
	process.stderr.write(`Codex run ${runId}: worktree cleanup failed; preserved at ${worktree}.\n`);
	return false;
}

if (existsSync(statusFile)) {
	const statusText = readFileSync(statusFile, "utf8").trim();
	if (!/^(?:0|[1-9][0-9]{0,2})$/.test(statusText) || Number(statusText) > 255) {
		process.stdout.write(
			`Lost Codex run ${runId} (${role}) after ${duration}s; completion sentinel was unreadable.\n` +
				`Artifacts preserved: worktree ${worktree}; log ${log}.\n`,
		);
		process.exit(1);
	}
	const status = Number(statusText);
	removeWorktree();
	process.stdout.write(
		`Codex run ${runId} (${role}) ended normally after ${duration}s with exit code ${status}.\n`,
	);
	process.exit(status);
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

	const commentsResult = spawnSync(
		"gh",
		[
			"api",
			"--paginate",
			`repos/${repo}/issues/comments?since=${startedAt.toISOString()}&per_page=100`,
			"--jq",
			".[].body",
		],
		{ cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	if (commentsResult.status !== 0) return "could not be determined";

	const claimLine =
		role === "implementer" ? `Implementer: codex ${runId}` : `Claim: ${role} ${runId}`;
	return commentsResult.stdout.split(/\r?\n/).includes(claimLine) ? "found" : "not found";
}

const state = claimState();
await new Promise((resolve) =>
	process.stdout.write(
		`Lost Codex run ${runId} (${role}) after ${duration}s; durable claim: ${state}.\n` +
			`Log preserved at ${log}.\n`,
		resolve,
	),
);
if (state === "could not be determined") {
	process.stdout.write(
		`Worktree preserved and registered at ${worktree} because claim state is unknown.\n`,
	);
} else {
	// The loss is now reported and its claim state is known. The log remains as
	// evidence while the ordinary per-run worktree cleanup may proceed.
	removeWorktree();
}

if (completion.error) {
	process.stderr.write(`Codex run ${runId}: supervisor observed ${completion.error.message}.\n`);
}
process.exit(1);

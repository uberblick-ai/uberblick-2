import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helpers = join(root, ".agents/skills/release/scripts");
const summary = "browser chromium (1/3)\tRun tests\t2026-11-05T00:00:00Z   12 passed (1m)\n";
const failure = "browser chromium (1/3)\tRun tests\t2026-11-05T00:00:00Z   1) [chromium] › example.spec.ts:1:1 › example\n";

const fakeGh = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.RELEASE_HELPERS_CONFIG, "utf8"));
fs.appendFileSync(process.env.RELEASE_HELPERS_CALLS, JSON.stringify(args) + "\n");
if (args[0] === "run" && args[1] === "view" && args.includes("--log")) {
  const calls = fs.readFileSync(process.env.RELEASE_HELPERS_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  const count = calls.filter((call) => call[0] === "run").length;
  const response = config.downloads[Math.min(count - 1, config.downloads.length - 1)];
  process.stdout.write(response.stdout ?? "");
  process.stderr.write(response.stderr ?? "");
  process.exit(response.status ?? 0);
}
if (args[0] === "api" && args[1].endsWith("/pulls")) {
  if (args[args.indexOf("--jq") + 1] === "length") {
    if (config.directFailure) {
      process.stderr.write("HTTP 503: direct-commit lookup unavailable\n");
      process.exit(1);
    }
    process.stdout.write(String(config.associationCount ?? 0) + "\n");
  }
  process.exit(0);
}
process.stderr.write("Unexpected gh arguments: " + JSON.stringify(args) + "\n");
process.exit(1);
`;

function fixture(t, config = {}) {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `release-helpers-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const bin = join(scratch, "bin");
	const configPath = join(scratch, "config.json");
	const callsPath = join(scratch, "calls.jsonl");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${fakeGh}`, { mode: 0o755 });
	writeFileSync(callsPath, "");
	return {
		scratch,
		calls: () => readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
		run(script, args, cwd = scratch) {
			writeFileSync(configPath, JSON.stringify(config));
			return spawnSync("/bin/bash", [join(helpers, script), ...args], {
				cwd, encoding: "utf8", timeout: 10_000,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_HELPERS_CONFIG: configPath, RELEASE_HELPERS_CALLS: callsPath },
			});
		},
	};
}

function completed(result) {
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
}

function passed(result) {
	completed(result);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function failed(result) {
	completed(result);
	assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.doesNotMatch(result.stdout, /failure lines \(empty means none\)/);
}

function commitRange(scratch) {
	const repo = join(scratch, "history.git");
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Release fixture", GIT_AUTHOR_EMAIL: "release@example.invalid",
		GIT_COMMITTER_NAME: "Release fixture", GIT_COMMITTER_EMAIL: "release@example.invalid",
	};
	const git = (args, input) => {
		const result = spawnSync("git", args, { cwd: scratch, env, input, encoding: "utf8", timeout: 10_000 });
		passed(result);
		return result.stdout.trim();
	};
	git(["init", "--quiet", "--bare", repo]);
	const tree = git(["-C", repo, "hash-object", "-t", "tree", "-w", "--stdin"], "");
	const previous = git(["-C", repo, "commit-tree", tree, "-m", "previous release"]);
	const candidate = git(["-C", repo, "commit-tree", tree, "-p", previous, "-m", "record release"]);
	return { repo, previous, candidate };
}

test("failed log downloads cannot poison a retry, and successful evidence is reusable", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { downloads: [
		{ stdout: summary, stderr: "HTTP 503: log unavailable\n", status: 1 },
		{ stdout: summary + failure },
	] });
	const cache = join(f.scratch, "run.log");
	const first = f.run("e2e-counts.sh", ["123", cache]);
	failed(first);
	assert.match(first.stderr, /HTTP 503/);
	assert.ok(!existsSync(cache) || readFileSync(cache, "utf8") === "", "a failed partial download must not become reusable evidence");
	const second = f.run("e2e-counts.sh", ["123", cache]);
	passed(second);
	assert.match(second.stdout, /browser chromium \(1\/3\): 12 passed \(1m\)/);
	assert.match(second.stdout, /browser chromium \(1\/3\): 1\) \[chromium\].*example/);
	assert.equal(f.calls().length, 2, "retry must download again");
	assert.equal(readFileSync(cache, "utf8"), summary + failure);
	const third = f.run("e2e-counts.sh", ["123", cache]);
	passed(third);
	assert.equal(third.stdout, second.stdout);
	assert.equal(f.calls().length, 2, "valid cached evidence avoids another download");
});

test("an unusable cached log cannot report successful no-failure evidence", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	const cache = join(f.scratch, "run.log");
	writeFileSync(cache, "HTTP 503: an earlier download failed\n");
	failed(f.run("e2e-counts.sh", ["123", cache]));
	assert.equal(f.calls().length, 0);
});

test("a successful download without browser summaries is rejected", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { downloads: [{ stdout: "lint\tRun tests\t2026-11-05T00:00:00Z   12 passed\n" }] });
	failed(f.run("e2e-counts.sh", ["123", join(f.scratch, "run.log")]));
	assert.equal(f.calls().length, 1);
});

test("failed direct-commit association reads fail the inventory", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { directFailure: true });
	const { repo, previous, candidate } = commitRange(f.scratch);
	const result = f.run("landed-prs.sh", [previous, candidate], repo);
	failed(result);
	assert.match(result.stderr, /HTTP 503/);
	assert.equal(f.calls().length, 2, "the PR-list read succeeds before the direct-commit lookup fails");
	assert.doesNotMatch(result.stdout, /record release/);
});

test("successful empty associations list direct commits and associated commits are omitted", { timeout: 60_000 }, (t) => {
	const config = { associationCount: 0 };
	const f = fixture(t, config);
	const { repo, previous, candidate } = commitRange(f.scratch);
	const direct = f.run("landed-prs.sh", [previous, candidate], repo);
	passed(direct);
	assert.match(direct.stdout, new RegExp(`${candidate.slice(0, 7)}[a-f0-9]* record release`));
	config.associationCount = 1;
	const associated = f.run("landed-prs.sh", [previous, candidate], repo);
	passed(associated);
	assert.doesNotMatch(associated.stdout, /record release/);
});

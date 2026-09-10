/**
 * `scripts/probe-work.sh` — the over-inclusive "could this role have work?" read.
 *
 * Two contracts the launch loop depends on, and neither is visible from the
 * TypeScript side: the three exit codes (0 launch, 1 idle, 2 could not tell),
 * and the count line a person reads in the terminal — which says
 * `1 candidate`, never `1 candidate(s)`.
 *
 * `gh` is faked, because the real one answers differently every hour and needs
 * credentials no test may hold.
 */

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/probe-work.sh");

/**
 * Run the probe with a `gh` that answers `answer`, and records every argument
 * list it was called with in `calls`. A number is the count a `--jq length`
 * read returns, an array is the lines a projecting read returns, and null is a
 * `gh` that fails.
 */
function probe(t, role, answer, prAnswer = answer) {
	const base = mkdtempSync(join(tmpdir(), "probe-work-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	const calls = join(base, "gh-calls");
	const answers = join(base, "gh-answers");
	mkdirSync(bin);
	const gh = join(bin, "gh");
	const record = 'printf \'%s\\n\' "$*" >> "$PROBE_TEST_CALLS"';
	let reply;
	if (answer === null) reply = "exit 1";
	else if (Array.isArray(answer)) {
		writeFileSync(answers, answer.map((line) => `${line}\n`).join(""));
		reply = `cat ${answers}`;
	} else if (role === "implementer") {
		reply = `case "$1 $2" in
  "issue list") echo ${answer} ;;
  "pr list") ${prAnswer === null ? "exit 1" : `echo ${prAnswer}`} ;;
  *) exit 1 ;;
esac`;
	} else reply = `echo ${answer}`;
	writeFileSync(gh, `#!/bin/sh\n${record}\n${reply}\n`);
	chmodSync(gh, 0o755);
	const run = spawnSync("sh", [script, role], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			PROBE_TEST_CALLS: calls,
		},
	});
	return { ...run, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test("counts read naturally in both numbers", (t) => {
	const one = probe(t, "integrator", 1);
	assert.equal(one.status, 0);
	assert.equal(one.stdout.trim(), "probe-work: integrator: 1 candidate");

	const many = probe(t, "integrator", 27);
	assert.equal(many.status, 0);
	assert.equal(many.stdout.trim(), "probe-work: integrator: 27 candidates");
});

test("an empty queue idles and an unreadable GitHub never launches", (t) => {
	const none = probe(t, "integrator", 0);
	assert.equal(none.status, 1);
	assert.equal(none.stdout.trim(), "probe-work: integrator: 0 candidates");

	const broken = probe(t, "integrator", null);
	assert.equal(broken.status, 2);
	assert.equal(broken.stdout.trim(), "");
});

test("the reviewer counts the PRs that carry a request, not the open ones", (t) => {
	// The read projects one `<pr> <first line>` line per PR comment, so a PR
	// with a busy thread and no request must not make the loop pay for a session.
	const busy = probe(t, "implementation-reviewer", [
		"963 Delegated: implementation-reviewer codex-implementation-reviewer-1",
		"963 Done: implementer claude claude-implementer-1",
		"964 Claim: integrator claude-integrator-1",
	]);
	assert.equal(busy.status, 1);
	assert.equal(busy.stdout.trim(), "probe-work: implementation-reviewer: 0 candidates");

	// Two PRs carry a request; the one with two requests still counts once.
	const requested = probe(t, "implementation-reviewer", [
		"959 Review-request: implementation-reviewer",
		"959 Review-request: implementation-reviewer",
		"963 Done: implementer claude claude-implementer-1",
		"964 Review-request: implementation-reviewer",
	]);
	assert.equal(requested.status, 0);
	assert.equal(requested.stdout.trim(), "probe-work: implementation-reviewer: 2 candidates");

	// GitHub's comment-search index lags durable state, and the request a
	// reviewer loop must not miss is the one an implementer just posted.
	assert.match(requested.calls, /^pr list .*--json number,comments/m);
	assert.doesNotMatch(requested.calls, /search|--match comments/);
});

test("an unknown role is a usage error, not an idle", (t) => {
	const unknown = probe(t, "reviewer", 3);
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /usage: probe-work\.sh/);
});

test("a new PR fix-up remains visible without indexed search or ready issues", (t) => {
	const fixup = probe(t, "implementer", 0, 1);
	assert.equal(fixup.status, 0);
	assert.equal(fixup.stdout.trim(), "probe-work: implementer: 1 candidate");
	assert.match(fixup.calls, /^pr list /m);
	assert.doesNotMatch(fixup.calls, /search|--match comments/);
	assert.equal(probe(t, "implementer", 0, 0).status, 1);
	assert.equal(probe(t, "implementer", 0, null).status, 2);
});

test("the implementer PR read carries the exact draft exclusion", (t) => {
	// The fake does not evaluate gh's --jq program. This protects the command
	// contract that keeps the one exact exclusion available to gh's evaluator.
	const filtered = probe(t, "implementer", 0, 0);
	const prCall = filtered.calls.split("\n").find((call) => call.startsWith("pr list "));
	assert.ok(prCall);
	assert.match(prCall, /--json isDraft(?![,\w])/);
	assert.match(prCall, /isDraft \| not/);
	assert.doesNotMatch(prCall, /labels|needs-human/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/post-retrospective.sh");

// The fake gh answers the discussion query with whatever URL the test names
// and records every mutation it is asked to run.
function fixture(t, resolvedUrl) {
	const base = mkdtempSync(join(tmpdir(), "post-retrospective-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	mkdirSync(bin);
	const calls = join(base, "gh-calls");
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$*" in
  *mutation*) echo "https://example.invalid/comment/1" ;;
  *) echo "D_resolved ${resolvedUrl}" ;;
esac
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const body = join(base, "body.md");
	writeFileSync(body, "Retrospective: test\n");
	return { body, calls, env: { ...process.env, GH_CALLS: calls, PATH: `${bin}:${process.env.PATH}` } };
}

function run(args, env) {
	return spawnSync("sh", [script, ...args], { encoding: "utf8", env });
}

function mutations(calls) {
	let recorded = "";
	try {
		recorded = readFileSync(calls, "utf8");
	} catch {}
	return recorded.split("\n").filter((line) => line.includes("mutation"));
}

test("posts to the resolved discussion when its URL is the expected one", (t) => {
	const { body, calls, env } = fixture(t, "https://github.com/uberblick-ai/uberblick-2/discussions/522");
	const result = run(["implementation", body], env);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "https://example.invalid/comment/1");
	const posted = mutations(calls);
	assert.equal(posted.length, 1);
	assert.match(posted[0], /discussionId=D_resolved/);
});

test("refuses to post when the resolved discussion is not the expected one", (t) => {
	const { body, calls, env } = fixture(t, "https://github.com/confluentinc/librdkafka/discussions/5165");
	const result = run(["implementation", body], env);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /refusing to post/);
	assert.deepEqual(mutations(calls), []);
});

test("rejects a discussion number, a bad channel shape and a missing body without calling gh", (t) => {
	const { body, calls, env } = fixture(t, "https://github.com/uberblick-ai/uberblick-2/discussions/522");
	for (const args of [["522", body], ["Implementation", body], ["-audit", body], ["workflow-audit"], ["technical-audit", join(dirname(body), "absent.md")]]) {
		assert.equal(run(args, env).status, 2, args.join(" "));
	}
	assert.deepEqual(mutations(calls), []);
});

test("refuses a channel this project bound to no discussion", (t) => {
	// The channel vocabulary is the project's declarations, so an undeclared
	// channel is a missing binding rather than a typo the script can guess at —
	// and it costs a message, never a post to whatever discussion 1 happens to be.
	const { body, calls, env } = fixture(t, "https://github.com/uberblick-ai/uberblick-2/discussions/522");
	const result = run(["audit", body], env);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no "project\.retrospectives\.audit" binding in .*\.agents\/launch\.json/);
	assert.deepEqual(mutations(calls), []);
});

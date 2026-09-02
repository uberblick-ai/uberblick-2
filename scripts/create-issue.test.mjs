import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/create-issue.mjs");

function fixture(t, fields, readback) {
	const directory = mkdtempSync(join(tmpdir(), "create-issue-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const body = join(directory, "body.md");
	const calls = join(directory, "calls.jsonl");
	const input = join(directory, "input.json");
	const executable = join(directory, "gh");
	writeFileSync(body, "A grounded issue body.\n");
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const endpoint = args.find((value) => value.startsWith("orgs/") || value.startsWith("repos/"));
if (endpoint === "orgs/octo/issue-fields?per_page=100") process.stdout.write(process.env.GH_FIELDS);
else if (endpoint === "repos/octo/repo/issues") {
  writeFileSync(process.env.GH_INPUT, readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify({ number: 901, html_url: "https://github.com/octo/repo/issues/901" }));
} else if (endpoint === "repos/octo/repo/issues/901/issue-field-values") process.stdout.write(process.env.GH_READBACK);
else process.exit(19);
`,
	);
	chmodSync(executable, 0o755);
	return {
		body,
		calls,
		input,
		env: {
			...process.env,
			GH_CALLS: calls,
			GH_FIELDS: JSON.stringify([fields]),
			GH_INPUT: input,
			GH_READBACK: JSON.stringify(readback),
			PATH: `${directory}:${process.env.PATH}`,
		},
	};
}

const field = {
	id: 42,
	name: "Request Source",
	data_type: "single_select",
	options: [{ name: "Human" }, { name: "Agent" }],
};

function run(context) {
	return spawnSync(
		process.execPath,
		[
			script,
			"--repo",
			"octo/repo",
			"--source",
			"Agent",
			"--title",
			"A follow-up",
			"--body-file",
			context.body,
			"--label",
			"needs-preparation",
		],
		{ encoding: "utf8", env: context.env },
	);
}

test("creates an issue with a name-discovered Request Source and reads it back", (t) => {
	const context = fixture(t, field, [
		{ issue_field_name: "Request Source", single_select_option: { name: "Agent" } },
	]);
	const result = run(context);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "https://github.com/octo/repo/issues/901\n");
	assert.equal(result.stderr, "Request Source: Agent\n");
	assert.deepEqual(JSON.parse(readFileSync(context.input, "utf8")), {
		title: "A follow-up",
		body: "A grounded issue body.\n",
		labels: ["needs-preparation"],
		issue_field_values: [{ field_id: 42, value: "Agent" }],
	});
	const calls = readFileSync(context.calls, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(calls.map((call) => call.at(-1)), [
		"orgs/octo/issue-fields?per_page=100",
		"-",
		"repos/octo/repo/issues/901/issue-field-values",
	]);
});

test("a malformed field stays visible but does not block issue creation", (t) => {
	const context = fixture(t, { ...field, options: [{ name: "Agent" }] }, []);
	const result = run(context);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /https:\/\/github\.com\/octo\/repo\/issues\/901/);
	assert.match(result.stderr, /Request Source: failed — .*exactly Human and Agent.*stored value is missing/);
	assert.equal("issue_field_values" in JSON.parse(readFileSync(context.input, "utf8")), false);
});

test("a silently dropped or changed value is reported without hiding the created issue", (t) => {
	const context = fixture(t, field, [
		{ issue_field_name: "Request Source", single_select_option: { name: "Human" } },
	]);
	const result = run(context);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /Request Source: failed — stored value is Human/);
	assert.match(result.stderr, /issue was still created/);
});

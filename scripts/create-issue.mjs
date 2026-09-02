#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const API_VERSION = "X-GitHub-Api-Version: 2026-03-10";
const FIELD_NAME = "Request Source";
const SOURCES = new Set(["Agent", "Human"]);

function fail(message) {
	console.error(`create-issue: ${message}`);
	process.exit(2);
}

function parseArguments(argv) {
	const parsed = { labels: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!["--source", "--title", "--body-file", "--label", "--repo"].includes(flag) || !value)
			fail(
				"usage: create-issue.mjs --source Human|Agent --title <title> --body-file <path> [--label <label>] [--repo <owner/repo>]",
			);
		if (flag === "--label") {
			if (value.includes(",")) fail("repeat --label instead of passing a comma-separated list");
			parsed.labels.push(value);
		}
		else parsed[flag.slice(2).replace("-", "_")] = value;
		index += 1;
	}

	if (!SOURCES.has(parsed.source)) fail("--source must be Human or Agent");
	if (!parsed.title) fail("--title is required");
	if (!parsed.body_file) fail("--body-file is required");
	return parsed;
}

function gh(args, input) {
	return spawnSync("gh", args, { encoding: "utf8", input });
}

function parseJson(result, description) {
	if (result.status !== 0) throw new Error(`${description}: ${result.stderr.trim() || "gh failed"}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`${description}: GitHub returned invalid JSON`);
	}
}

function repository(explicit) {
	if (explicit) return explicit;
	const result = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
	if (result.status !== 0) fail(`cannot resolve the current repository: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function requestSourceField(owner) {
	const result = gh([
		"api",
		"--paginate",
		"--slurp",
		"-H",
		API_VERSION,
		`orgs/${owner}/issue-fields?per_page=100`,
	]);
	const pages = parseJson(result, "cannot list organization issue fields");
	const fields = pages.flat().filter((field) => field.name === FIELD_NAME);
	const field = fields.length === 1 ? fields[0] : undefined;
	const options = field?.options?.map((option) => option.name).sort();
	if (
		!Number.isInteger(field?.id) ||
		field?.data_type !== "single_select" ||
		options?.length !== 2 ||
		options[0] !== "Agent" ||
		options[1] !== "Human"
	)
		throw new Error(`${FIELD_NAME} is not one single-select field with exactly Human and Agent`);
	return field;
}

const args = parseArguments(process.argv.slice(2));
const repo = repository(args.repo);
if (!/^[^/]+\/[^/]+$/.test(repo)) fail(`invalid repository ${JSON.stringify(repo)}`);
const [owner] = repo.split("/");

let field;
let provenanceFailure;
try {
	field = requestSourceField(owner);
} catch (error) {
	provenanceFailure = error.message;
}

const payload = {
	title: args.title,
	body: readFileSync(args.body_file, "utf8"),
};
if (args.labels.length > 0) payload.labels = args.labels;
if (field) payload.issue_field_values = [{ field_id: field.id, value: args.source }];

const createdResult = gh(
	["api", "--method", "POST", "-H", API_VERSION, `repos/${repo}/issues`, "--input", "-"],
	JSON.stringify(payload),
);
if (createdResult.status !== 0) {
	process.stderr.write(createdResult.stderr);
	process.exit(createdResult.status ?? 1);
}
const created = parseJson(createdResult, "cannot read the created issue");
if (!created.number || !created.html_url) fail("GitHub's create response has no issue number or URL");
console.log(created.html_url);

try {
	const values = parseJson(
		gh(["api", "-H", API_VERSION, `repos/${repo}/issues/${created.number}/issue-field-values`]),
		`cannot read ${FIELD_NAME} back`,
	);
	const stored = values.filter((value) => value.issue_field_name === FIELD_NAME);
	if (stored.length !== 1 || stored[0].single_select_option?.name !== args.source)
		throw new Error(`stored value is ${stored[0]?.single_select_option?.name ?? "missing"}`);
} catch (error) {
	provenanceFailure = [provenanceFailure, error.message].filter(Boolean).join("; ");
}

if (provenanceFailure)
	console.error(
		`${FIELD_NAME}: failed — ${provenanceFailure}. Record this failure in the run's durable outcome; the issue was still created.`,
	);
else console.error(`${FIELD_NAME}: ${args.source}`);

/**
 * `scripts/agent-binding.mjs` — how a role reads a value its project declared.
 *
 * Two contracts: the value reaches stdout alone, so a shell can capture it; and
 * a binding that is not there fails loudly, naming the binding and the file and
 * key it searched, rather than resolving to an empty string a caller would then
 * paste into a `gh` command against nothing.
 *
 * The project is the checkout the script sits in, so each fixture copies the
 * script into its own project — which is also what proves the resolution is
 * project-relative rather than anchored to this repository.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/agent-binding.mjs");

/** A throwaway project holding `launch` as its launch data, and the helper. */
function project(t, launch) {
	const base = mkdtempSync(join(tmpdir(), "agent-binding-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(base, ".agents"));
	mkdirSync(join(base, "scripts"));
	writeFileSync(
		join(base, ".agents/launch.json"),
		typeof launch === "string" ? launch : `${JSON.stringify(launch, null, 2)}\n`,
	);
	copyFileSync(script, join(base, "scripts/agent-binding.mjs"));
	return base;
}

function resolve(base, ...args) {
	return spawnSync("node", [join(base, "scripts/agent-binding.mjs"), ...args], {
		encoding: "utf8",
	});
}

const declared = {
	version: 1,
	project: {
		repository: "atlas-ai/atlas",
		baseRef: { remote: "upstream", branch: "release/2.x" },
		retrospectives: { implementation: 12 },
		commands: { review: "just review" },
		empty: "",
	},
	entryRoles: {},
};

test("prints one declared value, and nothing else, on stdout", (t) => {
	const base = project(t, declared);
	for (const [binding, value] of [
		["project.repository", "atlas-ai/atlas"],
		["project.baseRef.branch", "release/2.x"],
		["project.retrospectives.implementation", "12"],
		["project.commands.review", "just review"],
	]) {
		const result = resolve(base, binding);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${value}\n`);
		assert.equal(result.stderr, "");
	}
});

test("reads the project it sits in, not the one it was copied from", (t) => {
	const base = project(t, declared);
	assert.equal(resolve(base, "project.repository").stdout.trim(), "atlas-ai/atlas");
	assert.equal(
		spawnSync("node", [script, "project.repository"], { encoding: "utf8" }).stdout.trim(),
		"uberblick-ai/uberblick-2",
	);
});

test("names the binding, the file and the key it stopped on", (t) => {
	const base = project(t, declared);
	const launch = join(base, ".agents/launch.json");

	const missing = resolve(base, "project.retrospectives.audit");
	assert.equal(missing.status, 1);
	assert.equal(missing.stdout, "");
	assert.match(missing.stderr, /no "project\.retrospectives\.audit" binding/);
	assert.match(missing.stderr, new RegExp(`${launch.replaceAll(".", "\\.")}`));
	assert.match(missing.stderr, /"project\.retrospectives" declares no "audit"/);

	const absent = resolve(base, "project.owner");
	assert.equal(absent.status, 1);
	assert.match(absent.stderr, /"project" declares no "owner"/);

	// Naming a group is a caller mistake worth a distinct sentence: the value
	// does exist, and the caller has to say which part of it it wants.
	const group = resolve(base, "project.baseRef");
	assert.equal(group.status, 1);
	assert.match(group.stderr, /is a group of remote, branch, not one value/);

	// An empty declaration is not a value; treating it as one would hand a
	// caller `gh -R ""` instead of a message.
	const empty = resolve(base, "project.empty");
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /declares no usable value/);
});

test("refuses a malformed launch file by name", (t) => {
	const base = project(t, "not json\n");
	const broken = resolve(base, "project.repository");
	assert.equal(broken.status, 1);
	assert.match(broken.stderr, /\.agents\/launch\.json is missing or invalid JSON/);
});

test("is a usage error without exactly one well-formed binding path", (t) => {
	const base = project(t, declared);
	for (const args of [[], ["project.repository", "extra"], ["project..repository"], ["/etc/passwd"], [".project"]]) {
		const result = resolve(base, ...args);
		assert.equal(result.status, 2, args.join(" "));
		assert.match(result.stderr, /usage: agent-binding\.mjs/);
	}
});

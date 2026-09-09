/**
 * A validator that cannot fail is worse than none, so one broken tree proves it
 * does. The fixture is a temp directory with the script copied into it, because
 * the script anchors itself to its own parent directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	copyFileSync,
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
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

/**
 * A whole adopting project: this repository's own declared workflow, copied.
 *
 * The resource list is `.agents/requires.json`'s, so a file the workflow starts
 * requiring arrives here without anyone remembering to add it — and a fixture
 * that stopped being complete would be the checker's own failure to report.
 */
function completeFixture() {
	const fixture = mkdtempSync(join(tmpdir(), "agent-roles-"));
	mkdirSync(join(fixture, "scripts"));
	copyFileSync(join(here, "check-agent-roles.mjs"), join(fixture, "scripts/check-agent-roles.mjs"));
	const requires = JSON.parse(readFileSync(join(root, ".agents/requires.json"), "utf8"));
	for (const relative of [...requires.resources, ...requires.projectResources]) {
		mkdirSync(dirname(join(fixture, relative)), { recursive: true });
		copyFileSync(join(root, relative), join(fixture, relative));
	}
	// Not portable, and this project's own: the shaping skill adapters the
	// checker requires of itself, and the role triplets it validates.
	for (const relative of [
		".agents/roles",
		".claude/agents",
		".codex/agents",
		".agents/skills/shape-issue",
		".claude/skills/shape-issue",
	]) cpSync(join(root, relative), join(fixture, relative), { recursive: true });
	return fixture;
}

function setClaudeKey(fixture, slug, key, value) {
	const path = join(fixture, ".claude/agents", `${slug}.md`);
	const lines = readFileSync(path, "utf8").split("\n");
	// Only the frontmatter block: a body line opening `effort:` is prose, not a pin.
	const existing = lines.slice(1, lines.indexOf("---", 1)).findIndex((line) => line.startsWith(`${key}:`));
	if (existing !== -1) lines.splice(existing + 1, 1);
	if (value !== null) lines.splice(lines.indexOf("---", 1), 0, `${key}: ${value}`);
	writeFileSync(path, lines.join("\n"));
}

function run(fixture) {
	return spawnSync(process.execPath, [join(fixture, "scripts/check-agent-roles.mjs")], {
		encoding: "utf8",
	});
}

test("an incomplete role tree fails, and the absent Claude third says so", () => {
	const fixture = mkdtempSync(join(tmpdir(), "agent-roles-"));
	for (const dir of ["scripts", ".agents/roles", ".codex/agents"])
		mkdirSync(join(fixture, dir), { recursive: true });
	const script = join(fixture, "scripts/check-agent-roles.mjs");
	copyFileSync(join(here, "check-agent-roles.mjs"), script);
	writeFileSync(join(fixture, ".agents/roles/README.md"), "# Role contracts\n");
	writeFileSync(join(fixture, ".agents/roles/implementer.md"), "# Implementer\n");
	// A value the parser must not accept as `"ok"` with the rest ignored.
	writeFileSync(
		join(fixture, ".codex/agents/implementer.toml"),
		'name = "implementer"\ndescription = "ok" trailing\n',
	);

	const run = spawnSync(process.execPath, [script], { encoding: "utf8" });

	assert.equal(run.status, 1);
	assert.match(run.stdout, /^skipped: \.claude\/agents is absent/m);
	assert.match(run.stderr, /expected exactly \[/);
	assert.match(run.stderr, /value is not one quoted string: description = "ok" trailing/);
});

// `.claude/agents` is absent from the immutable review image, which the script
// itself skips loudly; this test needs it as a fixture, so it skips loudly too.
const claudeSkip = existsSync(join(root, ".claude/agents"))
	? false
	: ".claude/agents is absent from this checkout, so the complete role fixture cannot be built here";

test("only the two owner-approved high effort pins are permitted", { skip: claudeSkip }, () => {
	const fixture = completeFixture();
	assert.equal(run(fixture).status, 0);

	for (const slug of ["issue-preparer", "implementer"]) {
		setClaudeKey(fixture, slug, "effort", "max");
		const result = run(fixture);
		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`${slug}\\.md: effort is "max", expected owner-approved "high"`));
		setClaudeKey(fixture, slug, "effort", "high");
	}

	for (const slug of ["issue-adversary", "implementation-reviewer", "integrator"]) {
		setClaudeKey(fixture, slug, "effort", "high");
		const result = run(fixture);
		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`${slug}\\.md: key "effort" pins runtime policy`));
		setClaudeKey(fixture, slug, "effort", null);
	}
});

test("issue-authoring adapters point to the neutral protocol and its files exist", { skip: claudeSkip }, () => {
	const missingProtocol = completeFixture();
	rmSync(join(missingProtocol, ".agents/protocols/issue-shaping.md"));
	let result = run(missingProtocol);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /issue-shaping\.md: missing provider-neutral issue-authoring file/);

	const staleAdapter = completeFixture();
	writeFileSync(
		join(staleAdapter, ".agents/skills/shape-issue/SKILL.md"),
		"Read .claude/skills/shape-issue/protocol.md\n",
	);
	result = run(staleAdapter);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /does not point to \.agents\/protocols\/issue-shaping\.md/);

	const missingPreparationTest = completeFixture();
	rmSync(join(missingPreparationTest, ".agents/protocols/issue-preparation.test.mjs"));
	result = run(missingPreparationTest);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /issue-preparation\.test\.mjs: missing provider-neutral issue-authoring file/);
});

test("launch data is complete and stays aligned with the role triplets", { skip: claudeSkip }, () => {
	const missing = completeFixture();
	rmSync(join(missing, ".agents/launch.json"));
	let result = run(missing);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /launch\.json: missing repository launch data/);

	const stale = completeFixture();
	const path = join(stale, ".agents/launch.json");
	const data = JSON.parse(readFileSync(path, "utf8"));
	data.entryRoles.implementer.runtimes.codex.adapter = ".codex/agents/integrator.toml";
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	result = run(stale);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /implementer codex adapter.*implementer\.toml/);

	const missingAdapter = completeFixture();
	rmSync(join(missingAdapter, ".claude/agents/implementer.md"));
	result = run(missingAdapter);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /\.claude\/agents\/implementer\.md: missing/);

	const wrongDefault = completeFixture();
	const wrongPath = join(wrongDefault, ".agents/launch.json");
	const wrongData = JSON.parse(readFileSync(wrongPath, "utf8"));
	wrongData.entryRoles.implementer.defaultRuntime = "claude";
	writeFileSync(wrongPath, `${JSON.stringify(wrongData, null, 2)}\n`);
	result = run(wrongDefault);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /implementer defaultRuntime.*expected codex/);

	const wrongPermission = completeFixture();
	const permissionPath = join(wrongPermission, ".agents/launch.json");
	const permissionData = JSON.parse(readFileSync(permissionPath, "utf8"));
	permissionData.entryRoles.integrator.runtimes.claude.permissionMode = "manual";
	writeFileSync(permissionPath, `${JSON.stringify(permissionData, null, 2)}\n`);
	result = run(wrongPermission);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /integrator claude permissionMode.*expected auto/);
});

test("the portable source keeps no value of this project's own", { skip: claudeSkip }, () => {
	// Each of these is a value a second project would have to be able to
	// change, written where nobody could change it: the check exists so the
	// portability cleanup cannot quietly rot back.
	for (const [added, expected] of [
		["Ground at `origin/main` first.\n", /carries "origin\/m" — a base ref/],
		["Ask @bk-one about it.\n", /carries "@bk-one" — an account handle/],
		["Run `mise run test` before handoff.\n", /carries "mise" — a build or validation command/],
		[
			"Role context: Uberblick project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).\n",
			/carries "c0bb016d-3d4c-4316-9b4e-da8a7b322e55" — a corpus document uuid/,
		],
		[
			"Post to https://github.com/uberblick-ai/uberblick-2/discussions/522.\n",
			/carries "github\.com\/uberblick-ai\/uberblick-2" — a repository or discussion URL/,
		],
		[
			"Read /home/someone/uberblick/.agents/roles/implementer.md first.\n",
			/carries "\/home\/" — an absolute host path/,
		],
	]) {
		const fixture = completeFixture();
		const contract = join(fixture, ".agents/roles/implementer.md");
		writeFileSync(contract, `${readFileSync(contract, "utf8")}${added}`);
		const result = run(fixture);
		assert.equal(result.status, 1, added);
		assert.match(result.stderr, expected);
	}
});

test("the required-resource declaration stays honest in both directions", { skip: claudeSkip }, () => {
	const requires = ".agents/requires.json";
	const read = (fixture) => JSON.parse(readFileSync(join(fixture, requires), "utf8"));
	const write = (fixture, data) =>
		writeFileSync(join(fixture, requires), `${JSON.stringify(data, null, 2)}\n`);

	// A helper an instruction tells an agent to run, that the declaration
	// omits: the adopting project would receive the instruction without the
	// helper, so it fails here instead.
	const undeclaredHelper = completeFixture();
	const contract = join(undeclaredHelper, ".agents/roles/implementer.md");
	writeFileSync(
		contract,
		`${readFileSync(contract, "utf8")}\nRun \`sh scripts/undeclared-helper.sh\` last.\n`,
	);
	writeFileSync(join(undeclaredHelper, "scripts/undeclared-helper.sh"), "#!/bin/sh\n");
	let result = run(undeclaredHelper);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /names scripts\/undeclared-helper\.sh, which .* does not declare/);

	// The other direction: a portable file nobody declared, and a declared
	// file nobody shipped.
	const undeclaredFile = completeFixture();
	writeFileSync(join(undeclaredFile, ".agents/protocols/new-protocol.md"), "# New\n");
	result = run(undeclaredFile);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /resources omits the portable file \.agents\/protocols\/new-protocol\.md/);

	const absentResource = completeFixture();
	const declared = read(absentResource);
	declared.resources = [...declared.resources, "scripts/absent-helper.sh"].sort();
	write(absentResource, declared);
	result = run(absentResource);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /names a file this repository does not have: scripts\/absent-helper\.sh/);

	// And the bindings half: this project must declare what the workflow needs.
	const missingBinding = completeFixture();
	const launch = join(missingBinding, ".agents/launch.json");
	const data = JSON.parse(readFileSync(launch, "utf8"));
	delete data.project.retrospectives.implementation;
	writeFileSync(launch, `${JSON.stringify(data, null, 2)}\n`);
	result = run(missingBinding);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/declares no "project\.retrospectives\.implementation", which .* requires of every project/,
	);

	const malformed = completeFixture();
	write(malformed, { version: 2, bindings: [], resources: [], projectResources: [] });
	result = run(malformed);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /expected only version 1, bindings, resources and projectResources/);
});

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

function completeFixture() {
	const fixture = mkdtempSync(join(tmpdir(), "agent-roles-"));
	mkdirSync(join(fixture, "scripts"));
	copyFileSync(join(here, "check-agent-roles.mjs"), join(fixture, "scripts/check-agent-roles.mjs"));
	for (const relative of [".agents/roles", ".claude/agents", ".codex/agents"])
		cpSync(join(root, relative), join(fixture, relative), { recursive: true });
	copyFileSync(join(root, ".agents/launch.json"), join(fixture, ".agents/launch.json"));
	for (const relative of [
		".agents/protocols",
		".agents/skills/shape-issue",
		".agents/adapters",
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

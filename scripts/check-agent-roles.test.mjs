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
	: ".claude/agents is absent from this checkout, so the effort pins cannot be checked here";

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

	for (const slug of ["issue-adversary", "implementation-reviewer", "integrator", "program-coordinator"]) {
		setClaudeKey(fixture, slug, "effort", "high");
		const result = run(fixture);
		assert.equal(result.status, 1);
		assert.match(result.stderr, new RegExp(`${slug}\\.md: key "effort" pins runtime policy`));
		setClaudeKey(fixture, slug, "effort", null);
	}
});

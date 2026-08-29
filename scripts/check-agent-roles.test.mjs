/**
 * A validator that cannot fail is worse than none, so one broken tree proves it
 * does. The fixture is a temp directory with the script copied into it, because
 * the script anchors itself to its own parent directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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

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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts/probe-work.sh");

/** Run the probe with a `gh` that answers `count`, or fails when it is null. */
function probe(t, role, count) {
	const base = mkdtempSync(join(tmpdir(), "probe-work-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const bin = join(base, "bin");
	mkdirSync(bin);
	const gh = join(bin, "gh");
	writeFileSync(
		gh,
		count === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho ${count}\n`,
	);
	chmodSync(gh, 0o755);
	return spawnSync("sh", [script, role], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
	});
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

test("an unknown role is a usage error, not an idle", (t) => {
	const unknown = probe(t, "reviewer", 3);
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /usage: probe-work\.sh/);
});

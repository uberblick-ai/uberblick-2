#!/usr/bin/env node

/**
 * Prove that Homebrew upgrades an installed Uberblick and leaves what the
 * person created alone.
 *
 * Two payloads built from this checkout stand in for two published releases:
 * the tap holds one formula whose identity never changes, so `brew upgrade`
 * takes the same path it takes against the real tap. The public
 * `brew upgrade uberblick-ai/tap/uberblick` transcript belongs to the tap's
 * second publication; this is the repeatable half, and it needs no credential.
 *
 * Apple Silicon macOS only, because that is where the formula is supported.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { treeDigest, withMcpSession } from "./lib/homebrew-proof.mjs";
import { formulaFor } from "./publish-homebrew-release.mjs";

const [installedVersion, upgradedVersion] = process.argv.slice(2);
if (installedVersion === undefined || upgradedVersion === undefined) {
	throw new Error(
		"usage: node scripts/homebrew-upgrade-proof.mjs <installed-version> <upgraded-version>",
	);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error(
		`Homebrew proof needs Apple Silicon macOS, got ${process.platform}/${process.arch}`,
	);
}

// Every brew call below is deliberate; an implicit `brew update` in the middle
// of the probe would change the tap underneath it.
process.env.HOMEBREW_NO_AUTO_UPDATE = "1";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAP = "uberblick-ai/upgrade-proof";
const FORMULA = `${TAP}/uberblick`;
// The sentinel proves the document itself, not only its file: an upgrade that
// kept the database but could no longer read it would pass a byte comparison.
const SENTINEL = "The paragraph this workspace held before the upgrade.";

const scratch = mkdtempSync(join(tmpdir(), "uberblick-homebrew-upgrade-"));
const dist = join(scratch, "dist");
const cwd = join(scratch, "cwd");
const configHome = join(scratch, "config");
const dataHome = join(scratch, "data");
for (const directory of [dist, cwd, configHome, dataHome]) mkdirSync(directory, { recursive: true });

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: 900_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} ${result.signal === null ? `exited ${result.status}` : `ended from ${result.signal}`}: ${result.stderr ?? ""}`,
		);
	}
	return (result.stdout ?? "").trim();
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

const brewPrefix = run("brew", ["--prefix"]);
expect(brewPrefix !== "", "Homebrew did not report its prefix");

/** What a person's shell sees: Homebrew's `bin`, and this proof's own XDG home. */
const userEnv = {
	...process.env,
	XDG_CONFIG_HOME: configHome,
	XDG_DATA_HOME: dataHome,
	PATH: `${brewPrefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
};
for (const key of ["HUB_AUTH_TOKEN", "HUB_DB_PATH", "HUB_URL", "UBERBLICK_DB", "WORKSPACE_ID", "WORKSPACES"]) {
	delete userEnv[key];
}

const ub = (args) => run("ub", args, { env: userEnv });

// Homebrew keeps everything it needs from the host, but resolves user state
// through the same XDG home the digests watch: an install or upgrade that
// reached into a person's configuration or data has to reach into these.
const brewEnv = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome };
const brew = (args) => run("brew", args, { env: brewEnv });

function buildPayload(version) {
	run("node", [join(REPOSITORY_ROOT, "scripts", "build-install-payload.mjs"), version], {
		cwd: REPOSITORY_ROOT,
		env: { ...process.env, UBERBLICK_PAYLOAD_OUTPUT_DIR: dist },
		stdio: ["ignore", "inherit", "pipe"],
	});
	return join(dist, `uberblick-${version}.tar.gz`);
}

/** The formula the publisher would generate, pointed at a local payload. */
function publishToTap(tapFormulaPath, version, payload) {
	const digest = createHash("sha256").update(readFileSync(payload)).digest("hex");
	writeFileSync(tapFormulaPath, formulaFor(`v${version}`, version, digest, `file://${payload}`));
}

async function documentText(uuid) {
	return await withMcpSession(
		{ cwd, env: userEnv, clientName: "homebrew-upgrade-proof", clientVersion: upgradedVersion },
		async (callTool) => {
			const document = await callTool("get_doc", { uuid });
			return document.blocks.map((block) => block.text).join("\n");
		},
	);
}

const installedPayload = buildPayload(installedVersion);
const upgradedPayload = buildPayload(upgradedVersion);

brew(["tap-new", TAP]);
const tapFormulaPath = join(brew(["--repository", TAP]), "Formula", "uberblick.rb");

try {
	publishToTap(tapFormulaPath, installedVersion, installedPayload);
	brew(["install", "--build-from-source", FORMULA]);
	expect(ub(["--version"]) === installedVersion, "the installed formula reported the wrong version");

	// What the person has before the upgrade: a workspace and a document in it.
	ub(["init", "--yes", "--no-mcp"]);
	const before = JSON.parse(ub(["status", "--json"]));
	const uuid = await withMcpSession(
		{ cwd, env: userEnv, clientName: "homebrew-upgrade-proof", clientVersion: installedVersion },
		async (callTool) => {
			const created = await callTool("create_doc", {
				title: "Before the upgrade",
				description: "A document created on the installed release, to be found again after the upgrade.",
				blocks: [{ type: "paragraph", text: SENTINEL }],
			});
			return created.uuid;
		},
	);
	// Every writer is stopped here, so the two digests compare the same
	// quiescent state rather than a replica still settling.
	const stateBefore = [treeDigest(configHome), treeDigest(dataHome)];

	publishToTap(tapFormulaPath, upgradedVersion, upgradedPayload);
	brew(["upgrade", "--build-from-source", FORMULA]);

	expect(ub(["--version"]) === upgradedVersion, "ub did not report the upgraded version");
	expect(
		run("uberblick", ["--version"], { env: userEnv }) === upgradedVersion,
		"uberblick did not report the upgraded version",
	);
	const upgradedKeg = join(brew(["--cellar", FORMULA]), upgradedVersion);
	for (const name of ["ub", "uberblick"]) {
		expect(
			realpathSync(join(brewPrefix, "bin", name)).startsWith(`${upgradedKeg}/`),
			`${name} on PATH does not resolve into the upgraded install`,
		);
	}

	const stateAfter = [treeDigest(configHome), treeDigest(dataHome)];
	expect(
		stateAfter[0] === stateBefore[0] && stateAfter[1] === stateBefore[1],
		"the upgrade changed configuration, credentials, workspaces or databases",
	);

	const after = JSON.parse(ub(["status", "--json"]));
	expect(after.workspaceUuid === before.workspaceUuid, "the upgraded install reports another workspace");
	expect(after.version === upgradedVersion, "the upgraded install reports the wrong version");
	expect((await documentText(uuid)).includes(SENTINEL), "the document written before the upgrade is gone");

	// The upgraded copy is a working install, not merely a present one: the
	// formula proof's own journeys, on a home this workspace never touched.
	const smokeEnv = { ...process.env };
	for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) delete smokeEnv[key];
	run("node", [join(REPOSITORY_ROOT, "scripts", "homebrew-formula-proof.mjs"), FORMULA, upgradedVersion, tapFormulaPath], {
		env: smokeEnv,
		stdio: ["ignore", "inherit", "pipe"],
	});

	process.stdout.write(
		`homebrew upgrade proof: ${installedVersion} to ${upgradedVersion} on ${process.arch} passed\n`,
	);
} finally {
	spawnSync("brew", ["uninstall", "--force", FORMULA], { cwd: scratch });
	spawnSync("brew", ["untap", TAP], { cwd: scratch });
	rmSync(scratch, { recursive: true, force: true });
}

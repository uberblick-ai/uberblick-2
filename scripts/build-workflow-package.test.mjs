/**
 * The workflow package format and the builder that produces it.
 *
 * A published artifact cannot be taken back, so the interesting assertions here
 * are the refusals: a checkout that no longer matches the commit it would be
 * published under, a declared path that is not what it claims to be, a payload
 * that leaks this project's identity into a public artifact, and a build step
 * standing next to a publication credential. The fixture is a real git
 * repository, because "attributable to a source commit" is a property of git,
 * not of the file system.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildWorkflowPackage } from "./build-workflow-package.mjs";
import { versionForTag } from "./publish-homebrew-release.mjs";
import {
	DIGEST_FRAMING,
	MANIFEST_NAME,
	PAYLOAD_DIRECTORY,
	WORKFLOW_NAME,
	packageDirectoryName,
	payloadDigest,
	readManifest,
	verifyExtractedPackage,
	versionForWorkflowTag,
	workflowAssetName,
	workflowAssetUrl,
	workflowTagFor,
} from "./lib/workflow-package.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = "1.2.3";
const OWNER = "fixture-owner";
const REPOSITORY = "fixture-org/fixture-repo";

const scratches = [];
function scratch(prefix) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	scratches.push(directory);
	return directory;
}

process.on("exit", () => {
	for (const directory of scratches) rmSync(directory, { recursive: true, force: true });
});

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function write(root, relative, content, mode) {
	const path = join(root, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
}

const DEFAULT_RESOURCES = [
	".agents/requires.json",
	".agents/roles/implementer.md",
	"AGENTS.md",
	"scripts/helper.sh",
];

/** A small adopting-shaped repository: a declaration, a payload and a commit. */
function fixture({ resources = DEFAULT_RESOURCES, files = {}, commit = true } = {}) {
	const root = scratch("workflow-package-fixture-");
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	git(root, ["config", "user.name", "Fixture"]);
	write(
		root,
		".agents/requires.json",
		`${JSON.stringify(
			{
				version: 1,
				bindings: ["project.owner", "project.repository"],
				resources,
				projectResources: [".agents/launch.json"],
			},
			null,
			2,
		)}\n`,
	);
	write(
		root,
		".agents/launch.json",
		`${JSON.stringify({ version: 2, project: { repository: REPOSITORY, owner: OWNER } }, null, 2)}\n`,
	);
	write(root, ".agents/roles/implementer.md", "# Implementer\n\nOne bounded assignment.\n");
	write(root, "AGENTS.md", "# Agent entry point\n\nRead the role contract.\n");
	write(root, "scripts/helper.sh", "#!/bin/sh\necho helper\n", 0o755);
	write(root, ".agents/private.md", "This project's own note, declared nowhere.\n");
	for (const [relative, content] of Object.entries(files)) write(root, relative, content);
	if (commit) {
		git(root, ["add", "-A"]);
		git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
	}
	return root;
}

function build(root, overrides = {}) {
	return buildWorkflowPackage({
		root,
		version: VERSION,
		outputDir: scratch("workflow-package-out-"),
		env: {},
		...overrides,
	});
}

function extract(archive) {
	const directory = scratch("workflow-package-extract-");
	const result = spawnSync("tar", ["-xzf", archive, "-C", directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return join(directory, packageDirectoryName(VERSION));
}

function refusal(body) {
	try {
		body();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return assert.fail("expected a refusal");
}

test("a version resolves to one tag, one asset name and one address", () => {
	assert.equal(workflowTagFor(VERSION), "workflow-v1.2.3");
	assert.equal(versionForWorkflowTag("workflow-v1.2.3"), VERSION);
	assert.equal(workflowAssetName(VERSION), "uberblick-workflow-1.2.3.tar.gz");
	assert.equal(
		workflowAssetUrl("uberblick-ai/homebrew-tap", "workflow-v1.2.3", VERSION),
		"https://github.com/uberblick-ai/homebrew-tap/releases/download/workflow-v1.2.3/uberblick-workflow-1.2.3.tar.gz",
	);
	for (const tag of ["1.2.3", "workflow-1.2.3", "workflow-v1.2", "workflow-v01.2.3", "workflow-v1.2.3-rc1", "workflow-v1.2.3 "]) {
		assert.throws(() => versionForWorkflowTag(tag), /must be exactly/, tag);
	}
});

test("the workflow tag namespace cannot collide with the product's", () => {
	// Each publisher refuses the other's spelling, and one version never resolves
	// to one asset name, so a consumer asking for a workflow cannot be handed the
	// product install payload.
	assert.throws(() => versionForWorkflowTag("v1.2.3"), /must be exactly/);
	assert.throws(() => versionForTag("workflow-v1.2.3"), /must be exactly/);
	assert.notEqual(workflowAssetName(VERSION), `uberblick-${VERSION}.tar.gz`);
});

test("the digest frames path, mode and content instead of concatenating them", () => {
	// Unframed, both of these are the same byte stream; the length prefixes are
	// what make a byte moved across a boundary a different payload.
	const left = [{ path: "ab", mode: "c", content: Buffer.from("d") }];
	const right = [{ path: "a", mode: "bc", content: Buffer.from("d") }];
	assert.notEqual(payloadDigest(left), payloadDigest(right));
});

test("the digest answers to every recorded component, and not to entry order", () => {
	const base = [
		{ path: "a.md", mode: "100644", content: Buffer.from("one") },
		{ path: "b.md", mode: "100644", content: Buffer.from("two") },
	];
	const digest = payloadDigest(base);
	assert.equal(payloadDigest([base[1], base[0]]), digest);
	for (const changed of [
		[{ ...base[0], path: "c.md" }, base[1]],
		[{ ...base[0], mode: "100755" }, base[1]],
		[{ ...base[0], content: Buffer.from("ONE") }, base[1]],
		[base[0]],
	]) {
		assert.notEqual(payloadDigest(changed), digest);
	}
});

test("a build declares its workflow, version, source and inventory", () => {
	const root = fixture();
	const { archive, manifest } = build(root);
	assert.equal(archive.endsWith(workflowAssetName(VERSION)), true);
	assert.equal(manifest.workflow, WORKFLOW_NAME);
	assert.equal(manifest.version, VERSION);
	assert.deepEqual(manifest.source, { repository: REPOSITORY, commit: git(root, ["rev-parse", "HEAD"]) });
	assert.equal(manifest.digest.algorithm, "sha256");
	assert.equal(manifest.digest.framing, DIGEST_FRAMING);
	assert.deepEqual(manifest.payload, [
		{ path: ".agents/requires.json", mode: "100644" },
		{ path: ".agents/roles/implementer.md", mode: "100644" },
		{ path: "AGENTS.md", mode: "100644" },
		{ path: "scripts/helper.sh", mode: "100755" },
	]);

	const directory = extract(archive);
	assert.deepEqual(readManifest(readFileSync(join(directory, MANIFEST_NAME), "utf8")), manifest);
	assert.equal(
		readFileSync(join(directory, PAYLOAD_DIRECTORY, "AGENTS.md"), "utf8"),
		readFileSync(join(root, "AGENTS.md"), "utf8"),
	);
});

test("a consumer recomputes the digest from the extracted payload and manifest alone", () => {
	const directory = extract(build(fixture()).archive);
	const manifest = verifyExtractedPackage(directory);
	assert.equal(manifest.workflow, WORKFLOW_NAME);

	const payload = join(directory, PAYLOAD_DIRECTORY);
	const original = readFileSync(join(payload, "AGENTS.md"));
	writeFileSync(join(payload, "AGENTS.md"), "tampered\n");
	assert.throws(() => verifyExtractedPackage(directory), /damaged package: payload digest/);
	writeFileSync(join(payload, "AGENTS.md"), original);

	chmodSync(join(payload, "AGENTS.md"), 0o755);
	assert.throws(() => verifyExtractedPackage(directory), /damaged package: AGENTS\.md is 100755/);
	chmodSync(join(payload, "AGENTS.md"), 0o644);

	writeFileSync(join(payload, "stowaway.md"), "not declared\n");
	assert.throws(() => verifyExtractedPackage(directory), /undeclared entry stowaway\.md/);
	rmSync(join(payload, "stowaway.md"));

	rmSync(join(payload, "AGENTS.md"));
	assert.throws(() => verifyExtractedPackage(directory), /missing declared entry AGENTS\.md/);
});

test("two builds of one source commit agree whatever the building checkout's permissions are", () => {
	const root = fixture();
	const first = build(root).manifest;
	// git records the executable bit and nothing else, so a checkout whose umask
	// left wider permission bits behind must not move the digest.
	chmodSync(join(root, "AGENTS.md"), 0o666);
	chmodSync(join(root, "scripts/helper.sh"), 0o777);
	const second = build(root).manifest;
	assert.deepEqual(second.payload, first.payload);
	assert.equal(second.digest.payload, first.digest.payload);
});

test("a checkout that differs from the source commit is refused rather than published under it", () => {
	const root = fixture();
	writeFileSync(join(root, "AGENTS.md"), "edited after the commit\n");
	assert.match(refusal(() => build(root)), /differs from source commit [0-9a-f]{40} at AGENTS\.md/);
});

test("the payload is exactly what the declaration names", () => {
	const declared = build(fixture()).manifest.payload.map((entry) => entry.path);
	// The fixture's `.agents/private.md` is committed and readable, and the
	// declaration does not name it, so nothing can carry it into the artifact.
	assert.equal(declared.includes(".agents/private.md"), false);
	assert.deepEqual(declared, DEFAULT_RESOURCES);

	const missing = fixture({ resources: [...DEFAULT_RESOURCES, ".agents/protocols/absent.md"] });
	assert.match(
		refusal(() => build(missing)),
		/declared resource \.agents\/protocols\/absent\.md is missing from this checkout/,
	);
});

test("a declared path that is not canonical, unique or an ordinary file fails the build", () => {
	for (const [path, pattern] of [
		["./AGENTS.md", /not canonical/],
		["/AGENTS.md", /not canonical/],
		[".agents/../AGENTS.md", /not canonical/],
		["scripts/", /not canonical/],
	]) {
		assert.match(refusal(() => build(fixture({ resources: [path] }))), pattern, path);
	}
	assert.match(
		refusal(() => build(fixture({ resources: ["AGENTS.md", "AGENTS.md"] }))),
		/duplicates or aliases/,
	);
	assert.match(
		refusal(() => build(fixture({ resources: ["AGENTS.md", "agents.md"] }))),
		/duplicates or aliases/,
	);
});

test("a resource reached through a symlink never enters the payload", () => {
	for (const [path, pattern] of [
		[".agents/alias.md", /through the symlink \.agents\/alias\.md/],
		["linked/helper.sh", /through the symlink linked/],
	]) {
		const declared = fixture({ resources: [path], commit: false });
		symlinkSync("roles/implementer.md", join(declared, ".agents/alias.md"));
		symlinkSync("scripts", join(declared, "linked"));
		git(declared, ["add", "-A"]);
		git(declared, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
		assert.match(refusal(() => build(declared)), pattern, path);
	}
});

test("the build refuses to run beside a publication credential", () => {
	assert.match(
		refusal(() => build(fixture(), { env: { HOMEBREW_TAP_TOKEN: "not-a-real-token" } })),
		/HOMEBREW_TAP_TOKEN must not be in this step's environment/,
	);
});

test("a payload entry carrying a declared binding fails, naming the entry and the key", () => {
	const root = fixture({
		resources: [...DEFAULT_RESOURCES, ".agents/leak.md"].sort(),
		files: { ".agents/leak.md": `Ask ${OWNER} on the issue.\n` },
	});
	const message = refusal(() => build(root));
	assert.match(message, /payload entry \.agents\/leak\.md carries this project's "project\.owner" binding/);
	assert.equal(message.includes(OWNER), false);
});

test("this repository's own declaration builds a package a consumer accepts", () => {
	const requires = JSON.parse(readFileSync(join(ROOT, ".agents", "requires.json"), "utf8"));
	const dirty = spawnSync("git", ["diff", "--name-only", "HEAD", "--", ...requires.resources], {
		cwd: ROOT,
		encoding: "utf8",
	});
	if (dirty.status !== 0 || dirty.stdout.trim() !== "") {
		// The portable source is edited but not committed, which is exactly what
		// the builder refuses; there is nothing to prove here until it is.
		return;
	}
	const { manifest } = build(ROOT);
	assert.deepEqual(
		manifest.payload.map((entry) => entry.path),
		[...requires.resources].sort(),
	);
	// The product install payload is `bin/`, `packages/cli/` and
	// `packages/web/dist/` and deliberately no `.agents`; the two artifacts
	// therefore share no file, and neither contains the other.
	for (const entry of manifest.payload) {
		assert.equal(
			["bin/", "packages/"].some((prefix) => entry.path.startsWith(prefix)),
			false,
			entry.path,
		);
	}
	assert.equal(verifyExtractedPackage(extract(build(ROOT).archive)).version, VERSION);
});

#!/usr/bin/env node
/**
 * Build one versioned workflow package from this repository's declared portable
 * source.
 *
 * The artifact is `dist/uberblick-workflow-<version>.tar.gz`, unpacking to
 * `uberblick-workflow-<version>/` with a `manifest.json` beside a `payload/`
 * tree. It is deliberately not the product install payload
 * (`build-install-payload.mjs`): that one ships executables and the web bundle
 * and no `.agents` at all, this one ships only what `.agents/requires.json`
 * declares portable, and the two never share a name or a tag.
 *
 * Three properties this step holds, because a published artifact cannot be
 * taken back:
 *
 *  - **Attributable.** Every entry comes from one named source commit. A
 *    checkout whose declared resources differ from that commit is refused
 *    rather than published under it, and both halves of an entry are then read
 *    from the commit rather than from disk — the mode git recorded and the
 *    blob's own bytes — so two machines building one commit produce one digest
 *    and one inventory whatever their umask or content filters are.
 *  - **Declared.** The payload is exactly `.agents/requires.json`'s `resources`
 *    — a declared file missing from the checkout fails, and nothing the
 *    declaration does not name can reach the payload, because the declaration
 *    is what the payload is assembled from. No role name, role count or file
 *    list lives here.
 *  - **Credential-free.** This step holds no publication credential and refuses
 *    to run beside one; the credential enters only at the upload boundary in
 *    `publish-workflow-package.mjs`. Separately, a payload entry carrying one of
 *    this project's declared bindings fails the build, because the source
 *    repository is private while the artifact is public.
 */

import { spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MANIFEST_NAME,
	PAYLOAD_DIRECTORY,
	checkedPayloadPath,
	checkedVersion,
	fileMode,
	manifestFor,
	manifestText,
	packageDirectoryName,
	recordedMode,
	workflowAssetName,
} from "./lib/workflow-package.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRES = ".agents/requires.json";
const LAUNCH = ".agents/launch.json";
/** The one publication credential this project has; the builder must never see it. */
const PUBLICATION_CREDENTIAL = "HOMEBREW_TAP_TOKEN";
const BLOB_MODES = new Map([
	["100644", false],
	["100755", true],
]);

function fail(message) {
	throw new Error(`build-workflow-package: ${message}`);
}

function gitBytes(root, args) {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd: root,
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0) {
		fail(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
	}
	return result.stdout;
}

function git(root, args) {
	return gitBytes(root, args).toString("utf8");
}

function readJson(root, relative, commit) {
	let text;
	try {
		text = git(root, ["show", `${commit}:${relative}`]);
	} catch {
		fail(`cannot read ${relative}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		fail(`${relative} is not valid JSON`);
	}
}

/** One dotted binding path resolved in the launch data, or null. */
function binding(launch, path) {
	let value = launch;
	for (const key of path.split(".")) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		if (!Object.hasOwn(value, key)) return null;
		value = value[key];
	}
	if (value === null || typeof value === "object") return null;
	return String(value);
}

/** The declared resources, checked for the shape a payload path may take. */
function declaredResources(root, commit) {
	const requires = readJson(root, REQUIRES, commit);
	const resources = requires?.resources;
	if (!Array.isArray(resources) || resources.length === 0) {
		fail(`${REQUIRES} declares no resources`);
	}
	const seen = new Map();
	for (const path of resources) {
		checkedPayloadPath(path);
		const alias = path.toLowerCase();
		const first = seen.get(alias);
		if (first !== undefined) {
			fail(`${REQUIRES} declares ${path}, which duplicates or aliases ${first}`);
		}
		seen.set(alias, path);
	}
	const bindings = requires?.bindings;
	if (!Array.isArray(bindings) || bindings.length === 0) {
		fail(`${REQUIRES} declares no bindings`);
	}
	return { resources, bindings };
}

/** `path` and every directory above it is an ordinary entry of this checkout. */
function assertOrdinaryFile(root, path) {
	const segments = path.split("/");
	for (let depth = 1; depth <= segments.length; depth += 1) {
		const partial = segments.slice(0, depth).join("/");
		let stat;
		try {
			stat = lstatSync(join(root, partial));
		} catch {
			fail(`declared resource ${path} is missing from this checkout`);
		}
		if (stat.isSymbolicLink()) {
			fail(`declared resource ${path} reaches outside the source tree through the symlink ${partial}`);
		}
		if (depth < segments.length ? !stat.isDirectory() : !stat.isFile()) {
			fail(`declared resource ${path} is not an ordinary file of this checkout`);
		}
	}
}

/** Every blob of one commit, by path, with the mode and object git recorded. */
function commitBlobs(root, commit) {
	const blobs = new Map();
	for (const record of git(root, ["ls-tree", "-r", "-z", commit]).split("\0")) {
		if (record === "") continue;
		const tab = record.indexOf("\t");
		const [mode, type, object] = record.slice(0, tab).split(" ");
		blobs.set(record.slice(tab + 1), { mode, type, object });
	}
	return blobs;
}

/**
 * The payload entries for one commit: declared, present, ordinary, unmodified
 * since that commit, and carrying git's mode rather than the checkout's.
 */
function payloadEntries(root, commit, resources) {
	const blobs = commitBlobs(root, commit);
	for (const path of resources) {
		assertOrdinaryFile(root, path);
		const blob = blobs.get(path);
		if (blob === undefined) {
			fail(`declared resource ${path} is not part of source commit ${commit}`);
		}
		if (blob.type !== "blob" || !BLOB_MODES.has(blob.mode)) {
			fail(`declared resource ${path} is not an ordinary file at source commit ${commit}`);
		}
	}
	const changed = git(root, ["diff", "--name-only", commit, "--", ...resources])
		.split("\n")
		.filter((line) => line !== "");
	if (changed.length > 0) {
		fail(
			`this checkout differs from source commit ${commit} at ${changed.join(", ")}; commit or restore it before building`,
		);
	}
	// Content comes from the commit's own objects rather than from the files on
	// disk. The checkout is proven equal to the commit just above, but "equal" is
	// git's judgement, not a byte comparison: a working tree under
	// `core.autocrlf`, a clean filter or any other content filter holds different
	// bytes for a file git considers unchanged. Reading the blob is what makes
	// two machines building one commit produce one digest.
	return resources.map((path) => {
		const blob = blobs.get(path);
		return {
			path,
			mode: recordedMode(BLOB_MODES.get(blob.mode)),
			content: gitBytes(root, ["cat-file", "blob", blob.object]),
		};
	});
}

/**
 * No payload entry carries one of this project's declared binding values.
 *
 * These are not secrets — their absence proves nothing about a credential,
 * which is why the credential boundary above is structural instead. What this
 * catches is the other leak: a portable file that quietly names this project's
 * repository, owner, discussions or documents and would send an adopting
 * project's agents back here. The value itself is never printed.
 */
function assertNoDeclaredBinding(entries, launch, bindings) {
	for (const key of bindings) {
		const value = binding(launch, key);
		if (value === null || value === "") fail(`${LAUNCH} declares no "${key}"`);
		const pattern = new RegExp(
			`(?<![A-Za-z0-9_-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
		);
		for (const entry of entries) {
			if (pattern.test(entry.content.toString("utf8"))) {
				fail(`payload entry ${entry.path} carries this project's "${key}" binding; resolve it instead`);
			}
		}
	}
}

export function buildWorkflowPackage({ root, version, outputDir, env = process.env }) {
	const checked = checkedVersion(version);
	if (typeof env[PUBLICATION_CREDENTIAL] === "string" && env[PUBLICATION_CREDENTIAL] !== "") {
		fail(
			`the payload is assembled without a publication credential; ${PUBLICATION_CREDENTIAL} must not be in this step's environment`,
		);
	}
	const commit = git(root, ["rev-parse", "HEAD"]).trim();
	// Control files must match the source even when the declaration omits itself.
	payloadEntries(root, commit, [REQUIRES, LAUNCH]);
	const { resources, bindings } = declaredResources(root, commit);
	const launch = readJson(root, LAUNCH, commit);
	const entries = payloadEntries(root, commit, resources);
	assertNoDeclaredBinding(entries, launch, bindings);

	const sourceRepository = binding(launch, "project.repository");
	if (sourceRepository === null) fail(`${LAUNCH} declares no "project.repository"`);
	const manifest = manifestFor({ version: checked, sourceRepository, sourceCommit: commit, entries });

	const directory = packageDirectoryName(checked);
	const archive = join(outputDir, workflowAssetName(checked));
	const scratch = mkdtempSync(join(tmpdir(), "uberblick-workflow-package-"));
	// Staged beside the archive so the rename is same-filesystem and atomic, and
	// named per builder so two concurrent builds never share one staging file.
	const temporaryArchive = `${archive}.${process.pid}.tmp`;
	try {
		const staged = join(scratch, directory);
		mkdirSync(staged, { recursive: true });
		writeFileSync(join(staged, MANIFEST_NAME), manifestText(manifest), "utf8");
		for (const entry of entries) {
			const destination = join(staged, PAYLOAD_DIRECTORY, entry.path);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, entry.content, { mode: fileMode(entry.mode) });
		}
		mkdirSync(outputDir, { recursive: true });
		const tar = spawnSync("tar", ["-czf", temporaryArchive, "-C", scratch, directory], {
			encoding: "utf8",
		});
		if (tar.status !== 0) fail(`tar failed: ${(tar.stderr ?? "").trim()}`);
		renameSync(temporaryArchive, archive);
	} finally {
		rmSync(temporaryArchive, { force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
	return { archive, manifest };
}

function main() {
	const version = process.argv[2];
	if (version === undefined) {
		fail("usage: mise run build-workflow-package -- MAJOR.MINOR.PATCH");
	}
	const outputDir = resolve(
		process.env.UBERBLICK_WORKFLOW_PACKAGE_OUTPUT_DIR ?? join(REPOSITORY_ROOT, "dist"),
	);
	const { archive, manifest } = buildWorkflowPackage({
		root: REPOSITORY_ROOT,
		version,
		outputDir,
	});
	process.stdout.write(`workflow package: ${archive}\n`);
	process.stdout.write(
		`source ${manifest.source.commit}, ${manifest.payload.length} entries, ${manifest.digest.algorithm} ${manifest.digest.payload}\n`,
	);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

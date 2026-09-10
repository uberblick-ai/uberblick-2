/**
 * The workflow package format: how a version is spelled, where it resolves to,
 * what its manifest declares, and how its content digest is computed.
 *
 * This module is the consumer's half of the artifact. It never reads git, the
 * required-resource declaration or the network, so a project that adopts a
 * workflow can recompute the digest from an extracted payload and its manifest
 * alone and tell a damaged package from an intact one. The builder beside it
 * (`build-workflow-package.mjs`) produces packages this module accepts; the
 * publisher (`publish-workflow-package.mjs`) resolves addresses through it.
 *
 * Plain Node, no imports beyond `node:`, like the other helpers in `scripts/`.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The workflow this repository packages. It is the publication identity — the
 * same identity the settled asset spelling below carries — and deliberately not
 * a role name, a role count or a file list: those are the declaration's.
 */
export const WORKFLOW_NAME = "uberblick-workflow";
export const TAP_REPOSITORY = "uberblick-ai/homebrew-tap";
const MANIFEST_VERSION = 1;
const DIGEST_ALGORITHM = "sha256";
/**
 * The framing the digest is computed under, named in the manifest so a consumer
 * can reproduce it without this code:
 *
 *   for each inventory entry, ordered by the UTF-8 bytes of its path,
 *     u64be(byteLength(path))   ‖ path
 *     u64be(byteLength(mode))   ‖ mode
 *     u64be(byteLength(content))‖ content
 *
 * digested with `DIGEST_ALGORITHM` over that concatenation. The lengths are what
 * make it a framing rather than a concatenation: without them a byte moved from
 * the end of a path to the front of a mode leaves the stream unchanged, so two
 * different payloads could carry one digest.
 */
export const DIGEST_FRAMING = "uberblick-workflow-payload-v1";
export const MANIFEST_NAME = "manifest.json";
export const PAYLOAD_DIRECTORY = "payload";

/** The only two modes git records, and therefore the only two an inventory may. */
const REGULAR_MODE = "100644";
const EXECUTABLE_MODE = "100755";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TAG_PREFIX = "workflow-v";
const COMMIT = /^[0-9a-f]{40}$/;

function fail(message) {
	throw new Error(`workflow-package: ${message}`);
}

/**
 * A workflow version is exactly MAJOR.MINOR.PATCH — no prerelease, no build
 * metadata and no leading zeroes — so one version has one spelling and one
 * address.
 */
export function checkedVersion(raw) {
	if (typeof raw !== "string" || !VERSION.test(raw)) {
		fail(`version must be exactly MAJOR.MINOR.PATCH, got ${JSON.stringify(raw)}`);
	}
	return raw;
}

export function workflowTagFor(version) {
	return `${TAG_PREFIX}${checkedVersion(version)}`;
}

/**
 * The version a tag names. The prefix is what keeps this namespace disjoint from
 * the product's own `vMAJOR.MINOR.PATCH` release tags: a product tag is refused
 * here, and a workflow tag is refused by `publish-homebrew-release.mjs`.
 */
export function versionForWorkflowTag(tag) {
	if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX)) {
		fail(`tag must be exactly ${TAG_PREFIX}MAJOR.MINOR.PATCH, got ${JSON.stringify(tag)}`);
	}
	return checkedVersion(tag.slice(TAG_PREFIX.length));
}

export function workflowAssetName(version) {
	return `${WORKFLOW_NAME}-${checkedVersion(version)}.tar.gz`;
}

/** The one address a version resolves to. */
export function workflowAssetUrl(version) {
	return `https://github.com/${TAP_REPOSITORY}/releases/download/${workflowTagFor(version)}/${workflowAssetName(version)}`;
}

/** The directory the archive unpacks into. */
export function packageDirectoryName(version) {
	return `${WORKFLOW_NAME}-${checkedVersion(version)}`;
}

/**
 * A payload path is canonical, repository-relative and made of ordinary
 * segments. Anything else — an absolute path, a `.` or `..` segment, a doubled
 * or trailing slash, a backslash — is refused rather than normalized, because
 * normalizing would silently publish something other than what was declared.
 */
export function checkedPayloadPath(path) {
	if (typeof path !== "string" || path === "") fail("a payload path must be a non-empty string");
	if (path.includes("\\")) fail(`payload path ${JSON.stringify(path)} is not canonical`);
	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			fail(`payload path ${JSON.stringify(path)} is not canonical and repository-relative`);
		}
	}
	return path;
}

function comparePaths(left, right) {
	return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function framed(value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return [length, bytes];
}

/**
 * The content digest over `[{ path, mode, content }]`, sorted by path here so
 * the caller's order cannot change the answer.
 */
export function payloadDigest(entries) {
	const hash = createHash(DIGEST_ALGORITHM);
	for (const entry of [...entries].sort(comparePaths)) {
		for (const part of [...framed(entry.path), ...framed(entry.mode), ...framed(entry.content)]) {
			hash.update(part);
		}
	}
	return hash.digest("hex");
}

/** The mode an inventory records: git's, so a checkout's umask cannot reach it. */
export function recordedMode(executable) {
	return executable ? EXECUTABLE_MODE : REGULAR_MODE;
}

export function fileMode(mode) {
	return mode === EXECUTABLE_MODE ? 0o755 : 0o644;
}

export function manifestFor({ version, sourceRepository, sourceCommit, entries }) {
	return {
		manifestVersion: MANIFEST_VERSION,
		workflow: WORKFLOW_NAME,
		version: checkedVersion(version),
		source: { repository: sourceRepository, commit: sourceCommit },
		digest: {
			algorithm: DIGEST_ALGORITHM,
			framing: DIGEST_FRAMING,
			payload: payloadDigest(entries),
		},
		payload: [...entries]
			.sort(comparePaths)
			.map((entry) => ({ path: entry.path, mode: entry.mode })),
	};
}

export function manifestText(manifest) {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function exactKeys(value, keys) {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** Parse and validate a manifest, refusing anything this format cannot describe. */
export function readManifest(text) {
	let manifest;
	try {
		manifest = JSON.parse(text);
	} catch {
		fail("manifest is not valid JSON");
	}
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
		fail("manifest is not an object");
	}
	if (
		!exactKeys(manifest, ["manifestVersion", "workflow", "version", "source", "digest", "payload"]) ||
		manifest.manifestVersion !== MANIFEST_VERSION
	) {
		fail(`manifest must declare exactly version ${MANIFEST_VERSION}, workflow, version, source, digest and payload`);
	}
	if (typeof manifest.workflow !== "string" || manifest.workflow === "") {
		fail("manifest declares no workflow name");
	}
	checkedVersion(manifest.version);
	const source = manifest.source;
	if (
		source === null ||
		typeof source !== "object" ||
		Array.isArray(source) ||
		!exactKeys(source, ["repository", "commit"]) ||
		typeof source.repository !== "string" ||
		source.repository === "" ||
		typeof source.commit !== "string" ||
		!COMMIT.test(source.commit)
	) {
		fail("manifest source must name the repository and the 40-character source commit");
	}
	const digest = manifest.digest;
	if (
		digest === null ||
		typeof digest !== "object" ||
		Array.isArray(digest) ||
		!exactKeys(digest, ["algorithm", "framing", "payload"]) ||
		typeof digest.payload !== "string" ||
		digest.payload === ""
	) {
		fail("manifest digest must name the algorithm, the framing and the payload digest");
	}
	if (digest.algorithm !== DIGEST_ALGORITHM || digest.framing !== DIGEST_FRAMING) {
		fail(
			`manifest digest is ${digest.algorithm}/${digest.framing}, which this reader cannot recompute`,
		);
	}
	if (!Array.isArray(manifest.payload) || manifest.payload.length === 0) {
		fail("manifest payload inventory is empty");
	}
	let previous = null;
	for (const entry of manifest.payload) {
		if (
			entry === null ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			!exactKeys(entry, ["path", "mode"])
		) {
			fail("every manifest payload entry must carry exactly a path and a mode");
		}
		checkedPayloadPath(entry.path);
		if (entry.mode !== REGULAR_MODE && entry.mode !== EXECUTABLE_MODE) {
			fail(`manifest payload entry ${entry.path} records unsupported mode ${JSON.stringify(entry.mode)}`);
		}
		if (previous !== null && comparePaths({ path: previous }, { path: entry.path }) >= 0) {
			fail(`manifest payload inventory is not sorted and unique at ${entry.path}`);
		}
		previous = entry.path;
	}
	return manifest;
}

/** Every ordinary file under `directory`, as canonical relative paths. */
function payloadFiles(directory) {
	const found = [];
	const walk = (relative) => {
		const absolute = relative === "" ? directory : join(directory, relative);
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) found.push(child);
			else fail(`payload entry ${child} is not an ordinary file`);
		}
	};
	walk("");
	return found;
}

/**
 * The consumer's check: recompute the digest from an extracted package and
 * reject one whose payload disagrees with its manifest.
 *
 * It reads only `manifest.json` and `payload/`, never the declaration the
 * package was built from, so a project that never runs the builder can perform
 * it. Returns the validated manifest.
 */
export function verifyExtractedPackage(directory) {
	const manifest = readManifest(readFileSync(join(directory, MANIFEST_NAME), "utf8"));
	const root = join(directory, PAYLOAD_DIRECTORY);
	const present = payloadFiles(root);
	const declared = manifest.payload.map((entry) => entry.path);
	for (const path of present) {
		if (!declared.includes(path)) fail(`damaged package: payload carries undeclared entry ${path}`);
	}
	const entries = manifest.payload.map((entry) => {
		if (!present.includes(entry.path)) {
			fail(`damaged package: payload is missing declared entry ${entry.path}`);
		}
		const stat = lstatSync(join(root, entry.path));
		const mode = recordedMode((stat.mode & 0o111) !== 0);
		if (mode !== entry.mode) {
			fail(`damaged package: ${entry.path} is ${mode} on disk, but the manifest records ${entry.mode}`);
		}
		return { path: entry.path, mode: entry.mode, content: readFileSync(join(root, entry.path)) };
	});
	const digest = payloadDigest(entries);
	if (digest !== manifest.digest.payload) {
		fail(`damaged package: payload digest is ${digest}, but the manifest records ${manifest.digest.payload}`);
	}
	return manifest;
}

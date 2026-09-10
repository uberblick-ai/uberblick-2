#!/usr/bin/env node
/**
 * Publish one workflow package to the public tap.
 *
 * A workflow version resolves to exactly one address: the asset
 * `uberblick-workflow-<version>.tar.gz` on tag `workflow-v<version>` of
 * `uberblick-ai/homebrew-tap`. That tag namespace is disjoint from the product's
 * own `vMAJOR.MINOR.PATCH` releases, and the two artifacts never share a name,
 * so a consumer that knows the workflow name and version knows where to look
 * and cannot land on the product payload.
 *
 * The source repository is private and the artifact is public, so three
 * refusals matter more than the happy path: the package is built by a separate
 * credential-free step and only read here, a version already published from
 * another source commit is refused rather than replaced, and the run proves for
 * itself — with no credential — that what it published is fetchable at exactly
 * that address before it reports success.
 *
 * Services are injected so every one of those decisions is provable without a
 * token, a network or a live publication; `publish-workflow-package.test.mjs` is
 * where they are proven.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	WORKFLOW_NAME,
	TAP_REPOSITORY,
	verifyExtractedPackage,
	versionForWorkflowTag,
	workflowAssetName,
	workflowAssetUrl,
} from "./lib/workflow-package.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_REPOSITORY = "uberblick-ai/uberblick-2";

function fail(message) {
	throw new Error(`publish-workflow-package: ${message}`);
}

/**
 * The published release's body. The source repository stays private and the
 * artifact lives on the public tap, whose release targets a tap commit — so the
 * commit this version was published from is recorded here, and is what a later
 * run of the same tag is checked against.
 */
export function releaseBody(version, sourceCommit) {
	return `Uberblick workflow ${version}\n\nSource-commit: ${sourceCommit}\n`;
}

function sourceCommitOf(release) {
	return /^Source-commit: ([0-9a-f]{40})$/m.exec(release.body ?? "")?.[1] ?? null;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertTagContext({ tag, repository, refType, refName, headSha, tagSha, workflowSha }) {
	if (repository !== SOURCE_REPOSITORY || refType !== "tag" || refName !== tag) {
		fail("publishing requires this repository's matching GitHub Actions tag ref");
	}
	if (tagSha !== headSha || workflowSha !== headSha) {
		fail(`tag ${tag} resolves to ${tagSha}, but the checked-out commit is ${headSha}`);
	}
}

/** A version is published once, from one source commit, and never replaced. */
function assertRelease(release, tag, expectedAssetName, headSha) {
	if (release.tag_name !== tag || release.draft === true || release.prerelease === true) {
		fail(`release ${tag} disagrees with the immutable workflow-tag contract`);
	}
	const publishedFrom = sourceCommitOf(release);
	if (publishedFrom !== headSha) {
		fail(
			`release ${tag} was published from source commit ${publishedFrom ?? "(none recorded)"}, not ${headSha}`,
		);
	}
	const assets = release.assets.filter((asset) => asset.name === expectedAssetName);
	if (assets.length > 1) fail(`release ${tag} has more than one ${expectedAssetName} asset`);
	return assets[0] ?? null;
}

function assertManifest(manifest, version, headSha) {
	if (manifest.workflow !== WORKFLOW_NAME) {
		fail(`package declares workflow ${JSON.stringify(manifest.workflow)}, not ${WORKFLOW_NAME}`);
	}
	if (manifest.version !== version) {
		fail(`package declares version ${JSON.stringify(manifest.version)}, expected ${version}`);
	}
	if (manifest.source.repository !== SOURCE_REPOSITORY) {
		fail(`package source repository must be ${SOURCE_REPOSITORY}`);
	}
	if (manifest.source.commit !== headSha) {
		fail(`package was built from source commit ${manifest.source.commit}, not ${headSha}`);
	}
}

/**
 * Publish one workflow version. Returns what became of it: `published` for a
 * fresh upload, `no-op` where this exact package is already at that address.
 */
export async function publishWorkflowPackage(input, services) {
	const version = versionForWorkflowTag(input.tag);
	const name = workflowAssetName(version);
	const url = workflowAssetUrl(version);
	assertTagContext(input);

	const destination = await services.getTapRepository();
	if (destination.visibility !== "public") {
		fail(`${TAP_REPOSITORY} must be public before publishing a workflow package`);
	}
	if (!destination.initialized) {
		fail(
			`${TAP_REPOSITORY} has no commits; seed it with one commit on its default branch before the first release`,
		);
	}

	const release = await services.getRelease(input.tag);
	const existingAsset = release === null ? null : assertRelease(release, input.tag, name, input.headSha);

	let bytes;
	if (existingAsset !== null) {
		if (existingAsset.state !== "uploaded") {
			fail(
				`release ${input.tag}'s ${name} asset is not completely uploaded; delete the incomplete asset before re-running`,
			);
		}
		if (existingAsset.browser_download_url !== url) {
			fail(`release ${input.tag}'s asset URL disagrees with the one address ${version} resolves to`);
		}
		bytes = await services.downloadAsset(existingAsset.browser_download_url);
		assertManifest(await services.packageManifest(bytes), version, input.headSha);
	} else {
		if (release !== null && release.assets.length > 0) {
			fail(`release ${input.tag} has assets, but not ${name}`);
		}
		bytes = await services.readPackage(version);
		assertManifest(await services.packageManifest(bytes), version, input.headSha);
		const targetRelease =
			release ?? (await services.createRelease(input.tag, releaseBody(version, input.headSha)));
		await services.uploadAsset(targetRelease.upload_url, name, bytes);
	}

	// The receipt this run owes itself: the address a consumer resolves, fetched
	// with no credential, carrying the bytes this run published. Reported before
	// success, never after it.
	const fetched = await services.fetchPublicAsset(url);
	if (sha256(fetched) !== sha256(bytes)) {
		fail(`${url} does not serve the ${name} this run published`);
	}
	const outcome = existingAsset === null ? "published" : "no-op";
	services.log(`${outcome}: ${name} is anonymously fetchable at ${url}`);
	return { outcome, version, url };
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
	}
	return result.stdout.trim();
}

/**
 * The package this run publishes is the one the credential-free build step left
 * behind; this step builds nothing.
 */
function readPackage(version) {
	const archive = join(REPOSITORY_ROOT, "dist", workflowAssetName(version));
	try {
		return readFileSync(archive);
	} catch {
		return fail(`${archive} is missing; the build step must run before the publish step`);
	}
}

/** The manifest of a package, read the way a consumer reads one. */
function packageManifest(bytes) {
	const scratch = mkdtempSync(join(tmpdir(), "uberblick-workflow-publish-"));
	try {
		const archive = join(scratch, "package.tar.gz");
		writeFileSync(archive, bytes);
		const extracted = join(scratch, "extracted");
		mkdirSync(extracted);
		run("tar", ["-xzf", archive, "-C", extracted]);
		const roots = readdirSync(extracted, { withFileTypes: true });
		if (roots.length !== 1 || !roots[0].isDirectory()) {
			fail("a workflow package unpacks into exactly one directory");
		}
		return verifyExtractedPackage(join(extracted, roots[0].name));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function githubRequest(path, token, options = {}) {
	const url = path.startsWith("https://")
		? path
		: `${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`;
	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			...(options.body === undefined
				? {}
				: { "content-type": options.contentType ?? "application/json" }),
		},
		body:
			options.body === undefined
				? undefined
				: options.contentType === "application/gzip"
					? options.body
					: JSON.stringify(options.body),
	});
	if (options.notFound === true && response.status === 404) return null;
	if (!response.ok) {
		fail(
			`GitHub ${options.method ?? "GET"} ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
	}
	return response.status === 204 ? null : response.json();
}

function productionServices() {
	const tapToken = process.env.HOMEBREW_TAP_TOKEN;
	if (tapToken === undefined || tapToken === "") {
		fail("HOMEBREW_TAP_TOKEN is required to publish a workflow package");
	}
	return {
		readPackage: async (version) => readPackage(version),
		packageManifest: async (bytes) => packageManifest(bytes),
		getTapRepository: async () => {
			const tap = await githubRequest(`/repos/${TAP_REPOSITORY}`, tapToken);
			const branch = await githubRequest(
				`/repos/${TAP_REPOSITORY}/branches/${tap.default_branch}`,
				tapToken,
				{ notFound: true },
			);
			return { visibility: tap.visibility, initialized: branch !== null };
		},
		getRelease: (tag) =>
			githubRequest(`/repos/${TAP_REPOSITORY}/releases/tags/${tag}`, tapToken, { notFound: true }),
		createRelease: (tag, body) =>
			githubRequest(`/repos/${TAP_REPOSITORY}/releases`, tapToken, {
				method: "POST",
				body: { tag_name: tag, name: tag, body, draft: false, prerelease: false },
			}),
		uploadAsset: (uploadUrl, name, bytes) =>
			githubRequest(`${uploadUrl.replace("{?name,label}", "")}?name=${encodeURIComponent(name)}`, tapToken, {
				method: "POST",
				contentType: "application/gzip",
				body: bytes,
			}),
		downloadAsset: async (url) => {
			const response = await fetch(url, { headers: { authorization: `Bearer ${tapToken}` } });
			if (!response.ok) fail(`published asset download returned ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		},
		// No credential, on purpose: this is the anonymous consumer's fetch.
		fetchPublicAsset: async (url) => {
			const response = await fetch(url);
			if (!response.ok) {
				fail(`published asset is not anonymously downloadable: ${url} returned ${response.status}`);
			}
			return Buffer.from(await response.arrayBuffer());
		},
		log: (message) => process.stdout.write(`${message}\n`),
	};
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length !== 1) {
		fail("usage: mise run publish-workflow-package -- workflow-vMAJOR.MINOR.PATCH");
	}
	const tag = args[0];
	const headSha = run("git", ["rev-parse", "HEAD"]);
	await publishWorkflowPackage(
		{
			tag,
			repository: process.env.GITHUB_REPOSITORY,
			refType: process.env.GITHUB_REF_TYPE,
			refName: process.env.GITHUB_REF_NAME,
			headSha,
			tagSha: run("git", ["rev-parse", `${tag}^{commit}`]),
			workflowSha: process.env.GITHUB_SHA,
		},
		productionServices(),
	);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

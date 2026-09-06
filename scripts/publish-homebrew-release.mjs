#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_REPOSITORY = "uberblick-ai/uberblick-2";
const TAP_REPOSITORY = "uberblick-ai/homebrew-tap";
const TAP_FORMULA_PATH = "Formula/uberblick.rb";
const RELEASE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function fail(message) {
	throw new Error(`publish-homebrew-release: ${message}`);
}

export function versionForTag(tag) {
	const match = RELEASE_TAG.exec(tag);
	if (match === null) {
		fail(`tag must be exactly vMAJOR.MINOR.PATCH, got ${JSON.stringify(tag)}`);
	}
	return tag.slice(1);
}

function assetName(version) {
	return `uberblick-${version}.tar.gz`;
}

function assetUrl(tag, version) {
	return `https://github.com/${TAP_REPOSITORY}/releases/download/${tag}/${assetName(version)}`;
}

/**
 * The published release's body. The source repository stays private and the
 * artifact lives on the public tap, whose release targets a tap commit — so the
 * commit this version was published from is recorded here, and is what a later
 * run of the same tag is checked against.
 */
export function releaseBody(version, sourceCommit) {
	return `Uberblick ${version}\n\nSource-commit: ${sourceCommit}\n`;
}

function sourceCommitOf(release) {
	return /^Source-commit: ([0-9a-f]{40})$/m.exec(release.body ?? "")?.[1] ?? null;
}

/**
 * The formula the tap holds for one version.
 *
 * `url` defaults to the published asset and is overridden only by
 * scripts/homebrew-upgrade-proof.mjs, which installs two locally built payloads
 * through this same text so its probe upgrades the formula a release publishes
 * rather than one written for the probe.
 */
export function formulaFor(tag, version, sha256, url = assetUrl(tag, version)) {
	return `class Uberblick < Formula
  desc "Local-first collaborative documents for people and agents"
  homepage "https://github.com/${SOURCE_REPOSITORY}"
  url "${url}"
  version "${version}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    inreplace libexec/"bin/ub", "#!/usr/bin/env node", "#!#{formula_opt_bin("node")}/node"
    bin.install_symlink libexec/"bin/ub"
    bin.install_symlink libexec/"bin/uberblick"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/ub --version").strip
    assert_equal version.to_s, shell_output("#{bin}/uberblick --version").strip
  end
end
`;
}

function formulaVersion(formula) {
	return /^\s*version "([^"]+)"\s*$/m.exec(formula)?.[1] ?? null;
}

function compareVersions(left, right) {
	const leftMatch = RELEASE_TAG.exec(`v${left}`);
	const rightMatch = RELEASE_TAG.exec(`v${right}`);
	if (leftMatch === null || rightMatch === null) {
		fail(`the tap formula has invalid version ${JSON.stringify(left)}`);
	}
	const a = leftMatch.slice(1);
	const b = rightMatch.slice(1);
	for (let index = 0; index < 3; index += 1) {
		if (a[index].length !== b[index].length) return a[index].length - b[index].length;
		const compared = a[index].localeCompare(b[index]);
		if (compared !== 0) return compared;
	}
	return 0;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertRelease(release, tag, expectedAssetName, headSha) {
	if (release.tag_name !== tag || release.draft === true || release.prerelease === true) {
		fail(`release ${tag} disagrees with the immutable stable-tag contract`);
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

function assertTagContext({ tag, dryRun, repository, refType, refName, headSha, tagSha, workflowSha }) {
	if (dryRun) return;
	if (repository !== SOURCE_REPOSITORY || refType !== "tag" || refName !== tag) {
		fail("publishing requires this repository's matching GitHub Actions tag ref");
	}
	if (tagSha !== headSha || workflowSha !== headSha) {
		fail(`tag ${tag} resolves to ${tagSha}, but the checked-out commit is ${headSha}`);
	}
}

/**
 * Publish one release. Services are injected so the irreversible boundary is
 * covered without giving pull-request CI a credential.
 */
export async function publishHomebrewRelease(input, services) {
	const version = versionForTag(input.tag);
	const name = assetName(version);
	assertTagContext(input);
	if (!input.dryRun) {
		const destination = await services.getTapRepository();
		if (destination.visibility !== "public") {
			fail(`${TAP_REPOSITORY} must be public before publishing a Homebrew release`);
		}
		if (!destination.initialized) {
			fail(
				`${TAP_REPOSITORY} has no commits; seed it with one commit on its default branch before the first release`,
			);
		}
	}

	const release = input.dryRun ? null : await services.getRelease(input.tag);
	const existingAsset =
		release === null ? null : assertRelease(release, input.tag, name, input.headSha);
	const existingFormula = input.dryRun ? null : await services.getTapFormula();

	let bytes;
	let published = false;
	if (existingAsset !== null) {
		if (existingAsset.state !== "uploaded") {
			fail(
				`release ${input.tag}'s ${name} asset is not completely uploaded; delete the incomplete asset before re-running`,
			);
		}
		if (existingAsset.browser_download_url !== assetUrl(input.tag, version)) {
			fail(`release ${input.tag}'s asset URL disagrees with the public formula URL`);
		}
		bytes = await services.downloadAsset(existingAsset.browser_download_url);
		const reportedVersion = await services.publishedArchiveVersion(bytes, name, version);
		if (reportedVersion !== version) {
			fail(`published payload reports ${JSON.stringify(reportedVersion)}, expected ${version}`);
		}
		await services.assertPublicAsset(existingAsset.browser_download_url);
		published = true;
	} else {
		if (release !== null && release.assets.length > 0) {
			fail(`release ${input.tag} has assets, but not ${name}`);
		}
		if (existingFormula !== null) {
			const currentVersion = formulaVersion(existingFormula.content);
			if (currentVersion === null || compareVersions(currentVersion, version) >= 0) {
				fail("the tap formula disagrees with an unpublished or older release tag");
			}
		}
		const archive = await services.buildArchive(version);
		const reportedVersion = await services.archiveVersion(archive, version);
		if (reportedVersion !== version) {
			fail(`payload reports ${JSON.stringify(reportedVersion)}, expected ${version}`);
		}
		bytes = await services.readArchive(archive);
	}

	const formula = formulaFor(input.tag, version, sha256(bytes));
	if (input.dryRun) {
		services.log(`Dry run: would publish ${name} at ${assetUrl(input.tag, version)}`);
		services.log(`Dry run: would commit ${TAP_FORMULA_PATH} to ${TAP_REPOSITORY}`);
		services.log(formula);
		return { outcome: "dry-run", formula };
	}

	if (published) {
		const currentVersion =
			existingFormula === null ? null : formulaVersion(existingFormula.content);
		if (
			existingFormula === null ||
			(currentVersion !== null && compareVersions(currentVersion, version) < 0)
		) {
			await services.putTapFormula(formula, existingFormula?.sha ?? null, version);
			return { outcome: "recovered-formula", formula };
		}
		if (existingFormula.content !== formula) {
			fail(`published asset ${name} and the tap formula disagree`);
		}
		services.log(`Release ${input.tag} and the tap formula already match; no changes.`);
		return { outcome: "no-op", formula };
	}

	const targetRelease =
		release ?? (await services.createRelease(input.tag, releaseBody(version, input.headSha)));
	await services.uploadAsset(targetRelease.upload_url, name, bytes);
	await services.assertPublicAsset(assetUrl(input.tag, version));
	await services.putTapFormula(formula, existingFormula?.sha ?? null, version);
	services.log(`Published ${input.tag} and committed ${TAP_FORMULA_PATH} to ${TAP_REPOSITORY}.`);
	return { outcome: "published", formula };
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} ${result.signal === null ? `exited ${result.status}` : `ended from ${result.signal}`}: ${result.stderr}`);
	}
	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function buildArchive(version) {
	run("mise", ["run", "build-install-payload", "--", version], { stdio: "inherit" });
	return join(REPOSITORY_ROOT, "dist", assetName(version));
}

function archiveVersion(archive, version) {
	const scratch = mkdtempSync(join(tmpdir(), "uberblick-release-check-"));
	try {
		run("tar", ["-xzf", archive, "-C", scratch]);
		return run(join(scratch, `uberblick-${version}`, "bin", "ub"), ["--version"]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const localServices = {
	buildArchive: async (version) => buildArchive(version),
	archiveVersion: async (archive, version) => archiveVersion(archive, version),
	publishedArchiveVersion: async (bytes, name, version) => {
		const scratch = mkdtempSync(join(tmpdir(), "uberblick-published-release-"));
		try {
			const archive = join(scratch, name);
			writeFileSync(archive, bytes);
			return archiveVersion(archive, version);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	readArchive: async (archive) => readFileSync(archive),
};

async function githubRequest(path, token, options = {}) {
	const url = path.startsWith("https://")
		? path
		: `${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`;
	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: {
			accept: options.accept ?? "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
			...(options.body === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
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
		fail(`GitHub ${options.method ?? "GET"} ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
	}
	return response.status === 204 ? null : response.json();
}

function productionServices() {
	const tapToken = process.env.HOMEBREW_TAP_TOKEN;
	if (tapToken === undefined || tapToken === "") {
		fail("HOMEBREW_TAP_TOKEN is required outside --dry-run");
	}
	return {
		...localServices,
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
			githubRequest(`/repos/${TAP_REPOSITORY}/releases/tags/${tag}`, tapToken, {
				notFound: true,
			}),
		getTapFormula: async () => {
			const entry = await githubRequest(
				`/repos/${TAP_REPOSITORY}/contents/${TAP_FORMULA_PATH}`,
				tapToken,
				{ notFound: true },
			);
			return entry === null
				? null
				: { sha: entry.sha, content: Buffer.from(entry.content, "base64").toString("utf8") };
		},
		downloadAsset: async (url) => {
			const response = await fetch(url, {
				headers: { authorization: `Bearer ${tapToken}` },
			});
			if (!response.ok) fail(`published asset download returned ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		},
		assertPublicAsset: async (url) => {
			const response = await fetch(url, { method: "HEAD" });
			if (!response.ok) {
				fail(`published asset is not anonymously downloadable: ${url} returned ${response.status}`);
			}
		},
		createRelease: (tag, body) =>
			githubRequest(`/repos/${TAP_REPOSITORY}/releases`, tapToken, {
				method: "POST",
				body: {
					tag_name: tag,
					name: tag,
					body,
					draft: false,
					prerelease: false,
				},
			}),
		uploadAsset: (uploadUrl, name, bytes) => {
			const url = `${uploadUrl.replace("{?name,label}", "")}?name=${encodeURIComponent(name)}`;
			return githubRequest(url, tapToken, {
				method: "POST",
				accept: "application/vnd.github+json",
				contentType: "application/gzip",
				body: bytes,
			});
		},
		putTapFormula: (formula, currentSha, version) =>
			githubRequest(`/repos/${TAP_REPOSITORY}/contents/${TAP_FORMULA_PATH}`, tapToken, {
				method: "PUT",
				body: {
					message: `uberblick ${version}`,
					content: Buffer.from(formula).toString("base64"),
					...(currentSha === null ? {} : { sha: currentSha }),
				},
			}),
		log: (message) => process.stdout.write(`${message}\n`),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const positional = args.filter((arg) => arg !== "--dry-run");
	if (positional.length !== 1) {
		fail("usage: mise run publish-homebrew-release -- vMAJOR.MINOR.PATCH [--dry-run]");
	}
	const tag = positional[0];
	const headSha = run("git", ["rev-parse", "HEAD"]);
	const services = dryRun
		? {
				...productionServicesForDryRun(),
				log: (message) => process.stdout.write(`${message}\n`),
			}
		: productionServices();
	await publishHomebrewRelease(
		{
			tag,
			dryRun,
			repository: process.env.GITHUB_REPOSITORY,
			refType: process.env.GITHUB_REF_TYPE,
			refName: process.env.GITHUB_REF_NAME,
			headSha,
			tagSha: dryRun ? headSha : run("git", ["rev-parse", `${tag}^{commit}`]),
			workflowSha: dryRun ? headSha : process.env.GITHUB_SHA,
		},
		services,
	);
}

function productionServicesForDryRun() {
	return {
		...localServices,
		getTapRepository: async () => fail("dry-run cannot read the tap repository"),
		getRelease: async () => null,
		getTapFormula: async () => null,
		downloadAsset: async () => fail("dry-run cannot download an existing asset"),
		assertPublicAsset: async () => fail("dry-run cannot probe a published asset"),
		createRelease: async () => fail("dry-run cannot create a release"),
		uploadAsset: async () => fail("dry-run cannot upload an asset"),
		putTapFormula: async () => fail("dry-run cannot update the tap"),
	};
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

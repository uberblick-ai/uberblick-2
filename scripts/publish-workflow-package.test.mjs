/**
 * The publisher's decisions, proven with injected services: no credential, no
 * network, no tag and nothing published.
 *
 * The happy path is the least interesting assertion here. What the tests are
 * for is the refusals a private source repository publishing a public artifact
 * owes: a version already published from another commit, a package that is not
 * the one this tag names, an address that is not the one a consumer resolves,
 * and an upload nobody without a credential can actually fetch.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { publishWorkflowPackage, releaseBody } from "./publish-workflow-package.mjs";
import { WORKFLOW_NAME } from "./lib/workflow-package.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAG = "workflow-v1.2.3";
const VERSION = "1.2.3";
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const BYTES = Buffer.from("workflow package bytes");
const ASSET_NAME = "uberblick-workflow-1.2.3.tar.gz";
const ASSET_URL = `https://github.com/uberblick-ai/homebrew-tap/releases/download/${TAG}/${ASSET_NAME}`;
const WORKFLOW_FILE = join(ROOT, ".github", "workflows", "release-homebrew.yml");
const workflowSkip = existsSync(WORKFLOW_FILE)
	? undefined
	: ".github/workflows is absent from this checkout, so the credential fence cannot be checked here";

function manifest(overrides = {}) {
	return {
		manifestVersion: 1,
		workflow: WORKFLOW_NAME,
		version: VERSION,
		source: { repository: "uberblick-ai/uberblick-2", commit: HEAD_SHA },
		digest: { algorithm: "sha256", framing: "uberblick-workflow-payload-v1", payload: "0".repeat(64) },
		payload: [{ path: "AGENTS.md", mode: "100644" }],
		...overrides,
	};
}

function input(overrides = {}) {
	return {
		tag: TAG,
		repository: "uberblick-ai/uberblick-2",
		refType: "tag",
		refName: TAG,
		headSha: HEAD_SHA,
		tagSha: HEAD_SHA,
		workflowSha: HEAD_SHA,
		...overrides,
	};
}

function uploadedAsset(overrides = {}) {
	return { name: ASSET_NAME, state: "uploaded", browser_download_url: ASSET_URL, ...overrides };
}

function services(overrides = {}) {
	const calls = [];
	const service = {
		calls,
		getTapRepository: async () => {
			calls.push("get tap");
			return { visibility: "public", initialized: true };
		},
		getRelease: async () => {
			calls.push("get release");
			return null;
		},
		readPackage: async () => {
			calls.push("read package");
			return BYTES;
		},
		packageManifest: async () => {
			calls.push("manifest");
			return manifest();
		},
		createRelease: async (_tag, body) => {
			calls.push("create release");
			service.body = body;
			return { upload_url: "https://uploads.example.invalid/assets{?name,label}" };
		},
		uploadAsset: async (_uploadUrl, name) => {
			calls.push(`upload ${name}`);
		},
		downloadAsset: async () => {
			calls.push("download");
			return BYTES;
		},
		fetchPublicAsset: async (url) => {
			calls.push(`anonymous fetch ${url}`);
			return BYTES;
		},
		log: (message) => {
			calls.push("log");
			service.logged = message;
		},
		...overrides,
	};
	return service;
}

test("a first publication uploads the built package and proves it is anonymously fetchable", async () => {
	const fake = services();
	const result = await publishWorkflowPackage(input(), fake);

	assert.deepEqual(result, { outcome: "published", version: VERSION, url: ASSET_URL });
	assert.deepEqual(fake.calls, [
		"get tap",
		"get release",
		"read package",
		"manifest",
		"create release",
		`upload ${ASSET_NAME}`,
		`anonymous fetch ${ASSET_URL}`,
		"log",
	]);
	// The source commit is recorded on the release, which is what a later run of
	// the same tag is checked against.
	assert.equal(fake.body, releaseBody(VERSION, HEAD_SHA));
	assert.match(fake.body, /^Source-commit: a{40}$/m);
});

test("a tag outside the workflow spelling never reaches the tap", async () => {
	for (const tag of ["v1.2.3", "workflow-v1.2", "workflow-v1.2.3-rc1", "workflow-1.2.3"]) {
		const fake = services();
		await assert.rejects(
			() => publishWorkflowPackage(input({ tag, refName: tag }), fake),
			/must be exactly workflow-vMAJOR\.MINOR\.PATCH|version must be exactly/,
			tag,
		);
		assert.deepEqual(fake.calls, [], tag);
	}
});

test("publishing requires this repository's own matching tag ref", async () => {
	for (const overrides of [
		{ repository: "someone-else/uberblick-2" },
		{ refType: "branch" },
		{ refName: "workflow-v1.2.4" },
		{ tagSha: OTHER_SHA },
		{ workflowSha: OTHER_SHA },
	]) {
		const fake = services();
		await assert.rejects(() => publishWorkflowPackage(input(overrides), fake), /tag/);
		assert.deepEqual(fake.calls, [], JSON.stringify(overrides));
	}
});

test("an unpublishable destination stops the run before anything is built or uploaded", async () => {
	for (const [tap, pattern] of [
		[{ visibility: "private", initialized: true }, /must be public/],
		[{ visibility: "public", initialized: false }, /seed it with one commit/],
	]) {
		const fake = services({
			getTapRepository: async () => {
				fake.calls.push("get tap");
				return tap;
			},
		});
		await assert.rejects(() => publishWorkflowPackage(input(), fake), pattern);
		assert.deepEqual(fake.calls, ["get tap"]);
	}
});

test("a version already published from another source commit is refused, never replaced", async () => {
	const fake = services({
		getRelease: async () => {
			fake.calls.push("get release");
			return {
				tag_name: TAG,
				body: releaseBody(VERSION, OTHER_SHA),
				assets: [uploadedAsset()],
			};
		},
	});
	await assert.rejects(
		() => publishWorkflowPackage(input(), fake),
		/was published from source commit b{40}, not a{40}/,
	);
	assert.deepEqual(fake.calls, ["get tap", "get release"]);
});

test("the same package already at that address is verified and left alone", async () => {
	const fake = services({
		getRelease: async () => {
			fake.calls.push("get release");
			return { tag_name: TAG, body: releaseBody(VERSION, HEAD_SHA), assets: [uploadedAsset()] };
		},
	});
	const result = await publishWorkflowPackage(input(), fake);
	assert.equal(result.outcome, "no-op");
	assert.deepEqual(fake.calls, [
		"get tap",
		"get release",
		"download",
		"manifest",
		`anonymous fetch ${ASSET_URL}`,
		"log",
	]);
});

test("an asset at any address but the one the version resolves to is refused", async () => {
	const fake = services({
		getRelease: async () => {
			fake.calls.push("get release");
			return {
				tag_name: TAG,
				body: releaseBody(VERSION, HEAD_SHA),
				assets: [
					uploadedAsset({
						browser_download_url: `https://github.com/uberblick-ai/uberblick-2/releases/download/${TAG}/${ASSET_NAME}`,
					}),
				],
			};
		},
	});
	await assert.rejects(
		() => publishWorkflowPackage(input(), fake),
		/asset URL disagrees with the one address 1\.2\.3 resolves to/,
	);
});

test("a package that is not the one this tag names is refused before the release exists", async () => {
	for (const [overrides, pattern] of [
		[{ version: "1.2.4" }, /declares version "1\.2\.4", expected 1\.2\.3/],
		[{ source: { repository: "uberblick-ai/uberblick-2", commit: OTHER_SHA } }, /built from source commit b{40}/],
		[{ workflow: "someone-elses-workflow" }, /declares workflow "someone-elses-workflow"/],
	]) {
		const fake = services({
			packageManifest: async () => {
				fake.calls.push("manifest");
				return manifest(overrides);
			},
		});
		await assert.rejects(() => publishWorkflowPackage(input(), fake), pattern);
		assert.deepEqual(fake.calls, ["get tap", "get release", "read package", "manifest"]);
	}
});

test("an upload nobody can fetch anonymously is reported as failure, not success", async () => {
	for (const fetchPublicAsset of [
		async () => {
			throw new Error("anonymous asset probe returned 404");
		},
		async () => Buffer.from("something else entirely"),
	]) {
		const fake = services({
			fetchPublicAsset: async (url) => {
				fake.calls.push("anonymous fetch");
				return fetchPublicAsset(url);
			},
		});
		await assert.rejects(
			() => publishWorkflowPackage(input(), fake),
			/anonymous asset probe returned 404|does not serve the uberblick-workflow-1\.2\.3\.tar\.gz this run published/,
		);
		// No success was reported: the run never reached its own log line.
		assert.equal(fake.calls.includes("log"), false);
	}
});

test("the credential reaches the upload boundary and not the build", { skip: workflowSkip }, () => {
	const workflow = readFileSync(WORKFLOW_FILE, "utf8");
	// Both namespaces reach the one job that holds the environment.
	assert.match(workflow, /^ {6}- "v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"$/m);
	assert.match(workflow, /^ {6}- "workflow-v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"$/m);
	assert.equal((workflow.match(/^\s+HOMEBREW_TAP_TOKEN:/gm) ?? []).length, 1);

	const steps = workflow.slice(workflow.indexOf("\n    steps:")).split(/^ {6}- /m).slice(1);
	const build = steps.findIndex((step) => step.includes("mise run build-workflow-package"));
	const publish = steps.findIndex((step) => step.includes("HOMEBREW_TAP_TOKEN"));
	assert.notEqual(build, -1);
	assert.notEqual(publish, -1);
	// The payload is assembled first, by a step whose environment holds nothing.
	assert.ok(build < publish);
	assert.equal(/^\s+env:/m.test(steps[build]), false);
	// One job, dispatching on the ref: a second job or workflow would be a second
	// declaration of the environment that holds the token.
	assert.match(steps[publish], /workflow-v\*\)\s+mise run publish-workflow-package/);
	assert.match(steps[publish], /mise run publish-homebrew-release/);
});


test("a package attributed to another repository is refused before publication", async () => {
	const fake = services({ packageManifest: async () => manifest({ source: { repository: "someone-else/not-this-source", commit: HEAD_SHA } }) });
	await assert.rejects(() => publishWorkflowPackage(input(), fake), /source repository must be/);
	assert.equal(fake.calls.includes("create release"), false);
	assert.equal(fake.calls.some((call) => call.startsWith("upload ")), false);
});

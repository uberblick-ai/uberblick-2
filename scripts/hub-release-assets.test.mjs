import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHubReleaseAssets } from "./hub-release-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digests = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];

test("downloaded files retain the image payload's services and volume identities", () => {
	const assets = readHubReleaseAssets(root, digests);
	assert.deepEqual(Object.keys(assets).sort(), ["compose.yml", "remote.env.example", "remote.https.yml", "remote.tailscale.yml"]);
	const downloaded = assets["compose.yml"].toString();
	const fixed = readFileSync(resolve(root, "compose.release.yml"), "utf8")
		.replaceAll("__HUB_IMAGE__", `ghcr.io/uberblick-ai/hub@${digests[0]}`)
		.replaceAll("__WEB_IMAGE__", `ghcr.io/uberblick-ai/hub-web@${digests[1]}`);
	assert.equal(downloaded, fixed);
	for (const name of ["remote.https.yml", "remote.tailscale.yml"]) {
		assert.deepEqual(assets[name], readFileSync(resolve(root, name)));
	}
});

test("download route settings never leak into the legacy client's template", () => {
	const legacy = readFileSync(resolve(root, "remote.env.example"), "utf8");
	assert.doesNotMatch(legacy, /^(?:COMPOSE_FILE|HUB_VERSION)=/m);
	const downloaded = readHubReleaseAssets(root, digests)["remote.env.example"].toString();
	assert.match(downloaded, /^HUB_VERSION=$/m);
	assert.match(downloaded, /^COMPOSE_FILE=compose.yml$/m);
	assert.match(downloaded, /COMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml/);
	assert.doesNotMatch(downloaded, /wrapper selects|keep working without edits/);
});

test("download generation refuses missing or malformed image-index digests", () => {
	for (const invalid of [undefined, [], [digests[0]], [...digests, digests[0]],
		[undefined, digests[1]], ["sha256:invalid", digests[1]], [digests[0], "hub:1.2.3"]]) {
		assert.throws(() => readHubReleaseAssets(root, invalid), /two sha256 image-index digests/);
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHubReleaseAssets } from "./hub-release-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("downloaded files retain the image payload's services and volume identities", () => {
	const assets = readHubReleaseAssets(root);
	assert.deepEqual(Object.keys(assets).sort(), ["compose.yml", "remote.env.example", "remote.https.yml", "remote.tailscale.yml"]);
	const downloaded = assets["compose.yml"].toString();
	const fixed = readFileSync(resolve(root, "compose.release.yml"), "utf8")
		.replaceAll("__HUB_IMAGE__", "ghcr.io/uberblick-ai/hub:0.4.8")
		.replaceAll("__WEB_IMAGE__", "ghcr.io/uberblick-ai/hub-web:0.4.8");
	assert.equal(downloaded.replaceAll(`\${HUB_VERSION:?Set HUB_VERSION in .env to a hub release version}`, "0.4.8"), fixed);
	for (const name of ["remote.https.yml", "remote.tailscale.yml"]) {
		assert.deepEqual(assets[name], readFileSync(resolve(root, name)));
	}
});

test("download route settings never leak into the legacy client's template", () => {
	const legacy = readFileSync(resolve(root, "remote.env.example"), "utf8");
	assert.doesNotMatch(legacy, /^(?:COMPOSE_FILE|HUB_VERSION)=/m);
	const downloaded = readHubReleaseAssets(root)["remote.env.example"].toString();
	assert.match(downloaded, /^HUB_VERSION=$/m);
	assert.match(downloaded, /^COMPOSE_FILE=compose.yml$/m);
	assert.match(downloaded, /COMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml/);
	assert.doesNotMatch(downloaded, /wrapper selects|keep working without edits/);
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function pinnedImageRefs(digests) {
	if (!Array.isArray(digests) || digests.length !== 2 ||
		digests.some((digest) => typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest))) {
		throw new Error("hub-release-assets: two sha256 image-index digests are required");
	}
	return ["ghcr.io/uberblick-ai/hub", "ghcr.io/uberblick-ai/hub-web"]
		.map((repository, index) => `${repository}@${digests[index]}`);
}

// Installed clients use versioned tags in the image payload. Downloads pin the
// indexes verified by the release workflow, independently of deployment settings.
export function readHubReleaseAssets(root, digests) {
	const [hubImage, webImage] = pinnedImageRefs(digests);
	const read = (name) => readFileSync(join(root, name), "utf8");
	const compose = read("compose.release.yml")
		.replaceAll("__HUB_IMAGE__", hubImage)
		.replaceAll("__WEB_IMAGE__", webImage);
	const header = `# Downloaded Compose deployment. compose.yml selects the release's images.
# Record the release here for setup-hub; this value does not select images.
HUB_VERSION=

# Select the route with this setting and the hostname/IP settings below.
# Loopback HTTP:
COMPOSE_FILE=compose.yml
# Public DNS HTTPS: COMPOSE_FILE=compose.yml:remote.https.yml
# Tailscale HTTPS: COMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml

`;
	const env = read("remote.env.example")
		.replace("The wrapper selects the release's HTTPS files.", "Select the HTTPS route with COMPOSE_FILE above.")
		.replace("keep working without edits.", "also require the Tailscale COMPOSE_FILE selection above.");
	return {
		"compose.yml": Buffer.from(compose),
		"remote.env.example": Buffer.from(header + env),
		"remote.https.yml": Buffer.from(read("remote.https.yml")),
		"remote.tailscale.yml": Buffer.from(read("remote.tailscale.yml")),
	};
}

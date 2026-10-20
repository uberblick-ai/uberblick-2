import { readFileSync } from "node:fs";
import { join } from "node:path";

// The image payload stays fixed-version for installed clients. Downloaded
// deployments use the same service model with an explicit operator version.
export function readHubReleaseAssets(root) {
	const read = (name) => readFileSync(join(root, name), "utf8");
	const version = `\${HUB_VERSION:?Set HUB_VERSION in .env to a hub release version}`;
	const compose = read("compose.release.yml")
		.replaceAll("__HUB_IMAGE__", `ghcr.io/uberblick-ai/hub:${version}`)
		.replaceAll("__WEB_IMAGE__", `ghcr.io/uberblick-ai/hub-web:${version}`);
	const header = `# Downloaded Compose deployment. Set an explicit published version, e.g. 0.4.8.
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

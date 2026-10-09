#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { build } = createRequire(join(root, "packages/cli/package.json"))("esbuild");

async function bundle(entry, output) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node26",
		minify: true,
		sourcemap: false,
	});
}

async function main() {
	const [output, version, sourceCommit, protocolVersion, hubImage, webImage] = process.argv.slice(2);
	if (!output || process.argv.slice(2).length !== 6) {
		throw new Error("usage: build-hub-release-payload <output> <version> <commit> <protocol> <hub-image> <web-image>");
	}
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
		!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) {
		throw new Error("release version and full source commit are required");
	}
	const protocol = readFileSync(join(root, "packages/hub/src/protocol.ts"), "utf8")
		.match(/export const SYNC_PROTOCOL_VERSION = ([1-9]\d*);/);
	if (protocol === null || protocol[1] !== protocolVersion) {
		throw new Error("HUB_SYNC_PROTOCOL_VERSION must match the source SYNC_PROTOCOL_VERSION");
	}
	for (const image of [hubImage, webImage]) {
		if (!/^ghcr\.io\/uberblick-ai\/[a-z0-9][a-z0-9.-]*:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(image ?? "") ||
			!image.endsWith(`:${version}`)) {
			throw new Error("release image references must name this version under ghcr.io/uberblick-ai");
		}
	}
	const destination = resolve(output);
	mkdirSync(destination, { recursive: true });
	await Promise.all([
		bundle("packages/hub/src/main.ts", join(destination, "hub.mjs")),
		bundle("packages/hub/src/admin-setup-command.ts", join(destination, "hub-admin-setup.mjs")),
	]);
	const release = join(destination, "release");
	mkdirSync(release);
	for (const file of ["remote.env.example", "remote-settings.sh", "remote.https.yml", "remote.tailscale.yml", "REMOTE.md", "RELEASING.md"]) {
		cpSync(join(root, file), join(release, file));
	}
	mkdirSync(join(release, "bin"));
	for (const file of ["remote-compose.sh", "hub-backup.sh", "hub-restore.sh", "hub-admin-setup.sh"]) {
		cpSync(join(root, "bin", file), join(release, "bin", file));
	}
	const compose = readFileSync(join(root, "compose.release.yml"), "utf8")
		.replaceAll("__HUB_IMAGE__", hubImage).replaceAll("__WEB_IMAGE__", webImage);
	writeFileSync(join(release, "docker-compose.yml"), compose);
	writeFileSync(join(release, "release.json"), `${JSON.stringify({
		version, sourceCommit, syncProtocolVersion: Number(protocolVersion), images: { hub: hubImage, web: webImage },
	}, null, 2)}\n`);
	const environment = { ...process.env, UBERBLICK_RELEASE_WEB: "1" };
	for (const key of ["HUB_URL", "HUB_AUTH_TOKEN", "WORKSPACE_ID", "WORKSPACES", "UB_WORKSPACE_ID", "UB_HUB_URL",
		"WEB_HUB_URL", "WEB_WORKSPACES", "WEB_HOST", "HTTPS_BIND_IP", "LOOPBACK_PORT", "TAILSCALE_HOST", "TAILSCALE_IP"]) delete environment[key];
	const result = spawnSync("pnpm", ["--filter", "@uberblick/web", "exec", "vite", "build",
		"--outDir", join(destination, "web"), "--emptyOutDir"], {
		cwd: root, env: environment, stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`web build failed (${result.signal ?? result.status})`);
}

main().catch((error) => {
	console.error(`build-hub-release-payload: ${error.message}`);
	process.exitCode = 1;
});

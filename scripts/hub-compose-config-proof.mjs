#!/usr/bin/env node
// Resolve the downloaded files with real Compose, without pulling or starting
// services. This proof needs the host's Compose plugin, not a Docker daemon.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHubReleaseAssets } from "./hub-release-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digests = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
	`hub-compose-config-${process.env.UB_AGENTS_RUN ?? "local"}-`));
const env = { ...process.env };
for (const key of Object.keys(env)) {
	if (key.startsWith("COMPOSE_") || ["HUB_VERSION", "WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP",
		"HTTPS_BIND_IP", "LOOPBACK_PORT", "WEB_WORKSPACES", "WEB_HUB_URL", "HUB_GITHUB_CLIENT_ID"].includes(key)) delete env[key];
}
const compose = (args) => spawnSync("docker", ["compose", ...args], {
	cwd: scratch, env, encoding: "utf8", timeout: 30_000,
});

try {
	for (const [name, bytes] of Object.entries(readHubReleaseAssets(root, digests))) writeFileSync(join(scratch, name), bytes);
	for (const [route, settings, ip, port, bind] of [
		["compose.yml", "", "127.0.0.1", "8080", false],
		["compose.yml:remote.https.yml", "WEB_HOST=hub.example.com\nHTTPS_BIND_IP=192.0.2.10\n", "192.0.2.10", "443", false],
		["compose.yml:remote.https.yml:remote.tailscale.yml", "TAILSCALE_HOST=synthetic.tailnet.ts.net\nTAILSCALE_IP=100.64.0.2\n", "100.64.0.2", "443", true],
	]) {
		for (const versionSetting of ["", "HUB_VERSION=\n", "HUB_VERSION=0.4.8\n", "HUB_VERSION=99.99.99\n"]) {
			writeFileSync(join(scratch, ".env"), `${versionSetting}COMPOSE_FILE=${route}\n${settings}`);
			const rendered = compose(["config", "--format", "json"]);
			assert.equal(rendered.status, 0, rendered.stderr);
			const config = JSON.parse(rendered.stdout);
			assert.equal(config.name, "uberblick-remote");
			assert.equal(config.services.hub.image, `ghcr.io/uberblick-ai/hub@${digests[0]}`);
			assert.equal(config.services.caddy.image, `ghcr.io/uberblick-ai/hub-web@${digests[1]}`);
			assert.equal(config.services.hub.ports, undefined);
			assert.equal(config.services.hub.build, undefined);
			assert.equal(config.services.caddy.build, undefined);
			assert.equal(config.services.hub.platform, undefined);
			assert.equal(config.services.caddy.platform, undefined);
			assert.deepEqual(config.services.caddy.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target })),
				[{ host_ip: ip, published: port, target: port === "443" ? 443 : 80 }]);
			assert.equal(config.services.caddy.volumes.some((volume) => volume.type === "bind"), bind);
			if (bind) {
				assert.equal(config.services.caddy.user, "0:0");
				const socket = config.services.caddy.volumes.find((volume) => volume.type === "bind");
				assert.equal(socket.source, "/var/run/tailscale/tailscaled.sock");
				assert.equal(socket.target, "/var/run/tailscale/tailscaled.sock");
				assert.equal(socket.bind.create_host_path, false);
			}
			for (const volume of ["hub-data", "caddy-data", "caddy-config"]) {
				assert.equal(config.volumes[volume].name, `uberblick-remote_${volume}`);
			}
			writeFileSync(join(scratch, "docker-compose.yml"), readFileSync(join(root, "compose.release.yml"), "utf8")
				.replaceAll("    image:", "    platform: linux/amd64\n    image:")
				.replaceAll("__HUB_IMAGE__", "ghcr.io/uberblick-ai/hub:0.4.7")
				.replaceAll("__WEB_IMAGE__", "ghcr.io/uberblick-ai/hub-web:0.4.7"));
			const migration = compose(["config", "--format", "json"]);
			assert.equal(migration.status, 0, migration.stderr);
			assert.deepEqual(JSON.parse(migration.stdout), config);
		}
		console.log(`Passed ${route}: pinned image pair independent of HUB_VERSION, ports, socket, volume identities and old docker-compose.yml migration.`);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

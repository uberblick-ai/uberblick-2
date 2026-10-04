import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = {
	HUB_AUTH_TOKEN: "synthetic_token-42",
	TAILSCALE_HOST: "synthetic.tailnet.ts.net",
	WEB_HUB_URL: "wss://synthetic.tailnet.ts.net/ws",
	WEB_WORKSPACES: "synthetic-00000000-0000-4000-8000-000000000001",
};

function execute(script, overrides = {}, args = []) {
	return spawnSync("sh", [join(root, script), ...args], {
		cwd: root, env: { ...process.env, ...settings, ...overrides }, encoding: "utf8",
	});
}

test("service entrypoints refuse every unsafe document setting before executing their service", () => {
	for (const key of Object.keys(settings)) {
		for (const invalid of ['bad"value', "bad\\value", "bad value", "bad\nvalue", "badévalue"]) {
			const hub = execute("hub-release-entrypoint.sh", { [key]: invalid }, ["sh", "-c", "printf SERVICE_STARTED"]);
			const web = execute("web-release-entrypoint.sh", { [key]: invalid }, ["version"]);
			for (const result of [hub, web]) {
				assert.equal(result.status, 1, `${key} must refuse ${JSON.stringify(invalid)}`);
				assert.ok(result.stderr.includes(key), result.stderr);
				assert.ok(!result.stdout.includes("SERVICE_STARTED"));
				assert.ok(!result.stderr.includes(invalid), "refusal must not print the unsafe value");
			}
		}
	}
});

test("hub guard preserves valid startup command and exit status", () => {
	const result = execute("hub-release-entrypoint.sh", {}, ["sh", "-c", "printf SERVICE_STARTED; exit 7"]);
	assert.equal(result.status, 7);
	assert.equal(result.stdout, "SERVICE_STARTED");
});

test("web only aliases checked operator inputs, including its checked host default", () => {
	const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
	const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
	const scratch = mkdtempSync(join(scratchRoot, `hub-runtime-${run}-`));
	try {
		for (const file of ["web-release-entrypoint.sh", "remote-settings.sh"]) cpSync(join(root, file), join(scratch, file));
		writeFileSync(join(scratch, "caddy"), '#!/bin/sh\nprintf "%s\\n%s\\n" "$HUB_URL" "$WORKSPACES"\n', { mode: 0o755 });
		for (const endpoint of [settings.WEB_HUB_URL, ""]) {
			const result = spawnSync("sh", [join(scratch, "web-release-entrypoint.sh"), "run"], {
				env: { ...process.env, ...settings, WEB_HUB_URL: endpoint,
					HUB_URL: 'unchecked"legacy', WORKSPACES: 'unchecked"legacy', PATH: `${scratch}:${process.env.PATH}` },
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, `${endpoint || `wss://${settings.TAILSCALE_HOST}/ws`}\n${settings.WEB_WORKSPACES}\n`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("release stack uses exact images, existing persistent volumes and only the Tailscale HTTPS binding", () => {
	const compose = readFileSync(join(root, "compose.release.yml"), "utf8");
	assert.match(compose, /^name: uberblick-remote$/m);
	assert.doesNotMatch(compose, /\bbuild:/);
	assert.match(compose, /image: __HUB_IMAGE__/);
	assert.match(compose, /image: __WEB_IMAGE__/);
	assert.deepEqual([...compose.matchAll(/^ {4}ports:$/gm)].map((match) => match[0]), ["    ports:"]);
	assert.match(compose, /"\$\{TAILSCALE_IP:\?set TAILSCALE_IP in \.env\}:443:443"/);
	for (const volume of ["hub-data", "caddy-data", "caddy-config"]) assert.match(compose, new RegExp(`^  ${volume}:$`, "m"));
});

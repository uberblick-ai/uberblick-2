import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = {
	TAILSCALE_HOST: "synthetic.tailnet.ts.net",
	TAILSCALE_IP: "100.64.0.2",
	WEB_HUB_URL: "wss://synthetic.tailnet.ts.net/ws",
	WEB_WORKSPACES: "synthetic-00000000-0000-4000-8000-000000000001",
};

function execute(script, overrides = {}, args = [], cwd = root) {
	return spawnSync("sh", [join(root, script), ...args], {
		cwd, env: { ...process.env, ...settings, ...overrides }, encoding: "utf8",
	});
}

test("service entrypoints refuse every unsafe document setting before executing their service", () => {
	for (const key of [...Object.keys(settings), "WEB_HOST", "HTTPS_BIND_IP", "LOOPBACK_PORT"]) {
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

test("hub startup needs no signing secret and ignores a legacy secret", () => {
	const result = execute("hub-release-entrypoint.sh", { HUB_AUTH_TOKEN: 'unused"legacy-secret' }, ["sh", "-c", "printf SERVICE_STARTED; exit 7"]);
	assert.equal(result.status, 7);
	assert.equal(result.stdout, "SERVICE_STARTED");
});

test("web derives HTTP or HTTPS only from validated settings, ignoring unchecked aliases", () => {
	const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
	const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
	const scratch = mkdtempSync(join(scratchRoot, `hub-runtime-${run}-`));
	try {
		for (const file of ["web-release-entrypoint.sh", "remote-settings.sh"]) cpSync(join(root, file), join(scratch, file));
		writeFileSync(join(scratch, "caddy"), '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$WEB_SITE" "$HUB_URL" "$WORKSPACES"\n', { mode: 0o755 });
		for (const [overrides, site, endpoint] of [
			[{}, settings.TAILSCALE_HOST, settings.WEB_HUB_URL],
			[{ WEB_HUB_URL: "" }, settings.TAILSCALE_HOST, `wss://${settings.TAILSCALE_HOST}/ws`],
			[{ TAILSCALE_HOST: "", WEB_HOST: "hub.example.com", WEB_HUB_URL: "" }, "hub.example.com", "wss://hub.example.com/ws"],
			[{ TAILSCALE_HOST: "", TAILSCALE_IP: "", WEB_HUB_URL: "" }, "http://localhost:80, http://127.0.0.1:80", "ws://localhost:8080/ws"],
			[{ TAILSCALE_HOST: "", TAILSCALE_IP: "", WEB_HUB_URL: "", LOOPBACK_PORT: "8123" }, "http://localhost:80, http://127.0.0.1:80", "ws://localhost:8123/ws"],
		]) {
			const result = spawnSync("sh", [join(scratch, "web-release-entrypoint.sh"), "run"], {
				env: { ...process.env, ...settings, ...overrides,
					WEB_SITE: 'unchecked"legacy', HUB_URL: 'unchecked"legacy', WORKSPACES: 'unchecked"legacy', PATH: `${scratch}:${process.env.PATH}` },
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, `${site}\n${endpoint}\n${settings.WEB_WORKSPACES}\n`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("release defaults to loopback HTTP and HTTPS replaces that publication without changing volumes", () => {
	const compose = readFileSync(join(root, "compose.release.yml"), "utf8");
	assert.match(compose, /^name: uberblick-remote$/m);
	assert.doesNotMatch(compose, /\bbuild:/);
	assert.match(compose, /image: __HUB_IMAGE__/);
	assert.match(compose, /image: __WEB_IMAGE__/);
	assert.deepEqual([...compose.matchAll(/^ {4}ports:$/gm)].map((match) => match[0]), ["    ports:"]);
	assert.match(compose, /"127\.0\.0\.1:\$\{LOOPBACK_PORT:-8080\}:80"/);
	assert.doesNotMatch(compose, /tailscaled\.sock|user:|:\?set TAILSCALE/);
	const https = readFileSync(join(root, "remote.https.yml"), "utf8");
	assert.match(https, /ports: !override/);
	assert.match(https, /\$\{TAILSCALE_IP:-\$\{HTTPS_BIND_IP:-0\.0\.0\.0\}\}:443:443/);
	assert.doesNotMatch(https, /tailscaled\.sock|:80/);
	assert.match(readFileSync(join(root, "remote.tailscale.yml"), "utf8"), /create_host_path: false/);
	for (const volume of ["hub-data", "caddy-data", "caddy-config"]) assert.match(compose, new RegExp(`^  ${volume}:$`, "m"));
});

test("network values refuse unsafe routes before Docker or either service starts", () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `hub-network-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		writeFileSync(join(scratch, "release.json"), "{}\n");
		for (const [key, value] of [
			["WEB_HOST", "localhost"], ["WEB_HOST", "127.0.0.1"], ["WEB_HOST", "hub.local"], ["WEB_HOST", "home.arpa"], ["WEB_HOST", "hub.home.arpa"],
			["WEB_HOST", "hub..example.com"], ["WEB_HOST", "-hub.example.com"], ["WEB_HOST", "hub.example.com."],
			["TAILSCALE_HOST", "hub.internal"], ["TAILSCALE_IP", "0.0.0.0"],
			["HTTPS_BIND_IP", "256.1.2.3"], ["HTTPS_BIND_IP", "127.1"],
			["LOOPBACK_PORT", "0"], ["LOOPBACK_PORT", "65536"], ["LOOPBACK_PORT", "08080"],
			["WEB_HUB_URL", "ws://hub.example.com/ws"],
		]) {
			const overrides = { [key]: value };
			if (key === "WEB_HOST") overrides.TAILSCALE_HOST = "";
			for (const script of ["bin/remote-compose.sh", "hub-release-entrypoint.sh", "web-release-entrypoint.sh"]) {
				const result = execute(script, overrides, ["sh", "-c", "printf SERVICE_STARTED"], scratch);
				assert.equal(result.status, 1, `${script} must refuse ${key}=${value}`);
				assert.ok(result.stderr.includes(key), result.stderr);
				assert.doesNotMatch(result.stdout, /SERVICE_STARTED/);
			}
		}
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("release wrapper chooses routes for new and unchanged legacy env, and enforces host-only Engine floor", () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `hub-wrapper-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		mkdirSync(join(scratch, "bin"));
		cpSync(join(root, "bin/remote-compose.sh"), join(scratch, "bin/remote-compose.sh"));
		cpSync(join(root, "remote-settings.sh"), join(scratch, "remote-settings.sh"));
		writeFileSync(join(scratch, "release.json"), "{}\n");
		writeFileSync(join(scratch, "docker"), `#!/bin/sh
if [ "$1 $2" = "compose version" ]; then printf '%s\\n' "\${TEST_COMPOSE_VERSION:-2.24.4}";
elif [ "$1" = version ]; then printf '%s\\n' "\${TEST_ENGINE_VERSION:-28.0.0}";
else printf '%s\\n' "$@"; fi
`, { mode: 0o755 });
		const run = (overrides = {}, args = ["config"]) => spawnSync("sh", [join(scratch, "bin/remote-compose.sh"), ...args], {
			cwd: scratch, encoding: "utf8", env: { PATH: `${scratch}:${process.env.PATH}`, ...overrides },
		});
		assert.equal(run().stdout, "compose\n-f\ndocker-compose.yml\nconfig\n");
		assert.equal(run({ WEB_HOST: "hub.example.com" }).stdout, "compose\n-f\ndocker-compose.yml\n-f\nremote.https.yml\nconfig\n");
		for (const name of ["TAILSCALE_HOST", "WEB_HOST"]) {
			assert.equal(run({ [name]: settings.TAILSCALE_HOST, TAILSCALE_IP: settings.TAILSCALE_IP }).stdout,
				"compose\n-f\ndocker-compose.yml\n-f\nremote.https.yml\n-f\nremote.tailscale.yml\nconfig\n");
		}
		assert.equal(run({ COMPOSE_FILE: "operator-compose.yml", WEB_HOST: "hub.example.com" }).stdout, "compose\nconfig\n");
		for (const version of ["2.6.0", "2.24.3"]) assert.equal(run({ TEST_COMPOSE_VERSION: version }).status, 1);
		assert.equal(run({ TEST_ENGINE_VERSION: "27.5.0" }, ["up", "--detach"]).status, 1);
		assert.equal(run({ TEST_ENGINE_VERSION: "28.0.0" }, ["up", "--detach"]).status, 0);
		for (const args of [["--env-file", "network.env", "config"], ["--env-file=network.env", "config"]]) {
			const result = run({}, args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /--env-file.*\.env/);
			assert.equal(result.stdout, "");
		}
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("old checkout updater cannot reach Docker through parent discovery or COMPOSE_FILE after its stack is removed", () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `hub-old-updater-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		for (const route of ["parent", "COMPOSE_FILE"]) {
			const parent = join(scratch, route);
			const checkout = join(parent, "checkout");
			mkdirSync(join(checkout, "bin"), { recursive: true });
			cpSync(join(root, "bin/remote-compose.sh"), join(checkout, "bin/remote-compose.sh"));
			cpSync(join(root, "remote-settings.sh"), join(checkout, "remote-settings.sh"));
			const compose = join(parent, route === "parent" ? "compose.yaml" : "selected-compose.yaml");
			const state = join(parent, "existing-host-state");
			const log = join(parent, "docker-calls");
			const env = join(checkout, ".env");
			writeFileSync(compose, "name: unrelated-host-project\nservices:\n  unrelated:\n    image: synthetic-never-started:0.0.0\n");
			writeFileSync(state, "existing containers running; hub-data, caddy-data and caddy-config retained\n");
			writeFileSync(log, "");
			writeFileSync(env, "COMPOSE_PROJECT_NAME=existing-checkout\nTAILSCALE_HOST=synthetic.tailnet.ts.net\nTAILSCALE_IP=100.64.0.2\n");
			const original = [compose, state, env].map((file) => readFileSync(file, "utf8"));
			writeFileSync(join(checkout, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
if [ "$1 $2" = "compose version" ]; then printf '2.24.4\\n';
elif [ "$1" = version ]; then printf '28.0.0\\n';
else printf 'mutated\\n' > "$TEST_HOST_STATE"; fi
`, { mode: 0o755 });
			const result = spawnSync("sh", [join(checkout, "bin/remote-compose.sh"), "up", "--build", "--detach"], {
				cwd: checkout, encoding: "utf8", env: {
					PATH: `${checkout}:${process.env.PATH}`, TEST_DOCKER_LOG: log, TEST_HOST_STATE: state,
					...(route === "COMPOSE_FILE" ? { COMPOSE_FILE: compose } : {}),
				},
			});
			assert.equal(result.status, 1, route);
			assert.match(result.stderr, /Switch this host to a published release/);
			assert.equal(readFileSync(log, "utf8"), "", `${route} must refuse before any Docker call`);
			assert.deepEqual([compose, state, env].map((file) => readFileSync(file, "utf8")), original);
		}
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});

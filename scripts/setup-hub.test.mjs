import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["compose.yml", "remote.https.yml", "remote.tailscale.yml", "remote.env.example"];
const template = `# Published release template
HUB_VERSION=
COMPOSE_FILE=compose.yml
WEB_HOST=
TAILSCALE_HOST=
TAILSCALE_IP=
HTTPS_BIND_IP=
LOOPBACK_PORT=8080
WEB_WORKSPACES=
`;

// The external programs are fakes; /bin/bash executes the complete installer
// string exactly as the hosted curl command does, without contacting GitHub.
const fakeProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.TEST_SETUP_CONFIG, "utf8"));
fs.appendFileSync(process.env.TEST_SETUP_LOG, JSON.stringify({ command, args, cwd: process.cwd() }) + "\n");
const out = (value) => process.stdout.write(String(value));
const die = (value, code = 1) => { process.stderr.write(value + "\n"); process.exit(code); };
const dotenv = (file) => {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const literal = value.startsWith("'");
    if (literal) value = value.slice(1, value.lastIndexOf("'"));
    else if (value.startsWith('"')) value = value.slice(1, value.lastIndexOf('"'));
    else value = value.replace(/\s+#.*$/, "").trim();
    if (!literal) value = value.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)(?::-(.*?))?\}/g, (_, key, fallback) => process.env[key] ?? values[key] ?? fallback ?? "");
    values[match[1]] = value;
  }
  return values;
};
if (command === "id") out(config.uid + "\n");
else if (command === "uname") out((args.includes("-m") ? config.arch : config.os) + "\n");
else if (command === "sleep") process.exit(0);
else if (command === "tailscale") {
  if (config.tailscaleError) die(config.tailscaleError);
  out((config.tailscaleIp ?? "100.64.0.2") + "\n");
} else if (command === "ss") {
  for (const bind of config.listeners) out("LISTEN 0 128 " + bind.address + ":" + bind.port + " 0.0.0.0:*\n");
} else if (command === "netstat") {
  for (const bind of config.listeners) out("tcp4 0 0 " + bind.address.replace("0.0.0.0", "*") + "." + bind.port + " *.* LISTEN\n");
} else if (command === "curl") {
  const url = args.findLast((arg) => /^https?:/.test(arg));
  const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output");
  const outputFile = outputIndex < 0 ? undefined : args[outputIndex + 1];
  const writeIndex = args.findIndex((arg) => arg === "-w" || arg === "--write-out");
  const writeFormat = writeIndex < 0 ? "" : args[writeIndex + 1];
  let body = "";
  let status = 200;
  let effective = url;
  let failedTransfer = false;
  if (url.endsWith("/releases/latest")) effective = url.replace(/latest$/, "tag/hub-v" + config.latest);
  else if (url.includes("/releases?")) body = JSON.stringify(config.releases.map((version) => ({ tag_name: "hub-v" + version })), null, 2);
  else if (url.includes("/releases/tag/")) {
    if (!config.releases.includes(url.split("hub-v")[1])) status = 404;
  } else if (url.includes("/releases/download/")) {
    const name = url.split("/").at(-1);
    const version = url.match(/hub-v([^/]+)/)[1];
    body = name === "remote.env.example" ? config.template : "# " + name + " release " + version + "\nservices: {}\n";
    if (config.failAsset === name) { status = config.assetStatus ?? 503; body = "partial download"; failedTransfer = true; }
  } else die("Unexpected download URL: " + url);
  if (outputFile && outputFile !== "/dev/null") fs.writeFileSync(outputFile, body);
  else if (!outputFile) out(body);
  out(writeFormat.replace(/%\{http_code\}/g, String(status)).replace(/%\{url_effective\}/g, effective));
  if (status >= 400 || failedTransfer) die("curl: synthetic download failure", status >= 400 ? 22 : 18);
} else if (command === "docker") {
  const joined = args.join(" ");
  if (args[0] === "info") {
    if (config.daemonError) die(config.daemonError);
  } else if (args[0] === "version") out(config.engine + "\n");
  else if (joined === "compose version --short") out(config.compose + "\n");
  else if (args[0] === "ps") {
    const projectMatches = args.includes("label=com.docker.compose.project=" + (config.projectName ?? "uberblick-remote"));
    const containers = args.includes("-a") ? (projectMatches ? config.containers : []) : [...config.containers, ...config.foreignContainers];
    out(containers.map((container) => container.id).join("\n") + (containers.length ? "\n" : ""));
  }
  else if (args[0] === "inspect") {
    if (config.inspectError === args.at(-1)) die("synthetic Docker inspect failure");
    const container = [...config.containers, ...config.foreignContainers].find((candidate) => candidate.id === args.at(-1));
    if (!container) die("No such container");
    const format = args[args.indexOf("--format") + 1];
    if (format.includes("working_dir")) out(container.workingDir + "\n");
    else if (format.includes("com.docker.compose.service")) out(container.service + "\n");
    else if (format.includes("State.Running")) out(String(container.running) + "\n");
    else if (format.includes("NetworkSettings.Ports")) for (const bind of container.ports ?? []) out((bind.protocol ?? "80/tcp") + " " + bind.address + " " + bind.port + "\n");
    else die("Unexpected inspect format: " + format);
  } else if (args[0] === "exec") {
    if (args.at(-1) === "status") {
      if (config.oldStatusError) die(config.oldStatusError);
      out(config.oldStatus);
    } else if (args.at(-1) === "backup") {
      if (config.backupError) die(config.backupError);
      out("backup /data/backups/hub-before-update.tar.gz\nsha256 synthetic-checksum\n");
    } else die("Unexpected exec command: " + joined);
  } else if (args[0] === "compose") {
    if (args.includes("--environment")) die("unknown flag: --environment (Compose 2.24.4)");
    if (args.includes("--images")) {
      const input = fs.readFileSync(0, "utf8");
      const envFile = args[args.indexOf("--env-file") + 1];
      const values = dotenv(envFile);
      values.COMPOSE_PROJECT_NAME ??= input.match(/^name:\s*([A-Za-z0-9_-]+)/m)?.[1] ?? path.basename(process.cwd()).toLowerCase();
      for (const key of ["HUB_VERSION", "WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP", "LOOPBACK_PORT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]) out(key + "=" + (process.env[key] ?? values[key] ?? "") + "\n");
    } else if (args.includes("logs")) out("hub synthetic startup failure\ncaddy synthetic startup failure\n");
    else if (args.at(-1) === "status") {
      if (config.statusError) die(config.statusError);
      out(config.status);
    } else {
      const step = args.includes("config") ? "config" : args.includes("pull") ? "pull" : args.includes("up") ? "up" : undefined;
      if (!step) die("Unexpected Compose command: " + joined);
      if (config.failStep === step) die("synthetic " + step + " cause");
    }
  } else die("Unexpected Docker command: " + joined);
} else die("Unexpected fake command: " + command);
`;

function fixture(t, overrides = {}) {
	const scratch = realpathSync(mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `setup-hub-${process.env.UB_AGENTS_RUN ?? "test"}-`)));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const bin = join(scratch, "bin");
	const hub = join(scratch, "hub");
	const log = join(scratch, "calls.jsonl");
	const configPath = join(scratch, "config.json");
	mkdirSync(bin);
	writeFileSync(log, "");
	for (const command of ["curl", "docker", "uname", "id", "ss", "netstat", "tailscale", "sleep"]) {
		writeFileSync(join(bin, command), `#!${process.execPath}\n${fakeProgram}`, { mode: 0o755 });
	}
	const config = {
		uid: 1000, os: "Linux", arch: "x86_64", engine: "28.0.0", compose: "2.24.4",
		latest: "0.4.13", releases: ["0.4.13", "0.4.12", "0.4.11"], template,
		listeners: [], containers: [], foreignContainers: [],
		oldStatus: "hub running\nrelease 0.4.12\nprotocol 1\nclaimed no\n",
		status: "hub running\nrelease 0.4.13\nprotocol 1\nclaimed no\n",
		...overrides,
	};
	const save = () => writeFileSync(configPath, JSON.stringify(config));
	const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return {
		scratch, hub, config, calls,
		without(command) {
			const isolated = join(scratch, `without-${command}`);
			mkdirSync(isolated);
			for (const name of readdirSync(bin)) if (name !== command) symlinkSync(join(bin, name), join(isolated, name));
			for (const name of ["awk", "cat", "chmod", "cp", "mkdir", "mktemp", "mv", "rm", "rmdir", "sed", "tr"]) {
				const source = process.env.PATH.split(":").map((directory) => join(directory, name)).find((path) => existsSync(path));
				if (source) symlinkSync(source, join(isolated, name));
			}
			return isolated;
		},
		env(contents) {
			mkdirSync(hub, { recursive: true });
			writeFileSync(join(hub, ".env"), contents, { mode: 0o600 });
		},
		files() { return existsSync(hub) ? Object.fromEntries(readdirSync(hub).map((name) => [name, readFileSync(join(hub, name), "utf8")])) : {}; },
		run(overrides = {}, args = []) {
			save();
			const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HUB_DIR: hub, TEST_SETUP_CONFIG: configPath, TEST_SETUP_LOG: log };
			for (const name of ["HUB_HOST", "HUB_VERSION", "LOOPBACK_PORT", "HELP", "ALLOW_ROOT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP"]) delete env[name];
			return spawnSync("/bin/bash", ["-c", readFileSync(join(root, "setup-hub.sh"), "utf8"), "setup-hub.sh", ...args], {
				cwd: scratch, env: { ...env, ...overrides }, encoding: "utf8", timeout: 55_000,
			});
		},
	};
}

function passed(result) {
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
}

function failed(result, reason) {
	assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
	assert.match(result.stdout + result.stderr, reason);
}

function noDownloads(f) {
	assert.equal(f.calls().filter((call) => call.command === "curl").length, 0, "preflight must finish before network access");
}

function assertSetting(env, key, value) {
	assert.deepEqual(env.split("\n").filter((line) => line.startsWith(`${key}=`)), [`${key}=${value}`]);
}

test("hosted installer help and a truncated transfer perform no work", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { uid: 0, os: "Unsupported" });
	for (const [env, args] of [[{ HELP: "1" }, []], [{}, ["--help"]]]) {
		const result = f.run(env, args);
		passed(result);
		for (const variable of ["HUB_HOST", "HUB_VERSION", "HUB_DIR", "LOOPBACK_PORT", "ALLOW_ROOT", "HELP"]) assert.match(result.stdout, new RegExp(variable));
	}
	assert.equal(f.calls().length, 0);
	assert.deepEqual(f.files(), {});
	const script = readFileSync(join(root, "setup-hub.sh"), "utf8");
	const truncated = spawnSync("/bin/bash", ["-c", script.slice(0, script.lastIndexOf("\n", script.trimEnd().length - 1))], {
		cwd: f.scratch, env: { PATH: "/nonexistent" }, encoding: "utf8",
	});
	assert.equal(truncated.stdout, "");
	assert.deepEqual(f.files(), {});
});

test("preflight refuses root, unsupported hosts, old Docker/Compose, and an unreachable daemon without mutations", { timeout: 60_000 }, (t) => {
	for (const [config, reason] of [
		[{ uid: 0 }, /ALLOW_ROOT/],
		[{ os: "FreeBSD" }, /Linux|macOS/],
		[{ arch: "i686" }, /x86_64|arm64|aarch64/],
		[{ engine: "27.5.1" }, /28\.0\.0/],
		[{ compose: "2.20.0" }, /2\.24\.4/],
		[{ daemonError: "permission denied connecting to Docker daemon" }, /Docker|docker/],
	]) {
		const f = fixture(t, config);
		f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
		const before = f.files();
		const result = f.run();
		failed(result, reason);
		assert.match(result.stdout + result.stderr, /https:\/\/|[Dd]ocker|ALLOW_ROOT/);
		noDownloads(f);
		assert.deepEqual(f.files(), before);
	}
});

test("missing prerequisite programs name their repair and root runs require the explicit override", { timeout: 60_000 }, (t) => {
	for (const command of ["curl", "docker", "tailscale"]) {
		const f = fixture(t);
		const result = f.run({ PATH: f.without(command), ...(command === "tailscale" ? { HUB_HOST: "hub.tailnet.ts.net" } : {}) });
		failed(result, new RegExp(command, "i"));
		assert.match(result.stdout + result.stderr, /https:\/\//);
		noDownloads(f);
		assert.deepEqual(f.files(), {});
	}
	const rootUser = fixture(t, { uid: 0 });
	passed(rootUser.run({ ALLOW_ROOT: "1" }));
});

test("fresh loopback install stages all four assets, writes private env, and prints its claim instructions", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	const result = f.run({ LOOPBACK_PORT: "9191" });
	passed(result);
	const files = f.files();
	assert.deepEqual(Object.keys(files).sort(), [".env", ...assets].sort());
	assert.equal(statSync(join(f.hub, ".env")).mode & 0o777, 0o600);
	assertSetting(files[".env"], "HUB_VERSION", "0.4.13");
	assertSetting(files[".env"], "COMPOSE_FILE", "compose.yml");
	assertSetting(files[".env"], "LOOPBACK_PORT", "9191");
	assert.match(result.stdout, /http:\/\/(?:127\.0\.0\.1|localhost):9191/);
	assert.match(result.stdout, /ub auth login http:\/\//);
	assert.match(result.stdout, /first.*sign.in.*administrator/i);
	const actions = f.calls().filter((call) => call.command === "docker" && call.args[0] === "compose").map((call) => call.args.join(" "));
	const config = actions.findIndex((action) => action.includes("config --quiet"));
	const pull = actions.findIndex((action) => action.includes("pull"));
	const up = actions.findIndex((action) => action.includes("up -d"));
	const status = actions.findIndex((action) => action.includes("ub-hub status"));
	assert.ok(config >= 0 && config < pull && pull < up && up < status, actions.join("\n"));
});

test("public HTTPS checks only its selected bind and clears old Tailscale routing", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { listeners: [{ address: "127.0.0.1", port: 8080 }] });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml\nWEB_HOST=old.tailnet.ts.net\nTAILSCALE_HOST=old.tailnet.ts.net\nTAILSCALE_IP=100.64.0.2\nHTTPS_BIND_IP=192.0.2.4\nLOOPBACK_PORT=9090\nCUSTOM_VALUE='keep exactly'\n");
	const result = f.run({ HUB_HOST: "hub.example.com" });
	passed(result);
	const env = f.files()[".env"];
	assertSetting(env, "WEB_HOST", "hub.example.com");
	assertSetting(env, "COMPOSE_FILE", "compose.yml:remote.https.yml");
	assert.doesNotMatch(env, /^TAILSCALE_(?:IP|HOST)=.+$/m);
	assert.match(env, /^CUSTOM_VALUE='keep exactly'$/m);
	assert.match(result.stdout, /ub auth login https:\/\/hub\.example\.com/);
});

test("preserved effective routes check their actual address and port before downloads or file changes", { timeout: 60_000 }, (t) => {
	for (const [settings, bind] of [
		["COMPOSE_FILE=compose.yml\nLOOPBACK_PORT=9090\n", { address: "127.0.0.1", port: 9090 }],
		["COMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\n", { address: "0.0.0.0", port: 443 }],
		["COMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\nHTTPS_BIND_IP=192.0.2.4\n", { address: "192.0.2.4", port: 443 }],
		["COMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml\nWEB_HOST=hub.tailnet.ts.net\nTAILSCALE_IP=100.64.0.2\nHTTPS_BIND_IP=192.0.2.4\n", { address: "100.64.0.2", port: 443 }],
	]) {
		const f = fixture(t, { listeners: [bind] });
		f.env(`HUB_VERSION=0.4.12\n${settings}CUSTOM_VALUE=preserved\n`);
		const before = f.files();
		failed(f.run(), new RegExp(String(bind.port)));
		noDownloads(f);
		assert.deepEqual(f.files(), before);
	}
});

test("unrelated interfaces do not block a loopback or specifically bound HTTPS route", { timeout: 60_000 }, (t) => {
	for (const [settings, listener] of [
		["COMPOSE_FILE=compose.yml\n", { address: "192.0.2.8", port: 8080 }],
		["COMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\nHTTPS_BIND_IP=192.0.2.4\n", { address: "192.0.2.8", port: 443 }],
	]) {
		const f = fixture(t, { listeners: [listener] });
		f.env(`HUB_VERSION=0.4.13\n${settings}`);
		passed(f.run());
	}
});

test("legacy env derives its unchanged HTTPS route while preserving operator values literally", { timeout: 60_000 }, (t) => {
	for (const [settings, expected] of [
		["WEB_HOST=hub.example.com\n", "compose.yml:remote.https.yml"],
		["TAILSCALE_HOST=hub.tailnet.ts.net\nTAILSCALE_IP=100.64.0.2\n", "compose.yml:remote.https.yml:remote.tailscale.yml"],
	]) {
		const f = fixture(t);
		const marker = join(f.scratch, "must-not-execute");
		const custom = `# operator comment\nCUSTOM_VALUE='literal value with # hash'\nWEB_WORKSPACES=first,second\nUNTRUSTED_VALUE="$(touch ${marker})"\n`;
		f.env(`HUB_VERSION=0.4.12\n${settings}${custom}`);
		passed(f.run());
		const env = f.files()[".env"];
		assert.ok(env.includes(settings), env);
		assert.ok(env.includes(custom), env);
		assertSetting(env, "HUB_VERSION", "0.4.13");
		assertSetting(env, "COMPOSE_FILE", expected);
		assert.equal(existsSync(marker), false, "Compose dotenv must never be sourced as shell code");
	}
});

test("supplying only LOOPBACK_PORT keeps an existing HTTPS route and bind settings", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { listeners: [{ address: "127.0.0.1", port: 9191 }] });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\nHTTPS_BIND_IP=192.0.2.4\nLOOPBACK_PORT=9090\n");
	passed(f.run({ LOOPBACK_PORT: "9191" }));
	const env = f.files()[".env"];
	assertSetting(env, "COMPOSE_FILE", "compose.yml:remote.https.yml");
	assertSetting(env, "WEB_HOST", "hub.example.com");
	assertSetting(env, "HTTPS_BIND_IP", "192.0.2.4");
	assertSetting(env, "LOOPBACK_PORT", "9191");
});

test("quoted and interpolated dotenv settings keep their literal text and select the resolved HTTPS route", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { listeners: [{ address: "192.0.2.4", port: 443 }] });
	const settings = `HOST_ZONE=example.com\nWEB_HOST="hub.\${HOST_ZONE}"\nHTTPS_BIND_IP="192.0.2.4"\nCOMPOSE_FILE='compose.yml:remote.https.yml'\n`;
	f.env(`HUB_VERSION=0.4.12\n${settings}`);
	const before = f.files();
	failed(f.run(), /192\.0\.2\.4:443/);
	noDownloads(f);
	assert.deepEqual(f.files(), before);
	f.config.listeners = [];
	const result = f.run();
	passed(result);
	assert.match(result.stdout, /ub auth login https:\/\/hub\.example\.com/);
	assert.ok(f.files()[".env"].includes(settings));
});

test("Tailscale selection requires Linux and a working client and records the current IPv4 address", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { arch: "aarch64" });
	passed(f.run({ HUB_HOST: "hub.tailnet.ts.net" }));
	const env = f.files()[".env"];
	assertSetting(env, "WEB_HOST", "hub.tailnet.ts.net");
	assertSetting(env, "TAILSCALE_IP", "100.64.0.2");
	assertSetting(env, "COMPOSE_FILE", "compose.yml:remote.https.yml:remote.tailscale.yml");
	for (const [config, cause] of [[{ os: "Darwin", arch: "arm64" }, /Linux|macOS/], [{ tailscaleError: "Tailscale is stopped" }, /Tailscale|tailscale/], [{ tailscaleIp: "" }, /Tailscale|tailscale/]]) {
		const broken = fixture(t, config);
		failed(broken.run({ HUB_HOST: "hub.tailnet.ts.net" }), cause);
		noDownloads(broken);
		assert.deepEqual(broken.files(), {});
	}
});

test("macOS loopback uses netstat and enforces Docker's server version floor", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { os: "Darwin", arch: "arm64" });
	passed(f.run());
	assert.ok(f.calls().some((call) => call.command === "netstat"));
	const busy = fixture(t, { os: "Darwin", arch: "arm64", listeners: [{ address: "127.0.0.1", port: 8080 }] });
	failed(busy.run(), /8080/);
	noDownloads(busy);
	const old = fixture(t, { os: "Darwin", engine: "27.5.1" });
	failed(old.run(), /28\.0\.0/);
	noDownloads(old);
});

test("an occupied port is allowed only for this running deployment and missing env never adopts another hub", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { listeners: [{ address: "127.0.0.1", port: 8080 }] });
	f.env("HUB_VERSION=0.4.13\nCOMPOSE_FILE=compose.yml\n");
	f.config.containers = [
		{ id: "hub-own", service: "hub", workingDir: f.hub, running: true, ports: [] },
		{ id: "caddy-own", service: "caddy", workingDir: f.hub, running: true, ports: [{ address: "127.0.0.1", port: 8080 }] },
	];
	passed(f.run());
	const foreign = fixture(t);
	foreign.config.containers = [{ id: "hub-foreign", service: "hub", workingDir: join(foreign.scratch, "other"), running: true, ports: [] }];
	failed(foreign.run(), /existing|already|another|\.env/i);
	noDownloads(foreign);
	assert.deepEqual(foreign.files(), {});
});

test("symlinked deployment directories remain updatable while other working directories are refused", { timeout: 60_000 }, (t) => {
	for (const parentLink of [false, true]) {
		const f = fixture(t);
		const link = join(f.scratch, "hub-link");
		if (!parentLink) mkdirSync(f.hub);
		symlinkSync(parentLink ? f.scratch : f.hub, link);
		const directory = parentLink ? join(link, "hub") : link;
		passed(f.run({ HUB_DIR: directory, HUB_VERSION: "0.4.12" }));
		f.config.listeners = [{ address: "127.0.0.1", port: 8080 }];
		f.config.containers = [
			{ id: "hub-own", service: "hub", workingDir: directory, running: true, ports: [] },
			{ id: "caddy-own", service: "caddy", workingDir: directory, running: true, ports: [{ address: "127.0.0.1", port: 8080 }] },
		];
		const result = f.run({ HUB_DIR: directory });
		passed(result);
		assertSetting(f.files()[".env"], "HUB_VERSION", "0.4.13");
		assert.match(result.stdout, /backup \/data\/backups\/hub-before-update\.tar\.gz/);
		assert.match(result.stdout, /Updated hub from 0\.4\.12 to 0\.4\.13/);
	}
	for (const available of [false, true]) {
		const f = fixture(t);
		f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
		const other = join(f.scratch, "other");
		if (available) mkdirSync(other);
		f.config.containers = [{ id: "hub-foreign", service: "hub", workingDir: other, running: true, ports: [] }];
		const before = f.files();
		failed(f.run(), /deployment check:.*belongs to/);
		noDownloads(f);
		assert.deepEqual(f.files(), before);
	}
});

test("Docker publications conflict even without a userspace socket and UDP publications do not occupy TCP", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { foreignContainers: [{ id: "other-docker", running: true, ports: [{ address: "0.0.0.0", port: 8080 }] }] });
	failed(f.run(), /8080/);
	noDownloads(f);
	assert.deepEqual(f.files(), {});
	const own = fixture(t, { listeners: [{ address: "127.0.0.1", port: 8080 }] });
	own.env("HUB_VERSION=0.4.13\nCOMPOSE_FILE=compose.yml\n");
	own.config.containers = [{ id: "caddy-own", service: "caddy", workingDir: own.hub, running: true, ports: [{ address: "127.0.0.1", port: 8080 }] }];
	own.config.foreignContainers = [{ id: "other-docker", running: true, ports: [{ address: "0.0.0.0", port: 8080 }] }];
	failed(own.run(), /another Docker/);
	noDownloads(own);
	const udp = fixture(t, { foreignContainers: [{ id: "other-docker", running: true, ports: [{ protocol: "80/udp", address: "0.0.0.0", port: 8080 }] }] });
	passed(udp.run());
});

test("a failed inspect of another Docker publication stops preflight before downloading or changing files", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { inspectError: "other-docker", foreignContainers: [{ id: "other-docker", running: true, ports: [] }] });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
	const before = f.files();
	failed(f.run(), /inspect|preflight/i);
	noDownloads(f);
	assert.deepEqual(f.files(), before);
});

test("macOS wildcard socket notation still recognizes this deployment's public HTTPS port", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { os: "Darwin", arch: "arm64", listeners: [{ address: "0.0.0.0", port: 443 }] });
	f.env("HUB_VERSION=0.4.13\nCOMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\n");
	f.config.containers = [{ id: "caddy-own", service: "caddy", workingDir: f.hub, running: true, ports: [{ protocol: "443/tcp", address: "0.0.0.0", port: 443 }] }];
	passed(f.run());
});

test("download failures preserve every installed file and a subsequent run succeeds", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { failAsset: "remote.https.yml" });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
	for (const name of assets) writeFileSync(join(f.hub, name), `old ${name}\n`);
	const before = f.files();
	const result = f.run();
	failed(result, /503/);
	assert.match(result.stdout + result.stderr, /https:\/\/github\.com\/uberblick-ai\/uberblick-2\/releases\/download\/hub-v0\.4\.13\/remote\.https\.yml/);
	assert.deepEqual(f.files(), before);
	f.config.failAsset = undefined;
	passed(f.run());
	assertSetting(f.files()[".env"], "HUB_VERSION", "0.4.13");
});

test("pins select an existing release, list newest releases when absent, and refuse a downgrade before downloads", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	passed(f.run({ HUB_VERSION: "0.4.12" }));
	assertSetting(f.files()[".env"], "HUB_VERSION", "0.4.12");
	const absent = fixture(t);
	const missing = absent.run({ HUB_VERSION: "0.1.0" });
	failed(missing, /0\.1\.0/);
	for (const version of absent.config.releases) assert.match(missing.stdout + missing.stderr, new RegExp(version.replaceAll(".", "\\.")));
	assert.deepEqual(absent.files(), {});
	const downgrade = fixture(t);
	downgrade.env("HUB_VERSION=0.4.13\nCOMPOSE_FILE=compose.yml\n");
	const before = downgrade.files();
	failed(downgrade.run({ HUB_VERSION: "0.4.12" }), /older|downgrade|rollback/i);
	assert.deepEqual(downgrade.files(), before);
	assert.equal(downgrade.calls().filter((call) => call.command === "curl" && call.args.some((arg) => arg.includes("/releases/download/"))).length, 0);
});

test("a running release is backed up before changing files and a protocol change asks for every client update", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { status: "hub running\nrelease 0.4.13\nprotocol 2\nclaimed yes\n" });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
	f.config.containers = [{ id: "hub-own", service: "hub", workingDir: f.hub, running: true, ports: [] }];
	const result = f.run();
	passed(result);
	assert.match(result.stdout, /backup \/data\/backups\/hub-before-update\.tar\.gz/);
	assert.match(result.stdout, /0\.4\.12.*0\.4\.13/s);
	assert.match(result.stdout, /every client.*same sitting|same sitting.*every client/is);
	assert.match(f.files()[".env"], /^CUSTOM_VALUE=preserved$/m);
	const calls = f.calls();
	const backup = calls.findIndex((call) => call.command === "docker" && call.args.at(-1) === "backup");
	const pull = calls.findIndex((call) => call.command === "docker" && call.args.includes("pull"));
	assert.ok(backup >= 0 && backup < pull);
	const broken = fixture(t, { backupError: "backup disk full" });
	broken.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n");
	broken.config.containers = [{ id: "hub-own", service: "hub", workingDir: broken.hub, running: true, ports: [] }];
	const before = broken.files();
	failed(broken.run(), /backup/i);
	assert.deepEqual(broken.files(), before);
	assert.ok(!broken.calls().some((call) => call.command === "docker" && call.args.includes("pull")));
});

test("older status output without a release line retains the env version for update reporting and downgrade refusal", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { oldStatus: "hub running\nprotocol 1\nclaimed no\n" });
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
	f.config.containers = [{ id: "hub-own", service: "hub", workingDir: f.hub, running: true, ports: [] }];
	const result = f.run();
	passed(result);
	assert.match(result.stdout, /Updated hub from 0\.4\.12 to 0\.4\.13/);
	assert.match(result.stdout, /backup \/data\/backups\/hub-before-update\.tar\.gz/);
	const downgrade = fixture(t, { oldStatus: "hub running\nprotocol 1\nclaimed no\n" });
	downgrade.env("HUB_VERSION=0.4.13\nCOMPOSE_FILE=compose.yml\nCUSTOM_VALUE=preserved\n");
	downgrade.config.containers = [{ id: "hub-own", service: "hub", workingDir: downgrade.hub, running: true, ports: [] }];
	const before = downgrade.files();
	failed(downgrade.run({ HUB_VERSION: "0.4.12" }), /downgrade|rollback/i);
	assert.deepEqual(downgrade.files(), before);
	assert.ok(!downgrade.calls().some((call) => call.command === "curl" && call.args.some((arg) => arg.includes("/releases/download/"))));
});

test("failed Compose steps stop the sequence and bounded status failure prints hub and Caddy logs", { timeout: 60_000 }, (t) => {
	for (const step of ["config", "pull", "up"]) {
		const f = fixture(t, { failStep: step });
		failed(f.run(), new RegExp(step, "i"));
		const calls = f.calls().filter((call) => call.command === "docker");
		if (step === "config") assert.ok(!calls.some((call) => call.args.includes("pull")));
		if (step !== "up") assert.ok(!calls.some((call) => call.args.includes("up")));
		assert.ok(!calls.some((call) => call.args.at(-1) === "status"));
	}
	const f = fixture(t, { statusError: "hub stopped" });
	const result = f.run();
	failed(result, /running|status|start/i);
	assert.match(result.stdout + result.stderr, /hub synthetic startup failure/);
	assert.match(result.stdout + result.stderr, /caddy synthetic startup failure/);
	const polls = f.calls().filter((call) => call.command === "docker" && call.args.at(-1) === "status");
	assert.ok(polls.length >= 1 && polls.length <= 30);
});

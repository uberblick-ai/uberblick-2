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
  if (args[0] === "status" && args.includes("--json")) out(config.tailscaleStatus ?? JSON.stringify({ BackendState: config.tailscaleState ?? "Running", Self: { DNSName: config.tailscaleName ?? "hub.tailnet.ts.net." } }, null, 2));
  else if (args.join(" ") === "ip -4") out((config.tailscaleIp ?? "100.64.0.2") + "\n");
  else die("Unexpected Tailscale command: " + args.join(" "));
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
    body = name === "remote.env.example" ? config.template : "# " + name + " release " + version + "\n" + (name === "compose.yml" ? "name: uberblick-remote\n" : "") + "services: {}\n";
    if (config.failAsset === name) { status = config.assetStatus ?? 503; body = "partial download"; failedTransfer = true; }
  } else die("Unexpected download URL: " + url);
  if (outputFile && outputFile !== "/dev/null") fs.writeFileSync(outputFile, body);
  else if (!outputFile) out(body);
  out(writeFormat.replace(/%\{http_code\}/g, String(status)).replace(/%\{url_effective\}/g, effective));
  if (status >= 400 || failedTransfer) die("curl: synthetic download failure", status >= 400 ? 22 : 18);
} else if (command === "docker") {
  const joined = args.join(" ");
  const currentEnv = dotenv(path.join(process.env.HUB_DIR ?? process.cwd(), ".env"));
  const projectFor = (container) => container.projectName ?? config.projectName ?? currentEnv.COMPOSE_PROJECT_NAME ?? "uberblick-remote";
  const containers = [...config.containers.map((container) => ({ ...container, projectName: projectFor(container) })), ...config.foreignContainers];
  const selectedProject = args.find((arg) => arg.startsWith("label=com.docker.compose.project="))?.split("=").at(-1);
  const selectedResources = (resources) => resources.filter((resource) => !selectedProject || resource.projectName === selectedProject);
  if (args[0] === "info") {
    if (config.daemonError) die(config.daemonError);
  } else if (args[0] === "version") out(config.engine + "\n");
  else if (joined === "compose version --short") out(config.compose + "\n");
  else if (args[0] === "ps") {
    const matching = selectedResources(containers).filter((container) => (args.includes("-a") || container.running) && (!args.includes("label=com.docker.compose.project.working_dir") || container.workingDir));
    out(matching.map((container) => container.id).join("\n") + (matching.length ? "\n" : ""));
  } else if (args[0] === "volume" && args[1] === "ls") {
    for (const volume of selectedResources(config.volumes)) out(volume.name + "\n");
  } else if (args[0] === "network" && args[1] === "ls") {
    for (const network of selectedResources(config.networks)) out(network.id + "\n");
  }
  else if (args[0] === "inspect") {
    if (config.inspectError === args.at(-1)) die("synthetic Docker inspect failure");
    const container = containers.find((candidate) => candidate.id === args.at(-1));
    if (!container) die("No such container");
    const format = args[args.indexOf("--format") + 1];
    if (format.includes("working_dir")) out(container.workingDir + "\n");
    else if (format.includes("com.docker.compose.service")) out(container.service + "\n");
    else if (format.includes("com.docker.compose.project")) out((container.projectName ?? "") + "\n");
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
      for (const key of ["HUB_VERSION", "WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP", "HUB_PORT", "LOOPBACK_PORT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]) out(key + "=" + (process.env[key] ?? values[key] ?? "") + "\n");
    } else if (args.includes("logs")) {
      const requested = args.slice(args.indexOf("logs") + 1).filter((arg) => !arg.startsWith("-"));
      for (const service of requested) if (!config.services.includes(service)) die("no such service: " + service);
      for (const service of requested.length ? requested : config.services) out(service + " synthetic startup failure\n");
    }
    else if (args.at(-1) === "status") {
      if (config.statusError) die(config.statusError);
      out(config.status);
    } else {
      const step = args.includes("config") ? "config" : args.includes("pull") ? "pull" : args.includes("up") ? "up" : undefined;
      if (!step) die("Unexpected Compose command: " + joined);
      if (config.failStep === step) die("synthetic " + step + " cause");
      if (config.modelProjects && step === "up") {
        const values = dotenv(path.join(process.cwd(), ".env"));
        const projectName = process.env.COMPOSE_PROJECT_NAME ?? values.COMPOSE_PROJECT_NAME ?? "uberblick-remote";
        const workingDir = process.cwd();
        const https = values.COMPOSE_FILE.includes("remote.https.yml");
        config.containers = config.containers.filter((container) => projectFor(container) !== projectName);
        for (const service of ["hub", "caddy"]) config.containers.push({ id: projectName + "-" + service, projectName, workingDir, service, running: true,
          ports: service === "caddy" ? [{ address: https ? values.TAILSCALE_IP || values.HTTPS_BIND_IP || "0.0.0.0" : "127.0.0.1", port: Number(https ? 443 : values.LOOPBACK_PORT || 8080) }] : [] });
        for (const name of ["hub-data", "hub-mcp-socket", "mcp-data", "caddy-data", "caddy-config"]) {
          if (!config.volumes.some((volume) => volume.name === projectName + "_" + name)) config.volumes.push({ name: projectName + "_" + name, projectName });
        }
        if (!config.networks.some((network) => network.projectName === projectName)) config.networks.push({ id: projectName + "_default", projectName });
        fs.writeFileSync(process.env.TEST_SETUP_CONFIG, JSON.stringify(config));
      }
    }
  } else die("Unexpected Docker command: " + joined);
} else die("Unexpected fake command: " + command);
`;

// pty.fork supplies a controlling terminal on both Linux and macOS. The
// installer still gets detached stdin, as in the hosted bash -c invocation.
const terminalProgram = String.raw`
import errno, json, os, pty, select, signal, sys, time

with open(sys.argv[1]) as source:
    script = source.read()
answer = json.loads(sys.argv[2])
pid, terminal = pty.fork()
if pid == 0:
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    if null != 0:
        os.close(null)
    os.execv("/bin/bash", ["/bin/bash", "-c", script, "setup-hub.sh", *sys.argv[3:]])

output = b""
answered = False
reaped = False
deadline = time.monotonic() + 45
try:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([terminal], [], [], remaining)[0]:
            raise TimeoutError("installer did not finish in its terminal")
        try:
            chunk = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        output += chunk
        if not answered and b"Serve the hub on" in output and b"[y/N]" in output:
            os.write(terminal, b"\x04" if answer is None else (answer + "\n").encode())
            answered = True
    _, status = os.waitpid(pid, 0)
    reaped = True
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(terminal)
    if not reaped:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
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
		listeners: [], containers: [], foreignContainers: [], volumes: [], networks: [],
		services: ["hub", "caddy"],
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
			for (const name of ["awk", "cat", "chmod", "cp", "mkdir", "mktemp", "mv", "od", "python3", "rm", "rmdir", "sed", "tr"]) {
				const source = process.env.PATH.split(":").map((directory) => join(directory, name)).find((path) => existsSync(path));
				if (source) symlinkSync(source, join(isolated, name));
			}
			return isolated;
		},
		env(contents, directory = hub) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, ".env"), contents, { mode: 0o600 });
		},
		files(directory = hub) { return existsSync(directory) ? Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")])) : {}; },
		runTerminal(answer, overrides = {}, args = []) {
			return this.run(overrides, args, { answer });
		},
		run(overrides = {}, args = [], terminal = null) {
			save();
			const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HUB_DIR: hub, TEST_SETUP_CONFIG: configPath, TEST_SETUP_LOG: log };
			for (const name of ["HUB_HOST", "HUB_VERSION", "HUB_PORT", "LOOPBACK_PORT", "HELP", "ALLOW_ROOT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP"]) delete env[name];
			const command = terminal ? "python3" : "/bin/bash";
			const commandArgs = terminal
				? ["-c", terminalProgram, join(root, "setup-hub.sh"), JSON.stringify(terminal.answer), ...args]
				: ["-c", readFileSync(join(root, "setup-hub.sh"), "utf8"), "setup-hub.sh", ...args];
			const result = spawnSync(command, commandArgs, {
				cwd: scratch, env: { ...env, ...overrides }, encoding: "utf8", timeout: 55_000, detached: !terminal,
			});
			Object.assign(config, JSON.parse(readFileSync(configPath, "utf8")));
			return result;
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
		for (const variable of ["HUB_HOST", "HUB_VERSION", "HUB_DIR", "HUB_PORT", "LOOPBACK_PORT", "ALLOW_ROOT", "HELP"]) assert.match(result.stdout, new RegExp(variable));
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

test("two hub directories keep separate projects and data through independent updates", { timeout: 60_000 }, (t) => {
	const f = fixture(t, { modelProjects: true });
	const other = join(f.scratch, "other-hub");
	const projectAt = (directory) => f.files(directory)[".env"].match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1];
	const resources = (projectName) => structuredClone(Object.fromEntries(["containers", "volumes", "networks"].map((kind) => [kind, f.config[kind].filter((resource) => resource.projectName === projectName)])));
	passed(f.run({ HUB_VERSION: "0.4.12", HUB_PORT: "9191" }));
	const firstProject = projectAt(f.hub);
	assert.ok(firstProject && firstProject !== "uberblick-remote");
	f.config.volumes.find((volume) => volume.projectName === firstProject).data = { claimed: "first-admin", documents: ["first document"] };
	const firstBefore = resources(firstProject);
	passed(f.run({ HUB_DIR: other, HUB_VERSION: "0.4.12", HUB_PORT: "9292" }));
	const secondProject = projectAt(other);
	assert.ok(secondProject && firstProject !== secondProject);
	assert.deepEqual(resources(firstProject), firstBefore);
	f.config.volumes.find((volume) => volume.projectName === secondProject).data = { claimed: "second-admin", documents: ["second document"] };
	const secondBefore = resources(secondProject);
	passed(f.run());
	assert.equal(projectAt(f.hub), firstProject);
	assert.deepEqual(resources(firstProject), firstBefore);
	assert.deepEqual(resources(secondProject), secondBefore);
	passed(f.run({ HUB_DIR: other }));
	assert.equal(projectAt(other), secondProject);
	assert.deepEqual(resources(firstProject), firstBefore);
	assert.deepEqual(resources(secondProject), secondBefore);
	assertSetting(f.files()[".env"], "LOOPBACK_PORT", "9191");
	assertSetting(f.files(other)[".env"], "LOOPBACK_PORT", "9292");
	for (const kind of ["containers", "volumes", "networks"]) {
		const ids = f.config[kind].map((resource) => resource.id ?? resource.name);
		assert.equal(new Set(ids).size, ids.length, `${kind} must never share identity`);
	}
	const composeCalls = f.calls().filter((call) => call.command === "docker" && call.args[0] === "compose" && (call.args.includes("up") || call.args.includes("pull")));
	assert.equal(composeCalls.filter((call) => call.cwd === f.hub).length, 4);
	assert.equal(composeCalls.filter((call) => call.cwd === other).length, 4);
});

test("legacy and explicitly named deployments retain their volumes when only volumes remain", { timeout: 60_000 }, (t) => {
	for (const explicitProject of [undefined, "operator-hub"]) {
		const projectName = explicitProject ?? "uberblick-remote";
		const volume = { name: `${projectName}_hub-data`, projectName, data: { claimed: "administrator", documents: ["saved"] } };
		const f = fixture(t, { modelProjects: true, volumes: [structuredClone(volume)] });
		f.env(`HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n${explicitProject ? `COMPOSE_PROJECT_NAME=${explicitProject}\n` : ""}`);
		passed(f.run());
		assertSetting(f.files()[".env"], "COMPOSE_PROJECT_NAME", projectName);
		assert.deepEqual(f.config.volumes.find((candidate) => candidate.name === volume.name), volume);
		assert.ok(f.config.containers.every((container) => container.projectName === projectName));
		assert.ok(f.config.volumes.every((candidate) => candidate.projectName === projectName));
	}
});

test("copied project settings and inherited project changes are refused before touching another hub", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	const other = join(f.scratch, "original-hub");
	f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nCOMPOSE_PROJECT_NAME=original-project\n");
	f.config.foreignContainers = [{ id: "original", projectName: "original-project", service: "hub", workingDir: other, running: true, ports: [] }];
	const before = f.files();
	const copied = f.run();
	failed(copied, /belongs to/);
	assert.ok((copied.stdout + copied.stderr).includes(other));
	assert.deepEqual(f.files(), before);
	noDownloads(f);
	const inherited = fixture(t);
	inherited.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n");
	const changed = inherited.run({ COMPOSE_PROJECT_NAME: "renamed-project" });
	failed(changed, /COMPOSE_PROJECT_NAME|project/);
	noDownloads(inherited);
	assert.doesNotMatch(inherited.files()[".env"], /renamed-project/);
	const ambiguous = fixture(t);
	ambiguous.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n");
	ambiguous.config.containers = ["first-project", "second-project"].map((projectName) => ({ id: projectName, projectName, service: "hub", workingDir: ambiguous.hub, running: false, ports: [] }));
	const ambiguousBefore = ambiguous.files();
	failed(ambiguous.run(), /multiple projects/);
	noDownloads(ambiguous);
	assert.deepEqual(ambiguous.files(), ambiguousBefore);
	const discovered = fixture(t);
	discovered.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n");
	discovered.config.containers = [{ id: "own-custom", projectName: "own-project", service: "hub", workingDir: discovered.hub, running: false, ports: [] }];
	discovered.config.volumes = [{ name: "other-project_hub-data", projectName: "other-project" }];
	const discoveredBefore = discovered.files();
	failed(discovered.run({ COMPOSE_PROJECT_NAME: "other-project" }), /differs/);
	noDownloads(discovered);
	assert.deepEqual(discovered.files(), discoveredBefore);
});

test("existing custom projects are recovered from running or stopped containers when env has no project name", { timeout: 60_000 }, (t) => {
	for (const supplied of [false, true]) {
		const f = fixture(t, { modelProjects: true });
		f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nLOOPBACK_PORT=9191\n");
		f.config.containers = [{ id: "custom-hub", projectName: "custom-project", service: "hub", workingDir: f.hub, running: supplied, ports: [] }];
		const volume = { name: "custom-project_hub-data", projectName: "custom-project", data: { claimed: "administrator", documents: ["saved"] } };
		f.config.volumes = [structuredClone(volume)];
		passed(f.run(supplied ? { COMPOSE_PROJECT_NAME: "custom-project" } : {}));
		assertSetting(f.files()[".env"], "COMPOSE_PROJECT_NAME", "custom-project");
		assert.deepEqual(f.config.volumes.find((candidate) => candidate.name === volume.name), volume);
		passed(f.run());
		assert.ok(f.config.containers.every((container) => container.projectName === "custom-project"));
		assert.ok(f.config.volumes.every((candidate) => candidate.projectName === "custom-project"));
	}
});

test("fresh projects refuse existing Docker resource names and persist an unused explicit name", { timeout: 60_000 }, (t) => {
	for (const resources of [
		{ volumes: [{ name: "chosen_hub-data", projectName: "chosen" }] },
		{ networks: [{ id: "chosen_default", projectName: "chosen" }] },
	]) {
		const f = fixture(t, resources);
		failed(f.run({ COMPOSE_PROJECT_NAME: "chosen" }), /project|exists|in use/);
		noDownloads(f);
		assert.deepEqual(f.files(), {});
	}
	const unused = fixture(t);
	passed(unused.run({ COMPOSE_PROJECT_NAME: "chosen" }));
	assertSetting(unused.files()[".env"], "COMPOSE_PROJECT_NAME", "chosen");
});

test("HUB_PORT selects and updates loopback ports while both aliases retain compatibility", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	passed(f.run({ HUB_PORT: "9191", LOOPBACK_PORT: "9191" }));
	assertSetting(f.files()[".env"], "LOOPBACK_PORT", "9191");
	const changed = f.run({ HUB_PORT: "9292" });
	passed(changed);
	assert.match(changed.stdout, /http:\/\/localhost:9292/);
	assertSetting(f.files()[".env"], "LOOPBACK_PORT", "9292");
	passed(f.run({ LOOPBACK_PORT: "9393" }));
	assertSetting(f.files()[".env"], "LOOPBACK_PORT", "9393");
	const saved = fixture(t);
	saved.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nLOOPBACK_PORT=9494\n");
	passed(saved.run());
	assertSetting(saved.files()[".env"], "LOOPBACK_PORT", "9494");
	const savedAlias = fixture(t);
	savedAlias.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nHUB_PORT=9595\n");
	passed(savedAlias.run());
	assertSetting(savedAlias.files()[".env"], "LOOPBACK_PORT", "9595");
	passed(savedAlias.run({ HUB_PORT: "9696" }));
	assertSetting(savedAlias.files()[".env"], "LOOPBACK_PORT", "9696");
	passed(savedAlias.run());
	assertSetting(savedAlias.files()[".env"], "LOOPBACK_PORT", "9696");
});

test("conflicting HUB_PORT and LOOPBACK_PORT values name both aliases before mutation", { timeout: 60_000 }, (t) => {
	for (const saved of [false, true]) {
		const f = fixture(t);
		if (saved) f.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\nHUB_PORT=9191\nLOOPBACK_PORT=9292\n");
		const before = f.files();
		const result = f.run(saved ? {} : { HUB_PORT: "9191", LOOPBACK_PORT: "9292" });
		failed(result, /HUB_PORT/);
		assert.match(result.stdout + result.stderr, /LOOPBACK_PORT/);
		assert.deepEqual(f.files(), before);
		noDownloads(f);
	}
});

test("another hub's loopback publication names its directory even when sockets do not expose Docker", { timeout: 60_000 }, (t) => {
	const f = fixture(t);
	const other = join(f.scratch, "other-hub");
	f.config.foreignContainers = [{ id: "other-caddy", projectName: "other-project", service: "caddy", workingDir: other, running: true, ports: [{ address: "127.0.0.1", port: 9191 }] }];
	const result = f.run({ HUB_PORT: "9191" });
	failed(result, /9191/);
	assert.ok((result.stdout + result.stderr).includes(other));
	noDownloads(f);
	assert.deepEqual(f.files(), {});
});

test("HTTPS hubs reject overlapping 443 bindings and accept a different configured address", { timeout: 60_000 }, (t) => {
	for (const setting of ["HTTPS_BIND_IP", "TAILSCALE_IP"]) {
		const f = fixture(t);
		const other = join(f.scratch, "other-hub");
		const port = { address: "100.64.0.2", port: 443 };
		f.config.foreignContainers = [{ id: "other-caddy", projectName: "other-project", service: "caddy", workingDir: other, running: true, ports: [port] }];
		f.env(`HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml:remote.https.yml${setting === "TAILSCALE_IP" ? ":remote.tailscale.yml" : ""}\nWEB_HOST=${setting === "TAILSCALE_IP" ? "hub.tailnet.ts.net" : "hub.example.com"}\n${setting}=100.64.0.2\n`);
		const before = f.files();
		const result = f.run();
		failed(result, /443/);
		assert.ok((result.stdout + result.stderr).includes(other));
		noDownloads(f);
		assert.deepEqual(f.files(), before);
		f.env(before[".env"].replace(`${setting}=100.64.0.2`, `${setting}=100.64.0.3`));
		passed(f.run());
		assertSetting(f.files()[".env"], setting, "100.64.0.3");
	}
	const wildcard = fixture(t, { foreignContainers: [{ id: "other-caddy", projectName: "other-project", service: "caddy", workingDir: "/other-hub", running: true, ports: [{ address: "0.0.0.0", port: 443 }] }] });
	wildcard.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=hub.example.com\nHTTPS_BIND_IP=192.0.2.4\n");
	failed(wildcard.run(), /\/other-hub/);
	noDownloads(wildcard);
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

test("accepting the terminal tailnet offer matches an explicit HUB_HOST with detached installer stdin", { timeout: 60_000 }, (t) => {
	const config = { tailscaleIp: "100.100.1.2", listeners: [{ address: "127.0.0.1", port: 8080 }] };
	const offered = fixture(t, config);
	const explicit = fixture(t, config);
	const result = offered.runTerminal("yes", { COMPOSE_PROJECT_NAME: "terminal-offer" });
	const selected = explicit.run({ HUB_HOST: "hub.tailnet.ts.net", COMPOSE_PROJECT_NAME: "terminal-offer" });
	passed(result);
	passed(selected);
	assert.match(result.stdout, /Serve the hub on https:\/\/hub\.tailnet\.ts\.net\? \[y\/N\]/);
	assert.equal(offered.files()[".env"], explicit.files()[".env"]);
	assertSetting(offered.files()[".env"], "COMPOSE_FILE", "compose.yml:remote.https.yml:remote.tailscale.yml");
	assertSetting(offered.files()[".env"], "WEB_HOST", "hub.tailnet.ts.net");
	assertSetting(offered.files()[".env"], "TAILSCALE_IP", "100.100.1.2");
	assert.match(result.stdout, /ub auth login https:\/\/hub\.tailnet\.ts\.net/);
	assert.match(selected.stdout, /ub auth login https:\/\/hub\.tailnet\.ts\.net/);
	const busy = fixture(t, { listeners: [{ address: "100.64.0.2", port: 443 }] });
	failed(busy.runTerminal("y"), /100\.64\.0\.2:443/);
	noDownloads(busy);
	assert.deepEqual(busy.files(), {});
});

test("declining, pressing Enter, or terminal EOF keeps the fresh loopback default", { timeout: 60_000 }, (t) => {
	for (const answer of ["no", "", null]) {
		const f = fixture(t, { listeners: [{ address: "100.64.0.2", port: 443 }] });
		const result = f.runTerminal(answer);
		passed(result);
		assert.match(result.stdout, /Serve the hub on/);
		assertSetting(f.files()[".env"], "COMPOSE_FILE", "compose.yml");
		assertSetting(f.files()[".env"], "WEB_HOST", "");
		assertSetting(f.files()[".env"], "TAILSCALE_IP", "");
		assert.match(result.stdout, /ub auth login http:\/\/localhost:8080/);
	}
});

test("no terminal and explicitly set HUB_HOST values suppress the tailnet offer", { timeout: 60_000 }, (t) => {
	const unattended = fixture(t);
	const result = unattended.run();
	passed(result);
	assert.doesNotMatch(result.stdout, /Serve the hub on/);
	assertSetting(unattended.files()[".env"], "COMPOSE_FILE", "compose.yml");
	assert.equal(unattended.calls().filter((call) => call.command === "tailscale").length, 0);
	for (const [host, compose] of [["", "compose.yml"], ["public.example.com", "compose.yml:remote.https.yml"], ["chosen.tailnet.ts.net", "compose.yml:remote.https.yml:remote.tailscale.yml"]]) {
		const f = fixture(t);
		const configured = f.runTerminal("yes", { HUB_HOST: host });
		passed(configured);
		assert.doesNotMatch(configured.stdout, /Serve the hub on/);
		assertSetting(f.files()[".env"], "COMPOSE_FILE", compose);
		assertSetting(f.files()[".env"], "WEB_HOST", host);
		assert.equal(f.calls().filter((call) => call.command === "tailscale" && call.args[0] === "status").length, 0);
	}
});

test("terminal reruns preserve their recorded route unless HUB_HOST is explicitly supplied", { timeout: 60_000 }, (t) => {
	for (const [settings, host, compose] of [
		["COMPOSE_FILE=compose.yml\nLOOPBACK_PORT=9191\n", "", "compose.yml"],
		["COMPOSE_FILE=compose.yml:remote.https.yml\nWEB_HOST=saved.example.com\n", "saved.example.com", "compose.yml:remote.https.yml"],
		["COMPOSE_FILE=compose.yml:remote.https.yml:remote.tailscale.yml\nWEB_HOST=saved.tailnet.ts.net\nTAILSCALE_IP=100.64.0.3\n", "saved.tailnet.ts.net", "compose.yml:remote.https.yml:remote.tailscale.yml"],
	]) {
		const f = fixture(t);
		f.env(`HUB_VERSION=0.4.12\n${settings}`);
		const result = f.runTerminal("yes");
		passed(result);
		assert.doesNotMatch(result.stdout, /Serve the hub on/);
		assertSetting(f.files()[".env"], "COMPOSE_FILE", compose);
		if (host) assertSetting(f.files()[".env"], "WEB_HOST", host);
		assert.equal(f.calls().filter((call) => call.command === "tailscale" && call.args[0] === "status").length, 0);
	}
	const changed = fixture(t);
	changed.env("HUB_VERSION=0.4.12\nCOMPOSE_FILE=compose.yml\n");
	const result = changed.runTerminal("yes", { HUB_HOST: "chosen.tailnet.ts.net" });
	passed(result);
	assert.doesNotMatch(result.stdout, /Serve the hub on/);
	assertSetting(changed.files()[".env"], "WEB_HOST", "chosen.tailnet.ts.net");
});

test("unavailable or stopped Tailscale is silently ignored by the terminal offer", { timeout: 60_000 }, (t) => {
	for (const config of [{ os: "Darwin", arch: "arm64" }, { tailscaleError: "synthetic Tailscale unavailable" }, { tailscaleState: "Stopped" }, { tailscaleState: "NeedsLogin" }]) {
		const f = fixture(t, config);
		const result = f.runTerminal("yes");
		passed(result);
		assert.doesNotMatch(result.stdout + result.stderr, /Serve the hub on|synthetic Tailscale unavailable/);
		assertSetting(f.files()[".env"], "COMPOSE_FILE", "compose.yml");
	}
	const missing = fixture(t);
	const result = missing.runTerminal("yes", { PATH: missing.without("tailscale") });
	passed(result);
	assert.doesNotMatch(result.stdout + result.stderr, /Serve the hub on|tailscale.*(missing|required)/i);
	assertSetting(missing.files()[".env"], "COMPOSE_FILE", "compose.yml");
});

test("the terminal offer requires a valid local ts.net name and tailnet IPv4 address", { timeout: 60_000 }, (t) => {
	for (const config of [
		{ tailscaleName: "" },
		{ tailscaleName: "hub.example.com." },
		{ tailscaleName: "-invalid.tailnet.ts.net." },
		{ tailscaleName: "hub..ts.net." },
		{ tailscaleIp: "" },
		{ tailscaleIp: "100.63.255.255" },
		{ tailscaleIp: "100.128.0.1" },
		{ tailscaleIp: "100.64.0.256" },
		{ tailscaleStatus: "not JSON" },
		{ tailscaleStatus: JSON.stringify({ BackendState: "Running", Self: {}, Peer: { other: { DNSName: "peer.tailnet.ts.net." } } }, null, 2) },
	]) {
		const f = fixture(t, config);
		const result = f.runTerminal("yes");
		passed(result);
		assert.doesNotMatch(result.stdout, /Serve the hub on/);
		assertSetting(f.files()[".env"], "COMPOSE_FILE", "compose.yml");
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
	failed(foreign.run({ COMPOSE_PROJECT_NAME: "uberblick-remote" }), /existing|already|another|\.env/i);
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

test("failed Compose steps stop the sequence and startup failure names the deployment log command", { timeout: 60_000 }, (t) => {
	for (const step of ["config", "pull", "up"]) {
		const f = fixture(t, { failStep: step });
		const result = f.run();
		failed(result, new RegExp(step, "i"));
		if (step === "up") assert.match(result.stderr, /Check docker compose logs --tail=100 in HUB_DIR/);
		const calls = f.calls().filter((call) => call.command === "docker");
		if (step === "config") assert.ok(!calls.some((call) => call.args.includes("pull")));
		if (step !== "up") assert.ok(!calls.some((call) => call.args.includes("up")));
		assert.ok(!calls.some((call) => call.args.at(-1) === "status"));
	}
});

test("bounded readiness failure prints every deployed service's logs with and without hosted MCP", { timeout: 60_000 }, (t) => {
	for (const services of [["hub", "mcp", "caddy"], ["hub", "caddy"]]) {
		const f = fixture(t, { services, statusError: "hub stopped" });
		const result = f.run();
		failed(result, /running|status|start/i);
		for (const service of services) assert.ok(result.stderr.includes(`${service} synthetic startup failure`), `${service} logs missing: ${result.stderr}`);
		assert.doesNotMatch(result.stderr, /no such service/);
		assert.match(result.stderr, /Check docker compose logs --tail=100 in HUB_DIR/);
		const calls = f.calls().filter((call) => call.command === "docker");
		assert.deepEqual(calls.filter((call) => call.args.includes("logs")).map((call) => call.args), [["compose", "logs", "--tail=100"]]);
		const polls = calls.filter((call) => call.args.at(-1) === "status");
		assert.ok(polls.length >= 1 && polls.length <= 30);
	}
});

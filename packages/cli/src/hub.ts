import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { takeHelp } from "./help.js";
import { type Io, shellArgument } from "./io.js";
import { cliVersion } from "./version.js";

export const HUB_HELP = `usage: ub hub <command> [options]

Manage one published Docker hub deployment on this host.

commands:
  setup [--release X.Y.Z]             extract release files and create .env; start nothing
  up                                  check, pull and start the deployment
  down                                stop and remove containers; keep data volumes
  status [--json]                     report the release, services and site health
  upgrade [--release X.Y.Z] [--yes]   stage, back up and recreate a newer release

options:
  --dir <path>       deployment directory (default: ~/uberblick-remote)
  --release X.Y.Z    defaults to this client's version; required for a source checkout
  --yes             confirm a sync protocol change during upgrade
  --json            one JSON object for status
  -h, --help        show this help and do nothing

Requires Docker Engine 28.0.0+, Compose 2.24.4+, and Linux x86_64 or
Docker Desktop on macOS. See the deployment's REMOTE.md for routes and recovery.
Run one operator session at a time. Remote orchestration is not supported.
`;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const DIRECTORY_OPTION = { dir: { type: "string" } } as const;
export const HUB_OPTIONS = {
  setup: { ...DIRECTORY_OPTION, release: { type: "string" } },
  up: DIRECTORY_OPTION,
  down: DIRECTORY_OPTION,
  status: { ...DIRECTORY_OPTION, json: { type: "boolean" } },
  upgrade: { ...DIRECTORY_OPTION, release: { type: "string" }, yes: { type: "boolean" } },
} as const satisfies Record<string, ParseArgsOptionsConfig>;

export interface HubHost {
  version: string;
  home: string;
  // Selected output streams are delivered live instead of returned.
  run(command: string, args: readonly string[], cwd?: string, output?: Partial<Io>): Promise<CommandResult>;
  probe(origin: string): Promise<{ site: number | null; websocket: number | null }>;
  confirm(question: string): Promise<boolean>;
}

// Shell settings must not retarget a deployment or override its operator-owned .env.
const SETTINGS = ["WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP", "LOOPBACK_PORT", "WEB_HUB_URL", "WEB_WORKSPACES", "HUB_GITHUB_CLIENT_ID"];

export function hubProcessHost(environment: NodeJS.ProcessEnv = process.env): HubHost {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COMPOSE_") || SETTINGS.includes(key)) delete env[key];
  }
  return {
    version: cliVersion(),
    home: homedir(),
    run(command, args, cwd, output) {
      return new Promise((done) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const out = (text: string): void => { if (output?.out) output.out(text); else stdout += text; };
        const err = (text: string): void => { if (output?.err) output.err(text); else stderr += text; };
        child.stdout.setEncoding("utf8").on("data", out);
        child.stderr.setEncoding("utf8").on("data", err);
        const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
        const handlers = signals.map((signal) => {
          const forward = (): void => { child.kill(signal); };
          process.on(signal, forward);
          return { signal, forward };
        });
        let error: Error | undefined;
        child.on("error", (failure) => { error = failure; });
        child.on("close", (status, signal) => {
          for (const { signal, forward } of handlers) process.off(signal, forward);
          if (error) err(`${error.message}\n`);
          if (signal) err(`Interrupted by ${signal}.\n`);
          done({ status: error ? null : status, stdout, stderr });
        });
      });
    },
    async probe(origin) {
      const [site, websocket] = await Promise.all([responseCode(`${origin}/`, false), responseCode(`${origin}/ws`, true)]);
      return { site, websocket };
    },
    async confirm(question) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim()); }
      finally { terminal.close(); }
    },
  };
}

function responseCode(address: string, websocket: boolean): Promise<number | null> {
  return new Promise((done) => {
    const url = new URL(address);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: websocket ? { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==" } : {},
    });
    const timer = setTimeout(() => { request.destroy(); done(null); }, 5000);
    const finish = (status: number | null): void => { clearTimeout(timer); done(status); };
    request.on("response", (response) => { finish(response.statusCode ?? null); response.destroy(); });
    request.on("upgrade", (response, socket) => { finish(response.statusCode ?? null); socket.destroy(); });
    request.on("error", () => finish(null));
    request.end();
  });
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
interface Release {
  version: string;
  sourceCommit: string;
  syncProtocolVersion: number;
  images: { hub: string; web: string };
}

function releaseAt(directory: string, requested?: string): Release {
  let release: Release;
  try { release = JSON.parse(readFileSync(join(directory, "release.json"), "utf8")); }
  catch { throw new Error(`Cannot read release.json in ${directory}. Run ub hub setup for a new deployment; source-checkout deployments need REMOTE.md's manual switch procedure.`); }
  if (!release || typeof release.version !== "string" || !VERSION.test(release.version) ||
    (requested !== undefined && release.version !== requested) ||
    typeof release.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(release.sourceCommit) ||
    !Number.isSafeInteger(release.syncProtocolVersion) || release.syncProtocolVersion < 1 ||
    release.images?.hub !== `ghcr.io/uberblick-ai/hub:${release.version}` ||
    release.images?.web !== `ghcr.io/uberblick-ai/hub-web:${release.version}`) {
    throw new Error(`Release identity in ${directory}/release.json does not match ${requested ?? "a published release"}. Nothing was started or replaced.`);
  }
  return release;
}

class StepFailure extends Error {
  constructor(readonly step: string, detail: string) { super(`${step} failed: ${detail}`); }
}

async function checked(host: HubHost, io: Io, step: string, command: string, args: readonly string[], cwd?: string, logs = false): Promise<string> {
  const result = await host.run(command, args, cwd, { err: (text) => io.err(text), ...(logs ? { out: (text: string) => io.err(text) } : {}) });
  if (result.stderr) io.err(result.stderr);
  if (logs && result.stdout) io.err(result.stdout);
  if (result.status !== 0) throw new StepFailure(step, result.status === null ? `${command} could not be run` : `${command} exited ${result.status}`);
  return result.stdout;
}

async function dockerReady(host: HubHost, io: Io): Promise<void> {
  const version = await host.run("docker", ["--version"], undefined, { err: (text) => io.err(text) });
  if (version.stderr) io.err(version.stderr);
  if (version.status !== 0) throw new Error("Docker is missing or cannot be run. Install Docker Engine 28.0.0+ and Compose 2.24.4+ on Linux x86_64, or start Docker Desktop on macOS. Nothing has changed.");
  try { await checked(host, io, "Docker daemon check", "docker", ["info"]); }
  catch { throw new Error("Docker daemon is unreachable. Start Docker Engine 28.0.0+ or Docker Desktop and allow this user to reach its socket; Compose 2.24.4+ is required. Nothing has changed."); }
}

function compose(host: HubHost, io: Io, directory: string, step: string, args: readonly string[], logs = false): Promise<string> {
  return checked(host, io, step, "sh", ["bin/remote-compose.sh", ...args], directory, logs);
}

interface ComposeConfig {
  name: string;
  services: { hub: { image: string; volumes: VolumeMount[] }; caddy: { image: string; environment: Record<string, string>; volumes: VolumeMount[] } };
  volumes: Record<string, { name: string; external?: boolean }>;
}
interface VolumeMount { type: string; source: string; target: string }

async function configuration(host: HubHost, io: Io, directory: string, release: Release): Promise<ComposeConfig> {
  const text = await compose(host, io, directory, "config check", ["config", "--format", "json"]);
  let config: ComposeConfig;
  try { config = JSON.parse(text); }
  catch { throw new StepFailure("config check", "Compose returned unreadable JSON"); }
  if (config?.name !== "uberblick-remote" || config.services?.hub?.image !== release.images.hub || config.services?.caddy?.image !== release.images.web) {
    throw new StepFailure("config check", "the Compose project or images do not match this deployment's release.json");
  }
  for (const [service, source, target] of [["hub", "hub-data", "/data"], ["caddy", "caddy-data", "/data"], ["caddy", "caddy-config", "/config"]] as const) {
    const mounts = config.services[service].volumes;
    const mount = mounts?.find((entry) => entry.target === target);
    if (mount?.type !== "volume" || mount.source !== source || config.volumes?.[source]?.name !== `uberblick-remote_${source}` || config.volumes[source]?.external) {
      throw new StepFailure("config check", `the ${service} ${target} volume differs from the released deployment; nothing was stopped or replaced`);
    }
  }
  return config;
}

interface ServiceState { state: string; health: string | null }
interface HubStatus {
  directory: string;
  version: string | null;
  syncProtocolVersion: number | null;
  services: { hub: ServiceState; caddy: ServiceState };
  origin: string | null;
  checks: { site: number | null; websocket: number | null };
  healthy: boolean;
  error?: string;
}

async function services(host: HubHost, io: Io, directory: string): Promise<HubStatus["services"]> {
  const text = await compose(host, io, directory, "service state check", ["ps", "--all", "--format", "json", "hub", "caddy"]);
  let rows: { Service: string; State: string; Health?: string }[];
  try {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? [] : trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
    rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.some((row) => !row || typeof row.Service !== "string" || typeof row.State !== "string")) throw new Error();
  } catch { throw new StepFailure("service state check", "Compose returned unreadable service states"); }
  const state = (service: string): ServiceState => {
    const row = rows.find((row) => row.Service === service);
    return { state: row?.State ?? "absent", health: row?.Health || null };
  };
  return { hub: state("hub"), caddy: state("caddy") };
}

async function status(host: HubHost, io: Io, directory: string): Promise<HubStatus> {
  const result: HubStatus = { directory, version: null, syncProtocolVersion: null,
    services: { hub: { state: "unknown", health: null }, caddy: { state: "unknown", health: null } },
    origin: null, checks: { site: null, websocket: null }, healthy: false };
  try {
    const release = releaseAt(directory);
    result.version = release.version;
    result.syncProtocolVersion = release.syncProtocolVersion;
    await dockerReady(host, io);
    const config = await configuration(host, io, directory, release);
    result.services = await services(host, io, directory);
    const env = config.services.caddy.environment;
    const hostName = env.WEB_HOST || env.TAILSCALE_HOST;
    result.origin = hostName ? `https://${hostName}` : `http://localhost:${env.LOOPBACK_PORT || "8080"}`;
    result.checks = await host.probe(result.origin);
    result.healthy = Object.values(result.services).every((service) => service.state === "running" && (service.health === null || service.health === "healthy")) && result.checks.site === 200 && result.checks.websocket === 101;
  } catch (error) { result.error = message(error); }
  return result;
}

function printStatus(io: Io, result: HubStatus): void {
  io.out(`directory  ${result.directory}\nrelease    ${result.version ?? "not set up"}\nprotocol   ${result.syncProtocolVersion ?? "unknown"}\nhub        ${result.services.hub.state}\ncaddy      ${result.services.caddy.state}\norigin     ${result.origin ?? "unknown"}\nsite       ${result.checks.site ?? "not answering"}\n/ws        ${result.checks.websocket ?? "not answering"}\nhealth     ${result.healthy ? "healthy" : "unhealthy"}\n`);
  if (result.error) io.err(`ub hub status: ${result.error}\n`);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function upCommand(directory: string): string { return `ub hub up --dir ${shellArgument(directory)}`; }

function assertEmpty(directory: string, staging?: string): void {
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory() || readdirSync(directory).some((name) => join(directory, name) !== staging)) {
    throw new Error(`${directory} already holds files. Nothing has changed. For an existing deployment run ${upCommand(directory)} or ub hub upgrade --dir ${shellArgument(directory)}.`);
  }
}

// Published payloads contain ordinary files; never follow a payload link into the host.
function validateFiles(directory: string, top = true): void {
  for (const name of readdirSync(directory)) {
    if (top && name.startsWith(".")) throw new Error("The release payload contains operator-owned or hidden files.");
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isDirectory()) validateFiles(path, false);
    else if (!entry.isFile()) throw new Error(`The release payload contains a non-regular file: ${name}`);
  }
}

async function stage(host: HubHost, io: Io, directory: string, target: string): Promise<{ directory: string; release: Release }> {
  const staging = mkdtempSync(join(directory, ".ub-hub-release-"));
  let container: string | null = null;
  try {
    const image = `ghcr.io/uberblick-ai/hub:${target}`;
    await checked(host, io, "release pull", "docker", ["pull", "--platform", "linux/amd64", image], undefined, true);
    container = (await checked(host, io, "release extraction container", "docker", ["create", "--platform", "linux/amd64", image])).trim();
    if (!/^[a-f0-9]{12,64}$/.test(container)) throw new StepFailure("release extraction container", "Docker returned no container identity");
    await checked(host, io, "release extraction", "docker", ["cp", `${container}:/release/.`, staging]);
    await checked(host, io, "extraction container cleanup", "docker", ["rm", container]);
    container = null;
    validateFiles(staging);
    const release = releaseAt(staging, target);
    for (const file of ["remote.env.example", "bin/remote-compose.sh", "bin/hub-backup.sh"]) {
      if (!lstatSync(join(staging, file)).isFile()) throw new Error(`Release is missing ${file}.`);
    }
    return { directory: staging, release };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (container !== null) await checked(host, io, "extraction container cleanup", "docker", ["rm", container]);
  }
}

async function setup(host: HubHost, io: Io, directory: string, target: string): Promise<void> {
  assertEmpty(directory);
  await dockerReady(host, io);
  const created = !existsSync(directory);
  mkdirSync(directory, { recursive: true });
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  const published: string[] = [];
  try {
    staged = await stage(host, io, directory, target);
    copyFileSync(join(staged.directory, "remote.env.example"), join(staged.directory, ".env"));
    chmodSync(join(staged.directory, ".env"), 0o600);
    await configuration(host, io, staged.directory, staged.release);
    assertEmpty(directory, staged.directory);
    for (const name of readdirSync(staged.directory)) {
      renameSync(join(staged.directory, name), join(directory, name));
      published.push(name);
    }
  } catch (error) {
    for (const name of published) rmSync(join(directory, name), { recursive: true, force: true });
    throw error;
  } finally {
    if (staged) rmSync(staged.directory, { recursive: true, force: true });
    if (created && readdirSync(directory).length === 0) rmdirSync(directory);
  }
  io.out(`directory  ${directory}\nrelease    ${target}\nnext       ${upCommand(directory)}\n`);
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    const leftPart = a[index] ?? 0n;
    const rightPart = b[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

async function upgrade(host: HubHost, io: Io, directory: string, target: string, yes: boolean): Promise<number> {
  const live = releaseAt(directory);
  const comparison = compareVersions(target, live.version);
  if (comparison === 0) { io.out(`current    ${live.version} in ${directory}, nothing to upgrade\n`); return 0; }
  if (comparison < 0) throw new Error(`Cannot downgrade ${live.version} to ${target}. Nothing has changed.`);
  await dockerReady(host, io);
  await configuration(host, io, directory, live);
  if ((await services(host, io, directory)).hub.state !== "running") throw new Error(`The hub is not running. Run ${upCommand(directory)} before upgrading. Nothing has changed.`);
  const staged = await stage(host, io, directory, target);
  let backup: string;
  do { backup = join(directory, `hub-backup-${randomUUID()}.sqlite`); } while (existsSync(backup));
  let replacing = false;
  try {
    if (staged.release.syncProtocolVersion !== live.syncProtocolVersion) {
      const warning = `Sync protocol changes from ${live.syncProtocolVersion} to ${staged.release.syncProtocolVersion}. Every client must update in the same sitting; restart agents and ub open, and reload browser tabs.`;
      io.err(`${warning}\n`);
      if (!yes && !await host.confirm("Update every client in the same sitting and upgrade this hub?")) {
        throw new Error("Upgrade needs terminal confirmation or --yes for the sync protocol change. No live files or containers have changed.");
      }
    }
    copyFileSync(join(directory, ".env"), join(staged.directory, ".env"));
    chmodSync(join(staged.directory, ".env"), 0o600);
    await configuration(host, io, staged.directory, staged.release);
    await compose(host, io, staged.directory, "target image pull", ["pull"], true);
    try {
      await checked(host, io, "backup step", "sh", ["bin/hub-backup.sh", backup], directory, true);
      if (!existsSync(backup) || !lstatSync(backup).isFile()) throw new StepFailure("backup step", "the script did not publish a complete backup file");
      try { chmodSync(backup, 0o600); }
      catch { throw new StepFailure("backup step", "could not secure the completed backup with mode 0600"); }
    }
    catch (error) {
      const complete = existsSync(backup) && lstatSync(backup).isFile();
      let running = false;
      try { running = (await services(host, io, directory)).hub.state === "running"; } catch { /* Report uncertainty as a recovery need. */ }
      throw new Error(`${message(error)}. ${complete ? `A complete backup exists at ${backup}.` : `No complete backup exists at ${backup}.`} Release files, .env and earlier backups were kept; no target containers were recreated. ${running ? "The hub is running." : `The hub did not come back up or its state could not be confirmed. Fix the cause, then run ${upCommand(directory)}.`}`);
    }
    rmSync(join(staged.directory, ".env"));
    replacing = true;
    try {
      for (const name of readdirSync(staged.directory)) {
        rmSync(join(directory, name), { recursive: true, force: true });
        renameSync(join(staged.directory, name), join(directory, name));
      }
    } catch (error) { throw new StepFailure("release file replacement", message(error)); }
    await compose(host, io, directory, "container recreation", ["up", "--detach", "--force-recreate"], true);
    const deadline = Date.now() + 90_000;
    let health = await status(host, io, directory);
    if (!health.healthy) io.err("Waiting up to 90 seconds for the recreated deployment to become healthy…\n");
    while (!health.healthy && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, Math.min(1000, deadline - Date.now())));
      health = await status(host, io, directory);
    }
    io.out(`upgraded   ${live.version} → ${target}\nbackup     ${backup}\n`);
    printStatus(io, health);
    if (!health.healthy) throw new StepFailure("resulting health check", "the deployment did not become healthy within 90 seconds");
    return 0;
  } catch (error) {
    if (replacing) throw new Error(`${message(error)}. Backup: ${backup}. Fix the cause, then run ${upCommand(directory)}, or follow REMOTE.md's restore procedure. No automatic rollback was attempted.`);
    throw error;
  } finally { rmSync(staged.directory, { recursive: true, force: true }); }
}

export async function hubCommand(argv: string[], io: Io, host: HubHost = hubProcessHost()): Promise<number> {
  if (takeHelp(argv, io, HUB_HELP)) return 0;
  const [sub, ...args] = argv;
  if (sub === undefined || sub === "help") { io.out(HUB_HELP); return 0; }
  if (!Object.hasOwn(HUB_OPTIONS, sub)) { io.err(`ub hub: unknown command ${JSON.stringify(sub)}\n\n${HUB_HELP}`); return 2; }
  let values: { dir?: string; release?: string; yes?: boolean; json?: boolean };
  try {
    const options: ParseArgsOptionsConfig = HUB_OPTIONS[sub as keyof typeof HUB_OPTIONS];
    values = parseArgs({ args, options, allowPositionals: false }).values;
    if (values.dir === "") throw new Error("--dir needs a non-empty path");
    if (sub === "setup" || sub === "upgrade") {
      values.release ??= host.version;
      if (values.release === "0.0.0") throw new Error("A source checkout has no default release; provide --release X.Y.Z");
      if (!VERSION.test(values.release)) throw new Error("--release must be a published version X.Y.Z");
    }
  } catch (error) { io.err(`ub hub ${sub}: ${message(error)}\n\n${HUB_HELP}`); return 2; }
  const path = values.dir ?? join(host.home, "uberblick-remote");
  const directory = resolve(path === "~" ? host.home : path.startsWith("~/") ? join(host.home, path.slice(2)) : path);
  try {
    if (sub === "status") {
      const result = await status(host, io, directory);
      if (values.json) io.out(`${JSON.stringify(result)}\n`); else printStatus(io, result);
      return result.healthy ? 0 : 1;
    }
    if (sub === "setup" && values.release) { await setup(host, io, directory, values.release); return 0; }
    if (sub === "upgrade" && values.release) return await upgrade(host, io, directory, values.release, values.yes ?? false);
    const release = releaseAt(directory);
    await dockerReady(host, io);
    await configuration(host, io, directory, release);
    if (sub === "up") {
      await compose(host, io, directory, "config check", ["config", "--quiet"]);
      await compose(host, io, directory, "image pull", ["pull"], true);
      await compose(host, io, directory, "startup", ["up", "--detach"], true);
      io.out(`started    ${release.version} in ${directory}\nnext       ub hub status --dir ${shellArgument(directory)}\n`);
    } else {
      await compose(host, io, directory, "shutdown", ["down"], true);
      io.out(`stopped    ${directory}; data volumes kept\nnext       ${upCommand(directory)}\n`);
    }
    return 0;
  } catch (error) { io.err(`ub hub ${sub}: ${message(error)}\n`); return 1; }
}

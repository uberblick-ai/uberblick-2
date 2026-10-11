import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hubCommand, hubProcessHost } from "../src/hub.js";
import type { Io } from "../src/io.js";
import { REPO_ROOT, removeTempDirs, runUbAsync, unboundSandbox } from "./helpers.js";

const directories: string[] = [];
afterAll(() => {
  removeTempDirs();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

interface DockerCall {
  args: string[];
  cwd: string;
  project: string | null;
  files: string[];
  settings: Record<string, string | null>;
}

// The release's real wrapper owns validation and route selection. Docker alone
// is replaced, recording its selected project and modelling named volumes.
const DOCKER = String.raw`#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const files = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === "-f") files.push(args[++index]);
}
const yaml = files.length ? readFileSync(files[0], "utf8") : "";
const project = process.env.COMPOSE_PROJECT_NAME || /^name: (.+)$/m.exec(yaml)?.[1] || null;
const keys = ["WEB_HOST", "TAILSCALE_HOST", "TAILSCALE_IP", "HTTPS_BIND_IP", "LOOPBACK_PORT", "WEB_HUB_URL", "WEB_WORKSPACES", "HUB_GITHUB_CLIENT_ID", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"];
const settings = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
appendFileSync(process.env.UB_TEST_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd(), project, files, settings }) + "\n");
if (args[0] === "--version") console.log("Docker version 28.0.0");
else if (args[0] === "version") console.log(process.env.UB_TEST_ENGINE_VERSION || "28.0.0");
else if (args[0] === "info") {
  if (process.env.UB_TEST_DAEMON_DOWN) { console.error("daemon unavailable"); process.exit(1); }
} else if (args[0] === "compose") {
  if (args[1] === "version") console.log(process.env.UB_TEST_COMPOSE_VERSION || "2.24.4");
  else {
    for (const file of files) if (!existsSync(file)) { console.error("missing route file"); process.exit(1); }
    if (args.includes("config") && args.includes("--format")) {
      const release = JSON.parse(readFileSync("release.json", "utf8"));
      console.log(JSON.stringify({ name: project, services: {
        hub: { image: release.images.hub, volumes: [{ type: "volume", source: "hub-data", target: "/data" }] },
        caddy: { image: release.images.web, environment: settings, volumes: [
          { type: "volume", source: "caddy-data", target: "/data" },
          { type: "volume", source: "caddy-config", target: "/config" },
        ] },
      }, volumes: Object.fromEntries(["hub-data", "caddy-data", "caddy-config"].map((source) => [source, { name: project + "_" + source }])) }));
    } else if (args.includes("up")) {
      for (const volume of ["hub-data", "caddy-data", "caddy-config"]) {
        const directory = join(process.env.UB_TEST_VOLUMES, project + "_" + volume);
        if (!existsSync(directory)) {
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "state"), "initial " + volume);
        }
      }
    } else if (args.includes("down") && (args.includes("--volumes") || args.includes("-v"))) {
      rmSync(process.env.UB_TEST_VOLUMES, { recursive: true, force: true });
    }
  }
}
`;

function fixture(settings = ""): { directory: string; volumes: string; env: NodeJS.ProcessEnv; calls(): DockerCall[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `uberblick-${process.env.UB_AGENTS_RUN ?? "test"}-hub-host-`)));
  directories.push(root);
  const directory = join(root, "deployment");
  const executables = join(root, "executables");
  mkdirSync(join(directory, "bin"), { recursive: true });
  mkdirSync(executables);
  copyFileSync(join(REPO_ROOT, "bin", "remote-compose.sh"), join(directory, "bin", "remote-compose.sh"));
  copyFileSync(join(REPO_ROOT, "remote-settings.sh"), join(directory, "remote-settings.sh"));
  for (const file of ["remote.https.yml", "remote.tailscale.yml"]) {
    copyFileSync(join(REPO_ROOT, file), join(directory, file));
  }
  writeFileSync(join(directory, "docker-compose.yml"), readFileSync(join(REPO_ROOT, "compose.release.yml"), "utf8")
    .replaceAll("__HUB_IMAGE__", "ghcr.io/uberblick-ai/hub:0.4.1")
    .replaceAll("__WEB_IMAGE__", "ghcr.io/uberblick-ai/hub-web:0.4.1"));
  writeFileSync(join(directory, "release.json"), JSON.stringify({
    version: "0.4.1",
    sourceCommit: "a".repeat(40),
    syncProtocolVersion: 1,
    images: { hub: "ghcr.io/uberblick-ai/hub:0.4.1", web: "ghcr.io/uberblick-ai/hub-web:0.4.1" },
  }));
  writeFileSync(join(directory, ".env"), settings, { mode: 0o600 });
  writeFileSync(join(executables, "docker"), DOCKER, { mode: 0o755 });
  const log = join(root, "docker.jsonl");
  const volumes = join(root, "volumes");
  return {
    directory,
    volumes,
    env: {
      ...process.env,
      PATH: `${executables}:${process.env.PATH}`,
      UB_TEST_DOCKER_LOG: log,
      UB_TEST_VOLUMES: volumes,
      COMPOSE_PROJECT_NAME: "other-project",
      COMPOSE_FILE: "/other/docker-compose.yml",
      WEB_HOST: "ambient.invalid",
      TAILSCALE_HOST: "ambient.tailnet.ts.net",
      TAILSCALE_IP: "invalid",
      HTTPS_BIND_IP: "invalid",
      LOOPBACK_PORT: "invalid",
      WEB_HUB_URL: "injected invalid value",
      WEB_WORKSPACES: "injected invalid value",
      HUB_GITHUB_CLIENT_ID: "ambient-client",
    },
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

function recorder(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

describe("hub commands through the real deployment wrapper", () => {
  it.each([
    ["", ["docker-compose.yml"], null],
    ["WEB_HOST=hub.example.com\n", ["docker-compose.yml", "remote.https.yml"], "hub.example.com"],
    ["WEB_HOST=machine.tailnet.ts.net\nTAILSCALE_IP=100.64.0.1\n", ["docker-compose.yml", "remote.https.yml", "remote.tailscale.yml"], "machine.tailnet.ts.net"],
  ])("selects only deployment-owned route files for %j", async (settings, files, hostName) => {
    const fix = fixture(settings);
    const io = recorder();
    expect(await hubCommand(["up", "--dir", fix.directory], io, hubProcessHost(fix.env)), io.stderr).toBe(0);
    const calls = fix.calls().filter((call) => call.args[0] === "compose" && call.args[1] !== "version");
    expect(calls.map((call) => call.args.slice(1 + files.length * 2))).toEqual([
      ["config", "--format", "json"], ["config", "--quiet"], ["pull"], ["up", "--detach"],
    ]);
    for (const call of calls) {
      expect(call.cwd).toBe(fix.directory);
      expect(call.files).toEqual(files);
      expect(call.project).toBe("uberblick-remote");
      expect(call.settings).toMatchObject({
        WEB_HOST: hostName,
        TAILSCALE_HOST: null,
        HTTPS_BIND_IP: null,
        LOOPBACK_PORT: null,
        WEB_HUB_URL: null,
        WEB_WORKSPACES: null,
        HUB_GITHUB_CLIENT_ID: null,
        COMPOSE_FILE: null,
        COMPOSE_PROJECT_NAME: null,
      });
    }
  });

  it("down then up reuses all three named volumes with their state", async () => {
    const fix = fixture();
    const host = hubProcessHost(fix.env);
    const io = recorder();
    expect(await hubCommand(["up", "--dir", fix.directory], io, host), io.stderr).toBe(0);
    const state = {
      "hub-data": "documents and claimed-hub state",
      "caddy-data": "certificate state",
      "caddy-config": "server configuration state",
    };
    for (const [volume, contents] of Object.entries(state)) {
      writeFileSync(join(fix.volumes, `uberblick-remote_${volume}`, "state"), contents);
    }
    expect(await hubCommand(["down", "--dir", fix.directory], io, host), io.stderr).toBe(0);
    expect(await hubCommand(["up", "--dir", fix.directory], io, host), io.stderr).toBe(0);
    for (const [volume, contents] of Object.entries(state)) {
      expect(readFileSync(join(fix.volumes, `uberblick-remote_${volume}`, "state"), "utf8")).toBe(contents);
    }
    const down = fix.calls().find((call) => call.args.includes("down"));
    expect(down?.args).toEqual(["compose", "-f", "docker-compose.yml", "down"]);
    expect(fix.calls().filter((call) => call.files.length).every((call) => call.project === "uberblick-remote")).toBe(true);
    expect(existsSync(join(fix.volumes, "other-project_hub-data"))).toBe(false);
  });

  it.each([
    ["invalid deployment settings", "LOOPBACK_PORT=0\n", {}, "LOOPBACK_PORT"],
    ["old Compose", "", { UB_TEST_COMPOSE_VERSION: "2.24.3" }, "Compose 2.24.4"],
    ["old Docker Engine", "", { UB_TEST_ENGINE_VERSION: "27.5.0" }, "Engine 28.0.0"],
    ["unreachable daemon", "", { UB_TEST_DAEMON_DOWN: "1" }, "daemon is unreachable"],
  ])("does not start a service with %s", async (_reason, settings, extraEnv, error) => {
    const fix = fixture(settings);
    const io = recorder();
    expect(await hubCommand(["up", "--dir", fix.directory], io, hubProcessHost({ ...fix.env, ...extraEnv }))).toBe(1);
    expect(io.stderr).toContain(error);
    expect(fix.calls().some((call) => call.args.includes("up"))).toBe(false);
    expect(existsSync(fix.volumes)).toBe(false);
  });

  it("runs outside a project and ignores malformed client configuration", async () => {
    const fix = fixture();
    const box = unboundSandbox({
      raw: { userConfig: "{", credentials: "{" },
    });
    const env = { ...fix.env, ...box.env, PATH: fix.env.PATH };
    const up = await runUbAsync(["hub", "up", "--dir", fix.directory], box, env);
    expect(up.status, up.output).toBe(0);
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    writeFileSync(join(box.cwd, ".uberblick.json"), "{", { mode: 0o600 });
    const down = await runUbAsync(["hub", "down", "--dir", fix.directory], box, env);
    expect(down.status, down.output).toBe(0);
    for (const path of [
      join(box.cwd, ".uberblick.json"),
      join(box.configHome, "uberblick", "config.json"),
      join(box.configHome, "uberblick", "credentials.json"),
    ]) expect(readFileSync(path, "utf8")).toBe("{");
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("top-level help lists hub and nested help does not call Docker", async () => {
    const fix = fixture();
    const box = unboundSandbox({ raw: { projectBinding: "{", userConfig: "{", credentials: "{" } });
    const env = { ...fix.env, ...box.env, PATH: fix.env.PATH };
    const root = await runUbAsync(["--help"], box, env);
    expect(root.status).toBe(0);
    expect(root.stdout).toMatch(/^ {2}hub \[command\]/m);
    for (const args of [["hub"], ["hub", "up", "--dir", fix.directory, "--help"], ["hub", "upgrade", "--nonsense", "--help"]]) {
      const help = await runUbAsync(args, box, env);
      expect(help.status, help.output).toBe(0);
      expect(help.stdout).toContain("usage: ub hub <command>");
      expect(help.stderr).toBe("");
    }
    expect(fix.calls()).toEqual([]);
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function own(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // The server also ends on its own deadline if a test assertion is interrupted.
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  }, 10_000);
  return async () => {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}

describe("hub host health probes", () => {
  it("checks the site and a real websocket upgrade, and preserves HTTP refusal codes", async () => {
    let healthy = true;
    const observed: string[] = [];
    const server = createServer((request, response) => {
      observed.push(request.url ?? "");
      response.writeHead(healthy ? 200 : 503);
      response.end();
    });
    server.on("upgrade", (request, socket) => {
      observed.push(request.url ?? "");
      expect(request.headers.upgrade).toBe("websocket");
      expect(request.headers["sec-websocket-version"]).toBe("13");
      socket.end(healthy
        ? "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
        : "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    const close = own(server);
    const origin = await listen(server);
    try {
      const host = hubProcessHost();
      expect(await host.probe(origin)).toEqual({ site: 200, websocket: 101 });
      healthy = false;
      expect(await host.probe(origin)).toEqual({ site: 503, websocket: 403 });
      expect(observed.sort()).toEqual(["/", "/", "/ws", "/ws"]);
    } finally { await close(); }
    expect(await hubProcessHost().probe(origin)).toEqual({ site: null, websocket: null });
  });

  it("bounds each probe when the site and websocket sockets never answer", async () => {
    let requests = 0;
    let reached: () => void = () => {};
    const bothReached = new Promise<void>((resolve) => { reached = resolve; });
    const arrived = (): void => { if (++requests === 2) reached(); };
    const server = createServer(arrived);
    server.on("upgrade", arrived);
    const close = own(server);
    const origin = await listen(server);
    const original = globalThis.setTimeout;
    const deadlines: (() => void)[] = [];
    // Execute the real timeout bodies after both requests arrive, avoiding a
    // five-second sleep while still checking the configured bound and cleanup.
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = original(callback, delay, ...args);
      if (delay === 5000) deadlines.push(() => { clearTimeout(timer); callback(...args); });
      return timer;
    });
    try {
      const probing = hubProcessHost().probe(origin);
      await bothReached;
      expect(deadlines).toHaveLength(2);
      for (const expire of deadlines) expire();
      expect(await probing).toEqual({ site: null, websocket: null });
    } finally {
      timers.mockRestore();
      await close();
    }
  });
});

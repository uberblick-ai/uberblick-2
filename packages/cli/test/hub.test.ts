import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type HubHost, hubCommand, hubProcessHost } from "../src/hub.js";
import type { Io } from "../src/io.js";

const roots: string[] = [];
afterEach(() => vi.useRealTimers());
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ub-hub-command-"));
  roots.push(root);
  return root;
}

function recorder(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "", stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

function manifest(version: string, syncProtocolVersion = 1) {
  return {
    version, syncProtocolVersion, sourceCommit: "a".repeat(40),
    images: { hub: `ghcr.io/uberblick-ai/hub:${version}`, web: `ghcr.io/uberblick-ai/hub-web:${version}` },
  };
}

function payload(directory: string, version: string, protocol = 1): void {
  mkdirSync(join(directory, "bin"), { recursive: true });
  for (const file of ["remote.env.example", "remote-settings.sh", "remote.https.yml", "remote.tailscale.yml", "REMOTE.md", "RELEASING.md"]) {
    writeFileSync(join(directory, file), readFileSync(resolve(import.meta.dirname, "../../..", file)));
  }
  for (const file of ["remote-compose.sh", "hub-backup.sh", "hub-restore.sh", "hub-admin-setup.sh"]) {
    writeFileSync(join(directory, "bin", file), readFileSync(resolve(import.meta.dirname, "../../../bin", file)));
  }
  const metadata = manifest(version, protocol);
  writeFileSync(join(directory, "release.json"), `${JSON.stringify(metadata)}\n`);
  const compose = readFileSync(resolve(import.meta.dirname, "../../../compose.release.yml"), "utf8")
    .replaceAll("__HUB_IMAGE__", metadata.images.hub).replaceAll("__WEB_IMAGE__", metadata.images.web);
  writeFileSync(join(directory, "docker-compose.yml"), compose);
}

function snapshot(directory: string): unknown[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort().map((name) => {
    const path = join(directory, name);
    const stat = statSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? null : readFileSync(path)];
  });
}

type Event = { command: string; args: readonly string[]; cwd: string | undefined; operation: string; liveVersion: string | null; settings: string | null };
type Failure = "docker" | "daemon" | "release-pull" | "extract" | "identity" | "config" | "pull" | "backup" | "backup-restart" | "backup-no-file" | "recreate";

function scenario(options: { deployed?: string | undefined; target?: string; protocol?: number; stopped?: boolean; failure?: Failure; confirm?: boolean; badVolumes?: boolean; unhealthy?: boolean; serviceHealth?: string; psFormat?: "lines"; environment?: Record<string, string> } = {}) {
  const root = scratch();
  const directory = join(root, "deployment");
  const target = options.target ?? "0.2.0";
  const release = join(root, "release");
  payload(release, target, options.protocol);
  if (options.deployed) {
    payload(directory, options.deployed);
    writeFileSync(join(directory, ".env"), "LOOPBACK_PORT=8080\nHUB_GITHUB_CLIENT_ID=preserved\n", { mode: 0o600 });
    writeFileSync(join(directory, "earlier-backup.sqlite"), "earlier complete backup", { mode: 0o600 });
  }
  if (options.failure === "identity") {
    writeFileSync(join(release, "release.json"), JSON.stringify(manifest("0.99.0")));
  }
  const events: Event[] = [];
  const failed = () => ({ status: 9, stdout: "", stderr: "injected failure\n" });
  let stopped = options.stopped ?? false;
  const host = {
    version: target,
    home: root,
    run: vi.fn<HubHost["run"]>(async (command, args, cwd) => {
      const script = command === "sh" ? basename(args[0] ?? "") : "";
      const operation = command === "docker" ? args[0] ?? "docker"
        : script === "hub-backup.sh" ? "backup"
        : args[1] ?? script;
      events.push({ command, args: [...args], cwd, operation,
        liveVersion: existsSync(join(directory, "release.json")) ? JSON.parse(readFileSync(join(directory, "release.json"), "utf8")).version : null,
        settings: cwd && existsSync(join(cwd, ".env")) ? readFileSync(join(cwd, ".env"), "utf8") : null,
      });
      if (command === "docker") {
        if (options.failure === "docker") return { status: null, stdout: "", stderr: "docker unavailable\n" };
        if (options.failure === "daemon" && args[0] === "info") return failed();
        if (options.failure === "release-pull" && args[0] === "pull") return failed();
        if (args[0] === "create") return { status: 0, stdout: "abcdef123456\n", stderr: "" };
        if (args[0] === "cp") {
          if (options.failure === "extract") return failed();
          cpSync(release, args.at(-1) as string, { recursive: true });
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (script === "hub-backup.sh") {
        const backup = args[1] as string;
        if (options.failure !== "backup" && options.failure !== "backup-no-file") writeFileSync(backup, "complete database backup", { mode: 0o600 });
        if (options.failure === "backup-restart") {
          stopped = true;
          return { status: 9, stdout: "", stderr: "THE HUB IS STILL DOWN\n" };
        }
        if (options.failure === "backup") return failed();
        return { status: 0, stdout: "backup complete\n", stderr: "" };
      }
      if (script !== "remote-compose.sh" || !cwd) throw new Error(`unexpected command ${command}`);
      if (args[1] === "config") {
        if (options.failure === "config" && cwd !== directory) return failed();
        const metadata = JSON.parse(readFileSync(join(cwd, "release.json"), "utf8"));
        return { status: 0, stdout: JSON.stringify({ name: "uberblick-remote", services: {
          hub: { image: metadata.images.hub, volumes: [{ type: "volume", source: options.badVolumes && cwd !== directory ? "other-data" : "hub-data", target: "/data" }] },
          caddy: { image: metadata.images.web, environment: { WEB_HOST: "", TAILSCALE_HOST: "", LOOPBACK_PORT: "8080", ...options.environment }, volumes: [
            { type: "volume", source: "caddy-data", target: "/data" },
            { type: "volume", source: "caddy-config", target: "/config" },
          ] },
        }, volumes: {
          "hub-data": { name: "uberblick-remote_hub-data" },
          "caddy-data": { name: "uberblick-remote_caddy-data" },
          "caddy-config": { name: "uberblick-remote_caddy-config" },
        } }), stderr: "" };
      }
      if (args[1] === "ps") {
        const states = [
          { Service: "hub", State: stopped ? "exited" : "running", Health: "" },
          { Service: "caddy", State: stopped ? "exited" : "running", Health: options.serviceHealth ?? "" },
        ];
        return { status: 0, stdout: options.psFormat === "lines" ? states.map((row) => JSON.stringify(row)).join("\n") : JSON.stringify(states), stderr: "" };
      }
      if (args[1] === "pull" && options.failure === "pull") return failed();
      if (args[1] === "up") {
        if (options.failure === "recreate") return failed();
        stopped = false;
      }
      if (args[1] === "down") stopped = true;
      return { status: 0, stdout: "compose log\n", stderr: "" };
    }),
    probe: vi.fn<HubHost["probe"]>().mockResolvedValue({ site: options.unhealthy ? 502 : 200, websocket: 101 }),
    confirm: vi.fn<HubHost["confirm"]>().mockResolvedValue(options.confirm ?? false),
  } satisfies HubHost;
  return { root, directory, release, host, events };
}

async function invoke(command: string[], state: ReturnType<typeof scenario>) {
  const io = recorder();
  const code = await hubCommand([...command, "--dir", state.directory], io, state.host);
  return { code, io };
}

describe("ub hub argument and help contracts", () => {
  it.each([[], ["--help"], ["upgrade", "--release", "bad", "--help"], ["up", "--volumes", "-h"]].map((argv) => ({ argv })))(
    "prints help without checking Docker, files or prompting for $argv", async ({ argv }) => {
      const state = scenario();
      const before = snapshot(state.root);
      const io = recorder();
      expect(await hubCommand(argv, io, state.host)).toBe(0);
      expect(io.stdout).toContain("usage: ub hub");
      expect(io.stderr).toBe("");
      expect(state.host.run).not.toHaveBeenCalled();
      expect(state.host.confirm).not.toHaveBeenCalled();
      expect(snapshot(state.root)).toEqual(before);
    },
  );

  it.each([["unknown"], ["up", "--volumes"], ["down", "--yes"], ["status", "--release", "0.2.0"], ["setup", "--release"], ["setup", "--release", "latest"], ["up", "--dir"]].map((argv) => ({ argv })))(
    "rejects $argv as usage before doing anything", async ({ argv }) => {
      const state = scenario();
      const io = recorder();
      expect(await hubCommand(argv, io, state.host)).toBe(2);
      expect(io.stdout).toBe("");
      expect(io.stderr).toContain("usage: ub hub");
      expect(state.host.run).not.toHaveBeenCalled();
    },
  );
});

describe("ub hub setup", () => {
  it.each([false, true])("extracts the release into a missing or empty directory (empty=%s), without starting anything", async (empty) => {
    const state = scenario();
    if (empty) mkdirSync(state.directory);
    const { code, io } = await invoke(["setup"], state);
    expect(code).toBe(0);
    for (const file of readdirSync(state.release, { recursive: true, encoding: "utf8" })) {
      if (statSync(join(state.release, file)).isFile()) {
        expect(readFileSync(join(state.directory, file))).toEqual(readFileSync(join(state.release, file)));
      }
    }
    expect(readFileSync(join(state.directory, ".env"))).toEqual(readFileSync(join(state.release, "remote.env.example")));
    expect(statSync(join(state.directory, ".env")).mode & 0o777).toBe(0o600);
    expect(io.stdout).toContain(state.directory);
    expect(io.stdout).toContain("0.2.0");
    expect(io.stdout).toContain("ub hub up");
    expect(state.events.filter((event) => event.command === "sh").every((event) => event.operation === "config")).toBe(true);
    expect(state.host.run.mock.calls.some(([, args]) => args.includes("ghcr.io/uberblick-ai/hub:0.2.0"))).toBe(true);
  });

  it("uses the client's version and default home directory", async () => {
    const state = scenario({ target: "0.7.3" });
    const io = recorder();
    expect(await hubCommand(["setup"], io, state.host)).toBe(0);
    expect(JSON.parse(readFileSync(join(state.root, "uberblick-remote", "release.json"), "utf8")).version).toBe("0.7.3");
  });

  it("requires a release from a source checkout, but accepts an explicit release", async () => {
    const state = scenario();
    state.host.version = "0.0.0";
    const first = await invoke(["setup"], state);
    expect(first.code).toBe(2);
    expect(first.io.stderr).toContain("--release");
    expect(state.host.run).not.toHaveBeenCalled();
    expect((await invoke(["setup", "--release", "0.2.0"], state)).code).toBe(0);
  });

  it.each([false, true])("refuses a nonempty directory unchanged (deployment=%s)", async (deployment) => {
    const state = scenario(deployment ? { deployed: "0.1.0" } : {});
    if (!deployment) {
      mkdirSync(state.directory);
      writeFileSync(join(state.directory, "operator-file"), "keep me");
    }
    const before = snapshot(state.root);
    const { code, io } = await invoke(["setup"], state);
    expect(code).toBe(1);
    expect(snapshot(state.root)).toEqual(before);
    if (deployment) expect(io.stderr).toMatch(/ub hub (up|upgrade)/);
    expect(state.events.some((event) => ["create", "cp", "up"].includes(event.operation))).toBe(false);
  });

  it.each(["docker", "daemon", "release-pull", "extract", "identity", "config"] as const)("leaves no partial deployment when %s fails", async (failure) => {
    const state = scenario({ failure });
    const before = snapshot(state.root);
    expect((await invoke(["setup"], state)).code).toBe(1);
    expect(snapshot(state.root)).toEqual(before);
    expect(existsSync(state.directory)).toBe(false);
  });

  it.each(["release-pull", "extract", "identity", "config"] as const)("leaves a pre-created directory empty when %s fails", async (failure) => {
    const state = scenario({ failure });
    mkdirSync(state.directory);
    expect((await invoke(["setup"], state)).code).toBe(1);
    expect(readdirSync(state.directory)).toEqual([]);
  });

  it.each(["setup", "upgrade"])("%s works in a writable deployment beneath a non-writable parent", async (command) => {
    const state = scenario(command === "upgrade" ? { deployed: "0.1.0" } : {});
    if (command === "setup") mkdirSync(state.directory);
    chmodSync(state.root, 0o555);
    try {
      expect((await invoke([command], state)).code).toBe(0);
      const extraction = state.events.find((event) => event.operation === "cp");
      expect(extraction?.args.at(-1)?.startsWith(`${state.directory}/`)).toBe(true);
      expect(readdirSync(state.directory).some((name) => name.startsWith(".ub-hub-release-"))).toBe(false);
      expect(JSON.parse(readFileSync(join(state.directory, "release.json"), "utf8")).version).toBe("0.2.0");
    } finally { chmodSync(state.root, 0o755); }
  });

  it("rejects image references that disagree with the requested release", async () => {
    const state = scenario();
    const metadata = manifest("0.2.0");
    metadata.images.web = "ghcr.io/uberblick-ai/hub-web:0.1.0";
    writeFileSync(join(state.release, "release.json"), JSON.stringify(metadata));
    expect((await invoke(["setup"], state)).code).toBe(1);
    expect(existsSync(state.directory)).toBe(false);
  });
});

describe("ub hub up and down", () => {
  it("uses the deployment wrapper for config, pull and up, and down never removes volumes", async () => {
    const state = scenario({ deployed: "0.1.0", stopped: true });
    const before = snapshot(state.directory);
    expect((await invoke(["up"], state)).code).toBe(0);
    const up = state.events.filter((event) => event.command === "sh");
    expect(up.map((event) => event.args)).toEqual([
      ["bin/remote-compose.sh", "config", "--format", "json"],
      ["bin/remote-compose.sh", "config", "--quiet"],
      ["bin/remote-compose.sh", "pull"],
      ["bin/remote-compose.sh", "up", "--detach"],
    ]);
    expect(up.every((event) => event.cwd === state.directory)).toBe(true);
    expect((await invoke(["down"], state)).code).toBe(0);
    expect(state.events.at(-1)?.args).toEqual(["bin/remote-compose.sh", "down"]);
    expect((await invoke(["up"], state)).code).toBe(0);
    expect(snapshot(state.directory)).toEqual(before);
  });

  it("removes ambient Compose selection from child processes", async () => {
    const host = hubProcessHost({ COMPOSE_PROJECT_NAME: "other-project", COMPOSE_FILE: "other-compose.yml", HUB_TEST_SENTINEL: "retained" });
    const result = await host.run(process.execPath, ["-e", "process.stdout.write(JSON.stringify({project:process.env.COMPOSE_PROJECT_NAME,file:process.env.COMPOSE_FILE,sentinel:process.env.HUB_TEST_SENTINEL}))"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sentinel: "retained" });
  });

  it.each(["up", "down", "status", "upgrade"])("reports missing Docker on %s and leaves deployment unchanged", async (command) => {
    const state = scenario({ deployed: "0.1.0", failure: "docker" });
    const before = snapshot(state.directory);
    const { code, io } = await invoke([command], state);
    expect(code).toBe(1);
    expect(io.stderr).toMatch(/[Dd]ocker/);
    expect(snapshot(state.directory)).toEqual(before);
    expect(state.events.some((event) => event.command === "sh")).toBe(false);
  });
});

describe("ub hub status", () => {
  it("prints one JSON object with release, service states and origin checks", async () => {
    const state = scenario({ deployed: "0.1.0" });
    const { code, io } = await invoke(["status", "--json"], state);
    expect(code).toBe(0);
    const status = JSON.parse(io.stdout);
    expect(status).toMatchObject({ directory: state.directory, version: "0.1.0", syncProtocolVersion: 1,
      services: { hub: { state: "running" }, caddy: { state: "running" } },
      origin: "http://localhost:8080", checks: { site: 200, websocket: 101 }, healthy: true });
    expect(state.host.probe).toHaveBeenCalledWith("http://localhost:8080");
    expect(io.stdout.trim().split("\n")).toHaveLength(1);
  });

  it.each(["missing", "stopped", "site", "websocket"])("exits unhealthy for %s and keeps stdout parseable", async (failure) => {
    const state = scenario({ deployed: failure === "missing" ? undefined : "0.1.0", stopped: failure === "stopped" });
    if (failure === "site") state.host.probe.mockResolvedValue({ site: null, websocket: 101 });
    if (failure === "websocket") state.host.probe.mockResolvedValue({ site: 200, websocket: 502 });
    const { code, io } = await invoke(["status", "--json"], state);
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout).healthy).toBe(false);
  });

  it("reports an unhealthy service even while the origin is answering", async () => {
    const state = scenario({ deployed: "0.1.0", serviceHealth: "unhealthy", psFormat: "lines" });
    const { code, io } = await invoke(["status", "--json"], state);
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout)).toMatchObject({ services: { caddy: { state: "running", health: "unhealthy" } }, healthy: false });
  });

  it.each([
    { environment: { WEB_HOST: "hub.example.com" }, origin: "https://hub.example.com" },
    { environment: { TAILSCALE_HOST: "machine.tailnet.ts.net" }, origin: "https://machine.tailnet.ts.net" },
    { environment: { LOOPBACK_PORT: "12345" }, origin: "http://localhost:12345" },
  ])("checks configured origin $origin", async ({ environment, origin }) => {
    const state = scenario({ deployed: "0.1.0", environment });
    const { code, io } = await invoke(["status", "--json"], state);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout).origin).toBe(origin);
    expect(state.host.probe).toHaveBeenCalledWith(origin);
  });
});

describe("ub hub upgrade", () => {
  it("stages and replaces within a symlinked deployment while preserving settings and backups", async () => {
    const state = scenario({ deployed: "0.1.0" });
    const settings = readFileSync(join(state.directory, ".env"));
    const storage = join(state.root, "storage");
    mkdirSync(storage);
    const deployed = join(storage, "deployment");
    renameSync(state.directory, deployed);
    symlinkSync(deployed, state.directory, "dir");
    expect((await invoke(["upgrade"], state)).code).toBe(0);
    const extraction = state.events.find((event) => event.operation === "cp");
    expect(extraction?.args.at(-1)?.startsWith(`${state.directory}/`)).toBe(true);
    expect(readFileSync(join(deployed, ".env"))).toEqual(settings);
    expect(readFileSync(join(deployed, "earlier-backup.sqlite"), "utf8")).toBe("earlier complete backup");
    for (const name of readdirSync(state.release, { recursive: true, encoding: "utf8" })) {
      if (statSync(join(state.release, name)).isFile()) expect(readFileSync(join(deployed, name))).toEqual(readFileSync(join(state.release, name)));
    }
    expect(readdirSync(deployed).some((name) => name.startsWith(".ub-hub-release-"))).toBe(false);
  });

  it("stages and pulls before a live backup, then replaces files and recreates with existing settings and backups", async () => {
    const state = scenario({ deployed: "0.1.0" });
    const settings = readFileSync(join(state.directory, ".env"));
    const { code, io } = await invoke(["upgrade"], state);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(state.directory, "release.json"), "utf8")).version).toBe("0.2.0");
    expect(readFileSync(join(state.directory, ".env"))).toEqual(settings);
    expect(readFileSync(join(state.directory, "earlier-backup.sqlite"), "utf8")).toBe("earlier complete backup");
    const backup = state.events.find((event) => event.operation === "backup");
    expect(backup?.cwd).toBe(state.directory);
    expect(backup?.liveVersion).toBe("0.1.0");
    expect(backup?.args[0]).toBe("bin/hub-backup.sh");
    const backupPath = backup?.args[1] as string;
    expect(backupPath.startsWith(`${state.directory}/`)).toBe(true);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const operations = state.events.map((event) => event.operation);
    expect(operations.indexOf("cp")).toBeLessThan(operations.indexOf("backup"));
    expect(operations.indexOf("pull")).toBeLessThan(operations.indexOf("backup"));
    expect(operations.indexOf("backup")).toBeLessThan(operations.indexOf("up"));
    const stagedPull = state.events.find((event) => event.command === "sh" && event.operation === "pull");
    expect(stagedPull?.cwd).not.toBe(state.directory);
    expect(stagedPull?.settings).toBe(settings.toString());
    expect(stagedPull?.liveVersion).toBe("0.1.0");
    expect(state.events.indexOf(stagedPull as Event)).toBeLessThan(state.events.indexOf(backup as Event));
    expect(state.events.find((event) => event.operation === "up")).toMatchObject({ cwd: state.directory,
      liveVersion: "0.2.0", args: ["bin/remote-compose.sh", "up", "--detach", "--force-recreate"] });
    expect(io.stdout).toContain("0.1.0");
    expect(io.stdout).toContain("0.2.0");
    expect(io.stdout).toContain(backupPath);
    expect(io.stdout).toMatch(/[Hh]ealthy/);
  });

  it.each(["current", "older", "stopped", "missing"])("does not stage or mutate when the deployment is %s", async (condition) => {
    const state = scenario({ deployed: condition === "missing" ? undefined : "0.1.0", target: condition === "current" ? "0.1.0" : condition === "older" ? "0.0.9" : "0.2.0", stopped: condition === "stopped" });
    const before = snapshot(state.root);
    const { code, io } = await invoke(["upgrade"], state);
    expect(code).toBe(condition === "current" ? 0 : 1);
    expect(snapshot(state.root)).toEqual(before);
    expect(state.events.some((event) => ["create", "cp", "pull", "backup", "up"].includes(event.operation))).toBe(false);
    if (condition === "current") expect(io.stdout).toMatch(/[Cc]urrent/);
    if (condition === "stopped") expect(io.stderr).toContain("ub hub up");
  });

  it.each(["release-pull", "extract", "identity", "config", "pull"] as const)("preserves the live release and running containers after preflight %s failure", async (failure) => {
    const state = scenario({ deployed: "0.1.0", failure });
    const before = snapshot(state.directory);
    expect((await invoke(["upgrade"], state)).code).toBe(1);
    expect(snapshot(state.directory)).toEqual(before);
    expect(state.events.some((event) => ["backup", "up", "down", "stop"].includes(event.operation))).toBe(false);
  });

  it("refuses a target configuration that would move the database to a different volume before backup", async () => {
    const state = scenario({ deployed: "0.1.0", badVolumes: true });
    const before = snapshot(state.directory);
    expect((await invoke(["upgrade"], state)).code).toBe(1);
    expect(snapshot(state.directory)).toEqual(before);
    expect(state.events.some((event) => ["backup", "up"].includes(event.operation))).toBe(false);
  });

  it.each([false, true])("reports whether a completed backup exists after backup failure (restart failure=%s)", async (restart) => {
    const state = scenario({ deployed: "0.1.0", failure: restart ? "backup-restart" : "backup" });
    const before = snapshot(state.directory);
    const { code, io } = await invoke(["upgrade"], state);
    expect(code).toBe(1);
    const backup = state.events.find((event) => event.operation === "backup")?.args[1] as string;
    expect(existsSync(backup)).toBe(restart);
    expect(io.stderr).toMatch(/[Bb]ackup/);
    expect(io.stderr).toContain(backup);
    expect(JSON.parse(readFileSync(join(state.directory, "release.json"), "utf8")).version).toBe("0.1.0");
    expect(state.events.some((event) => event.operation === "up")).toBe(false);
    if (restart) {
      expect(io.stderr).toContain("ub hub up");
      expect(io.stderr).toMatch(/still down|did not|not running/i);
      rmSync(backup);
    }
    expect(snapshot(state.directory)).toEqual(before);
  });

  it("refuses replacement when the backup script exits successfully without publishing a file", async () => {
    const state = scenario({ deployed: "0.1.0", failure: "backup-no-file" });
    const before = snapshot(state.directory);
    const { code, io } = await invoke(["upgrade"], state);
    expect(code).toBe(1);
    expect(io.stderr).toMatch(/backup step.*did not publish/i);
    expect(io.stderr).toContain("No complete backup exists");
    expect(state.events.some((event) => event.operation === "up")).toBe(false);
    expect(snapshot(state.directory)).toEqual(before);
  });

  it("names the failed recreate, complete backup and recovery after replacement", async () => {
    const state = scenario({ deployed: "0.1.0", failure: "recreate" });
    const { code, io } = await invoke(["upgrade"], state);
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(join(state.directory, "release.json"), "utf8")).version).toBe("0.2.0");
    const backup = state.events.find((event) => event.operation === "backup")?.args[1] as string;
    expect(existsSync(backup)).toBe(true);
    expect(io.stderr).toContain(backup);
    expect(io.stderr).toContain("ub hub up");
    expect(io.stderr).toContain("REMOTE.md");
  });

  it("waits for the recreated hub to answer instead of reporting a successful upgrade as failed", async () => {
    vi.useFakeTimers();
    const state = scenario({ deployed: "0.1.0" });
    state.host.probe.mockResolvedValueOnce({ site: null, websocket: null })
      .mockResolvedValueOnce({ site: 200, websocket: 502 });
    const result = invoke(["upgrade"], state);
    await vi.runAllTimersAsync();
    const { code, io } = await result;
    expect(code).toBe(0);
    expect(state.host.probe).toHaveBeenCalledTimes(3);
    expect(io.stdout).toContain("health     healthy");
    expect(io.stderr).toContain("Waiting up to 90 seconds");
    expect(io.stderr).not.toContain("restore procedure");
    expect(state.events.filter((event) => event.operation === "backup")).toHaveLength(1);
    expect(state.events.filter((event) => event.operation === "up")).toHaveLength(1);
  });

  it("reports a deployment still unhealthy after the bounded wait with its backup and recovery", async () => {
    vi.useFakeTimers();
    const state = scenario({ deployed: "0.1.0", unhealthy: true });
    const started = Date.now();
    const result = invoke(["upgrade"], state);
    await vi.runAllTimersAsync();
    const { code, io } = await result;
    expect(code).toBe(1);
    expect(Date.now() - started).toBe(90_000);
    const backup = state.events.find((event) => event.operation === "backup")?.args[1] as string;
    expect(io.stderr).toMatch(/[Hh]ealth check/);
    expect(io.stderr).toContain("did not become healthy within 90 seconds");
    expect(io.stderr).toContain(backup);
    expect(io.stderr).toContain("ub hub up");
    expect(io.stderr).toContain("REMOTE.md");
    expect(JSON.parse(readFileSync(join(state.directory, "release.json"), "utf8")).version).toBe("0.2.0");
  });

  it.each(["refuse", "confirm", "yes"])("requires confirmation for a sync protocol change (%s)", async (confirmation) => {
    const state = scenario({ deployed: "0.1.0", protocol: 2, confirm: confirmation === "confirm" });
    const before = snapshot(state.directory);
    const { code, io } = await invoke(confirmation === "yes" ? ["upgrade", "--yes"] : ["upgrade"], state);
    expect(code).toBe(confirmation === "refuse" ? 1 : 0);
    expect(`${io.stdout}${io.stderr}`).toMatch(/every client|all clients/i);
    if (confirmation === "refuse") {
      expect(snapshot(state.directory)).toEqual(before);
      expect(state.events.some((event) => ["pull", "backup", "up"].includes(event.operation) && event.command === "sh")).toBe(false);
    }
    if (confirmation === "yes") expect(state.host.confirm).not.toHaveBeenCalled();
    else expect(state.host.confirm).toHaveBeenCalledOnce();
  });
});

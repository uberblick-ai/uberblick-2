/** Doctor verdicts against real isolated configuration and local hubs. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import type { StoredHubLogin } from "@uberblick/hub/auth-store";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import type { HubFailureCause } from "@uberblick/mcp-server";
import { CLOCK_SKEW_SECONDS, REQUEST_PROOF_LIFETIME_SECONDS } from "@uberblick/hub/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeviceSyncHub } from "../../hub/test/device-sync-hub.js";
import * as budget from "../src/budget.js";
import type { Check, DoctorReport } from "../src/doctor.js";
import { doctorReport, renderDoctor } from "../src/doctor.js";
import * as open from "../src/open.js";
import * as probes from "../src/probes.js";
import { rememberWorkspaceBinding } from "../src/workspace-registry.js";
import type { Run, Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, freePort, pointAt, removeTempDirs, runUbAsync, sandbox, unboundSandbox } from "./helpers.js";

const WORKSPACE = "9f2c47a1-5b83-4e60-91d7-2a6c8b40e3f5";
const PINNED = "3e8b1d09-47af-4c62-8f10-95d3c7b6a204";
const SECRET = "doctor-test-signing-secret-4b91c7";
const NAMES = ["workspace", "login", "database", "hub", "clock", "local hub", "mcp"];
const hubs: Hub[] = [];
const deviceHubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];
const servers: { server: Server | HttpServer; sockets: Socket[] }[] = [];

beforeEach(() => {
  // The web listener uses one fixed port, which may already belong to the
  // developer's `ub open`. Other socket observations remain real.
  const probePort = probes.probePort;
  vi.spyOn(probes, "probePort").mockImplementation((host, port) =>
    host === open.WEB_HOST && port === open.DEFAULT_WEB_PORT
      ? Promise.resolve({ host, port, state: "free", code: null })
      : probePort(host, port));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const hub of deviceHubs.splice(0)) await hub.close();
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  removeTempDirs();
});

async function startHub(box: Sandbox, protocolVersion = SYNC_PROTOCOL_VERSION, address = "127.0.0.1"): Promise<Hub> {
  const hub = await createHub({ authSecret: SECRET, protocolVersion, address, port: 0,
    databasePath: join(box.cwd, "hub.sqlite"), log: silentLogger,
    debounce: 20, maxDebounce: 200, shutdownTimeoutMs: 5_000 });
  hubs.push(hub);
  return hub;
}

async function foreignProcess(host = "127.0.0.1"): Promise<number> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  servers.push({ server, sockets });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no foreign process port");
  return address.port;
}

/** A websocket handshake without any directory-room response. */
async function silentServer(offsetSeconds: number | null = 0): Promise<{ port: number; clockRequests: number }> {
  const sockets: Socket[] = [];
  const reading = { port: 0, clockRequests: 0 };
  const server = createHttpServer((_request, response) => {
    reading.clockRequests += 1;
    response.sendDate = false;
    if (offsetSeconds !== null) response.setHeader("Date", new Date(Date.now() + offsetSeconds * 1_000).toUTCString());
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("hub clock");
  });
  server.on("connection", (socket: Socket) => sockets.push(socket));
  server.on("upgrade", (request, socket: Socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, sockets });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no silent server port");
  reading.port = address.port;
  return reading;
}

async function doctor(box: Sandbox, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ report: DoctorReport; checks: Map<string, Check>; ok: boolean }> {
  const { report } = await doctorReport({ env: { ...box.env, PORT: "1234", HUB_HOST: "127.0.0.1", CODEX_HOME: join(homeOf(box), ".codex"), ...extraEnv }, cwd: box.cwd });
  for (const one of report.checks) {
    expect(one.status).toMatch(/^(pass|warn|fail|skipped)$/);
    expect(one).toHaveProperty("fix");
    expect(one).not.toHaveProperty("remedy");
    if (one.status === "warn" || one.status === "fail") {
      expect(one.fix).toEqual(expect.any(String));
      expect(one.fix).not.toBe("");
    } else expect(one.fix).toBeNull();
    for (const line of [one, ...(one.listeners ?? [])]) {
      expect(line.reason).not.toMatch(/[`\r\n]/);
      if (line.fix !== null) {
        expect(line.fix).not.toMatch(/[`\r\n]/);
        expect(line.fix).not.toBe(line.reason);
      }
    }
  }
  expect(report.ok).toBe(!report.checks.some((one) => one.status === "fail"));
  return { report, checks: new Map(report.checks.map((one) => [one.name, one])), ok: report.ok };
}

function check(checks: Map<string, Check>, name: string): Check {
  const found = checks.get(name);
  if (found === undefined) throw new Error(`no ${name} check in the report`);
  return found;
}

function listener(checks: Map<string, Check>, name: "web server" | "hub listener"): Check {
  const combined = check(checks, "local hub");
  const detail = combined.listeners?.find((one) => one.name === name);
  if (detail !== undefined) return detail;
  // Equal listener verdicts share one serialized row; select its relevant
  // reason without letting the other listener's text affect assertions.
  const marker = `${name}: `;
  const start = combined.reason.indexOf(marker);
  return start === -1 ? combined : { ...combined,
    reason: combined.reason.slice(start + marker.length).split("; hub listener: ")[0] ?? "" };
}

async function mcpDoctor(
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ run: Run; checks: Map<string, Check>; ok: boolean }> {
  // PORT and HUB_HOST are the hub's half of the port configuration, and a
  // developer's shell may well have them: every test names them itself so the
  // listener checks answer about the fixture rather than about the machine.
  const run = await runUbAsync(["doctor", "--json"], box, {
    PORT: "1",
    HUB_HOST: "127.0.0.1",
    CODEX_HOME: join(homeOf(box), ".codex"),
    ...extraEnv,
  });
  const report = JSON.parse(run.stdout) as { ok: boolean; checks: Check[] };
  for (const one of report.checks) {
    expect(one.status).toMatch(/^(pass|warn|fail|skipped)$/);
    expect(one).toHaveProperty("fix");
    expect(one).not.toHaveProperty("remedy");
    if (one.status === "warn" || one.status === "fail") {
      expect(one.fix).toEqual(expect.any(String));
      expect(one.fix).not.toBe("");
    } else {
      expect(one.fix).toBeNull();
    }
  }
  const failed = report.checks.some((one) => one.status === "fail");
  expect(report.ok).toBe(!failed);
  expect(run.status).toBe(failed ? 1 : 0);
  return {
    run,
    ok: report.ok,
    checks: new Map(report.checks.map((check) => [check.name, check])),
  };
}

function homeOf(box: Sandbox): string {
  const home = box.env.HOME;
  if (home === undefined) throw new Error("the sandbox has no private HOME");
  return home;
}

const UNPINNED = { command: "ub", args: ["mcp", "serve"] };

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function wireMcp(box: Sandbox, entry: unknown = UNPINNED): string {
  const config = join(box.cwd, ".mcp.json");
  writeJson(config, { mcpServers: { uberblick: entry } });
  return config;
}

const CLIENTS = [
  { name: "Claude Code", path: ".mcp.json", userPath: ".claude.json" },
  { name: "Codex", path: ".codex/config.toml", userPath: ".codex/config.toml" },
  { name: "Cursor", path: ".cursor/mcp.json", userPath: ".cursor/mcp.json" },
] as const;

type Client = (typeof CLIENTS)[number];
type McpEntry = { command: string; args: string[]; env?: Record<string, unknown> };

function clientFile(box: Sandbox, client: Client, scope: "project" | "user"): string {
  return join(scope === "project" ? box.cwd : homeOf(box), scope === "project" ? client.path : client.userPath);
}

function wireClient(box: Sandbox, client: Client, scope: "project" | "user", entry: McpEntry = UNPINNED): string {
  const path = clientFile(box, client, scope);
  if (client.name !== "Codex") {
    writeJson(path, { mcpServers: { uberblick: entry } });
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[mcp_servers.uberblick]\n" +
      `command = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n` +
      (entry.env === undefined ? "" : "\n[mcp_servers.uberblick.env]\n" +
        Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("")), "utf8");
  }
  return path;
}

function pin(workspaceId = WORKSPACE, hubUrl = DEAD_HUB_URL): McpEntry {
  return { ...UNPINNED, env: { UB_WORKSPACE_ID: workspaceId, UB_HUB_URL: hubUrl } };
}

/** Give Claude local fixtures their own root, regardless of where TMPDIR lives. */
function repository(box: Sandbox): void {
  execFileSync("git", ["init", "--quiet", box.cwd], { env: box.env });
}

/** A well-formed stored login for cases with a stubbed network probe. */
function deviceBox(endpoint: string, username = "doctor-person"): Sandbox {
  const principalId = randomUUID();
  const login: StoredHubLogin = { identity: { id: principalId, githubAccountId: "12345", githubUsername: username },
    credential: { record: { id: randomUUID(), principalId, deviceId: randomUUID(), workspaces: [WORKSPACE], issuedAt: Date.now(), revokedAt: null }, key: Buffer.alloc(32, 1).toString("base64url") } };
  return sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
    userConfig: { hubAdmissions: { [endpoint]: "device" } },
    credentials: { signingSecret: SECRET, hubLogins: { [authenticationOrigin(endpoint)]: login } } });
}

describe("ub doctor", () => {
  it("reports exactly the seven ordered checks without configuration", async () => {
    const { checks, ok } = await doctor(unboundSandbox());
    expect([...checks.keys()]).toEqual(NAMES);
    for (const one of checks.values()) expect(one.reason).not.toBe("");
    expect(check(checks, "workspace")).toEqual({
      name: "workspace", status: "fail", reason: "no .uberblick.json here or in any parent directory",
      fix: "ub workspace create <name>, or ub workspace use <link|id>",
    });
    expect(ok).toBe(false);
  });

  it("skips login, hub and clock for local admission without reading a clock", async () => {
    const server = await silentServer(-61);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${server.port}` } });
    const hubProbe = vi.spyOn(probes, "probeHubState");
    const clockProbe = vi.spyOn(probes, "probeHubClock");
    const { checks } = await doctor(box, { PORT: String(server.port) });
    for (const name of ["login", "hub", "clock"]) {
      expect(check(checks, name).status).toBe("skipped");
      expect(check(checks, name).reason).not.toBe("");
    }
    expect(hubProbe).not.toHaveBeenCalled();
    expect(clockProbe).not.toHaveBeenCalled();
    expect(server.clockRequests).toBe(0);
    expect(listener(checks, "hub listener").reason).toMatch(/without a signing secret/);
  });

  it("reports the default database path and absent local secret", async () => {
    const port = await freePort();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` } });
    const { checks } = await doctor(box, { PORT: String(port) });
    expect(check(checks, "database").reason).toContain(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`));
    expect(listener(checks, "hub listener").status).toBe("skipped");
    expect(listener(checks, "hub listener").reason).toMatch(/no signing secret in force/);
    expect(listener(checks, "hub listener").reason).not.toMatch(/ub open starts/);
  });

  it("reports the complete environment binding ahead of the project file", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const { checks } = await doctor(box, { UB_WORKSPACE_ID: PINNED, UB_HUB_URL: "local" });
    expect(check(checks, "workspace").status).toBe("pass");
    expect(check(checks, "workspace").reason).toBe(`${PINNED}, from UB_WORKSPACE_ID and UB_HUB_URL`);
  });

  it("names the selecting project file and keeps the full uuid", async () => {
    const box = sandbox({ projectBinding: { workspaceId: `named-workspace-${WORKSPACE}`, hubUrl: null } });
    const { checks } = await doctor(box);
    expect(check(checks, "workspace").reason).toBe(`${WORKSPACE}, from ${join(box.cwd, ".uberblick.json")}`);
  });

  it("names only UB_WORKSPACE_ID when the machine's hub record selects the workspace", async () => {
    const box = sandbox({ projectBinding: { workspaceId: PINNED, hubUrl: null } });
    await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: null }, box.env);
    const { checks } = await mcpDoctor(box, { UB_WORKSPACE_ID: WORKSPACE });
    expect(check(checks, "workspace").reason).toBe(`${WORKSPACE}, from UB_WORKSPACE_ID`);
  });

  it.each([
    { description: "invalid JSON", raw: "{" },
    { description: "a malformed id", raw: JSON.stringify({ workspaceId: SECRET, hubUrl: null }) },
  ])("names the binding file refused for $description in one line", async ({ raw }) => {
    const box = sandbox({ raw: { projectBinding: raw } });
    const { checks } = await doctor(box);
    const workspace = check(checks, "workspace");
    expect(workspace.status).toBe("fail");
    expect(workspace.reason).toContain(join(box.cwd, ".uberblick.json"));
    expect(workspace.reason).not.toContain(SECRET);
    expect(workspace.fix).toBe("ub workspace create <name>, or ub workspace use <link|id>");
  });

  it("names a project binding path that is not a readable file", async () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    rmSync(path);
    mkdirSync(path);
    const { checks } = await doctor(box);
    expect(check(checks, "workspace").status).toBe("fail");
    expect(check(checks, "workspace").reason).toContain(path);
    expect(check(checks, "workspace").reason).toMatch(/(?:read|regular file)/i);
  });

  it.each([
    { description: "lone UB_HUB_URL", env: { UB_HUB_URL: DEAD_HUB_URL }, variable: "UB_HUB_URL" },
    { description: "empty UB_HUB_URL", env: { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "" }, variable: "UB_HUB_URL" },
    { description: "no recorded hub", env: { UB_WORKSPACE_ID: WORKSPACE }, variable: "UB_WORKSPACE_ID" },
    { description: "legacy WORKSPACE_ID", env: { WORKSPACE_ID: WORKSPACE }, variable: "WORKSPACE_ID" },
    { description: "legacy HUB_URL", env: { HUB_URL: DEAD_HUB_URL }, variable: "HUB_URL" },
    { description: "malformed UB_WORKSPACE_ID", env: { UB_WORKSPACE_ID: SECRET, UB_HUB_URL: "local" }, variable: "UB_WORKSPACE_ID" },
  ])("names the variable at fault for $description in one line", async ({ env, variable }) => {
    const { checks } = await doctor(sandbox(), env);
    const workspace = check(checks, "workspace");
    expect(workspace.status).toBe("fail");
    expect(workspace.reason).toContain(variable);
    expect(workspace.reason).not.toContain(SECRET);
    expect(workspace.reason).not.toBe("no .uberblick.json here or in any parent directory");
  });

  it.each(["unreadable", "refused"] as const)("separates a device credential file's %s reason and fix", async kind => {
    const endpoint = "wss://hub.example.invalid/custom-sync-path";
    const box = deviceBox(endpoint);
    const path = join(box.configHome, "uberblick", "credentials.json");
    if (kind === "unreadable") writeFileSync(path, "{", "utf8");
    else chmodSync(path, 0o644);
    const dial = vi.spyOn(probes, "probeHubState");
    const { checks } = await doctor(box);
    const login = check(checks, "login");
    expect(login.status).toBe("fail");
    expect(login.reason).toContain(path);
    expect(login.reason).toMatch(kind === "refused" ? /mode 0644/ : /(?:readable|JSON)/);
    expect(login.fix).toMatch(kind === "refused" ? /^chmod 600 / : /^repair /);
    expect(login.fix).not.toBe(login.reason);
    expect(dial).not.toHaveBeenCalled();
  });

  it("moves a refused local credentials file to local hub without printing its secret", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET }, credentialsMode: 0o644 });
    const { report, checks } = await doctor(box);
    const local = check(checks, "local hub");
    expect(check(checks, "login").status).toBe("skipped");
    expect(local.status).toBe("fail");
    expect(local.reason).toMatch(/mode 0644/);
    expect(local.fix).toMatch(/^(?:chmod 600|delete) .*credentials\.json/);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each(["ws://0.0.0.0", "ws://127.0.0.1"])("skips the hub and clock without dialing when device login is missing through %s", async host => {
    const server = await silentServer();
    const endpoint = `${host}:${server.port}`;
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      ...(host === "ws://127.0.0.1" ? { userConfig: { hubAdmissions: { [endpoint]: "device" } } } : {}),
      credentials: { signingSecret: SECRET } });
    const dial = vi.spyOn(probes, "probeHubState");
    const { checks } = await doctor(box);
    expect(check(checks, "login")).toEqual({ name: "login", status: "fail",
      reason: `not signed in to ${authenticationOrigin(endpoint)}`, fix: `ub auth login ${authenticationOrigin(endpoint)}` });
    expect(check(checks, "hub").status).toBe("skipped");
    expect(check(checks, "hub").reason).toMatch(/needs.*login/);
    expect(check(checks, "clock").status).toBe("skipped");
    expect(dial).not.toHaveBeenCalled();
    expect(server.clockRequests).toBe(0);
  });

  it.each(["ws://0.0.0.0", "ws://127.0.0.1"])("passes stored login and real device admission through %s", async host => {
    const remote = await startDeviceSyncHub({ directory: sandbox().cwd });
    deviceHubs.push(remote);
    remote.grant(WORKSPACE);
    const endpoint = `${host}:${remote.port}`;
    const login = remote.issue({ workspaces: [WORKSPACE] });
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      ...(host === "ws://127.0.0.1" ? { userConfig: { hubAdmissions: { [endpoint]: "device" } } } : {}),
      credentials: { signingSecret: SECRET, hubLogins: { [authenticationOrigin(endpoint)]: login } } });
    const { report, checks } = await doctor(box);
    expect(check(checks, "login")).toEqual({ name: "login", status: "pass",
      reason: `${login.identity.githubUsername} on ${authenticationOrigin(endpoint)}`, fix: null });
    expect(check(checks, "hub")).toEqual({ name: "hub", status: "pass",
      reason: `connected to ${authenticationOrigin(endpoint)}; ${login.identity.githubUsername} has access`, fix: null });
    expect(remote.authentications.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(login.credential.key);
    expect(check(checks, "local hub").listeners).toBeUndefined();
  });

  it("keeps a stopped device hub as a warning after a ready login", async () => {
    const endpoint = `ws://127.0.0.1:${await freePort()}/custom-proxy-path`;
    const { checks } = await doctor(deviceBox(endpoint));
    const hub = check(checks, "hub");
    expect(check(checks, "login").status).toBe("pass");
    expect(hub.status).toBe("warn");
    expect(hub.fix).toBe("check your network or VPN, or ask whoever runs the hub; your work stays here and syncs once it is back");
    expect(hub.reason).toBe(`refused by ${new URL(endpoint).host} (ECONNREFUSED)`);
    expect(hub.reason).not.toContain(endpoint);
    expect(hub.fix).not.toContain("ub open");
    expect(check(checks, "clock").status).toBe("skipped");
  });

  it.each<[HubFailureCause, string, string]>([
    ["dns", "ENOTFOUND hub.uberblick.ai", "DNS lookup failed for hub.uberblick.ai (ENOTFOUND)"],
    ["refused", "ECONNREFUSED 203.0.113.7:443", "refused by 203.0.113.7:443 (ECONNREFUSED)"],
    ["refused", "ECONNREFUSED [::1]:443", "refused by [::1]:443 (ECONNREFUSED)"],
    ["timeout", "1.5 203.0.113.7:443", "timed out after 1.5s connecting to 203.0.113.7:443"],
    ["timeout", "1.5 hub.uberblick.ai:443 ETIMEDOUT", "timed out after 1.5s connecting to hub.uberblick.ai:443 (ETIMEDOUT)"],
    ["tls", "ERR_TLS_CERT_ALTNAME_INVALID hub.uberblick.ai", "TLS certificate not valid for hub.uberblick.ai (ERR_TLS_CERT_ALTNAME_INVALID)"],
    ["tls", "ERR_SSL_WRONG_VERSION_NUMBER hub.uberblick.ai", "TLS failed for hub.uberblick.ai (ERR_SSL_WRONG_VERSION_NUMBER)"],
    ["http", "502 hub.uberblick.ai", "HTTP 502 from hub.uberblick.ai during WebSocket upgrade"],
    ["closed", "1001", "closed by the hub (code 1001)"],
  ])("names a %s socket failure without changing the hub warning or fix", async (cause, detail, reason) => {
    const endpoint = "wss://hub.uberblick.ai/ws";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "hub-down", url: endpoint,
      protocolVersion: SYNC_PROTOCOL_VERSION, cause, detail });
    const { report, checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "hub")).toEqual({ name: "hub", status: "warn", reason,
      fix: "check your network or VPN, or ask whoever runs the hub; your work stays here and syncs once it is back" });
    expect(renderDoctor(report)).toContain(reason);
    expect(check(checks, "clock").status).toBe("skipped");
  });

  it("keeps the existing hub warning when a socket failure has no cause", async () => {
    const endpoint = "wss://hub.example.invalid/ws";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "hub-down", url: endpoint,
      protocolVersion: SYNC_PROTOCOL_VERSION });
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "hub")).toEqual({ name: "hub", status: "warn", reason: `${authenticationOrigin(endpoint)} does not answer`,
      fix: "check your network or VPN, or ask whoever runs the hub; your work stays here and syncs once it is back" });
  });

  it.each<[HubFailureCause, string]>([
    ["tls", "ERR_TLS_CERT_ALTNAME_INVALID hub.example.invalid certificate text"],
    ["http", "502 wss://person:secret@hub.example.invalid/?token=secret"],
    ["closed", "1001 private close reason"],
  ])("does not render extra error or wire text in a %s detail", async (cause, detail) => {
    const endpoint = "wss://hub.example.invalid/ws";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "hub-down", url: endpoint,
      protocolVersion: SYNC_PROTOCOL_VERSION, cause, detail });
    const { report, checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "hub").reason).toBe(`${authenticationOrigin(endpoint)} does not answer`);
    expect(renderDoctor(report)).not.toContain(detail);
  });

  it.each(["wss://hub.example.invalid/custom-sync-path", "ws://hub.example.invalid:8080/custom-sync-path"])(
    "names the authentication origin for every device hub line at %s", async endpoint => {
      vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "connected", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
      vi.spyOn(probes, "probeHubClock").mockResolvedValue(-240);
      const { report, checks } = await doctor(deviceBox(endpoint));
      const origin = authenticationOrigin(endpoint);
      expect(check(checks, "login").reason).toBe(`doctor-person on ${origin}`);
      expect(check(checks, "hub").reason).toBe(`connected to ${origin}; doctor-person has access`);
      expect(check(checks, "clock").reason).toBe(`4 min ahead of ${origin}`);
      expect(JSON.stringify(report)).not.toContain(endpoint);
    },
  );

  it.each(["no-workspace-access", "sign-in-required", "credential-store", "renewal-unavailable"] as const)(
    "keeps the device refusal %s distinct and actionable", async authRecovery => {
      const endpoint = "wss://hub.example.invalid/custom-sync-path";
      vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "auth-failed", url: endpoint,
        protocolVersion: SYNC_PROTOCOL_VERSION, authRecovery, reason: `device refusal: ${authRecovery}` });
      vi.spyOn(probes, "probeHubClock").mockResolvedValue(0);
      const { checks } = await doctor(deviceBox(endpoint));
      const hub = check(checks, "hub");
      expect(hub.status).toBe("fail");
      expect(hub.reason).not.toContain("refused remote sync");
      if (authRecovery === "no-workspace-access") {
        expect(hub.reason).toBe(`doctor-person has no access to ${WORKSPACE}, or it doesn't exist on this hub`);
        expect(hub.fix).toBe("ask a workspace admin to run: ub workspace member add doctor-person");
        expect(hub.fix).not.toContain("ub auth login");
      } else if (authRecovery === "sign-in-required") {
        expect(hub.fix).toBe(`ub auth login ${authenticationOrigin(endpoint)}`);
      } else {
        expect(hub.reason).toMatch(authRecovery === "credential-store" ? /credential|stored login/ : /renew/);
        expect(hub.reason).not.toMatch(/no access|not signed in/);
      }
    },
  );

  it.each(["bad handle", "bad;handle", "doctor`person", "doctor\n\u001b[31m\u007f\u0085"])(
    "prints an invalid stored login safely and never embeds it in the access command: %j", async username => {
      const endpoint = "wss://hub.example.invalid";
      vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "auth-failed", url: endpoint,
        protocolVersion: SYNC_PROTOCOL_VERSION, authRecovery: "no-workspace-access" });
      vi.spyOn(probes, "probeHubClock").mockResolvedValue(0);
      const { checks } = await doctor(deviceBox(endpoint, username));
      const safe = JSON.stringify(username).replace(/[`\u007f-\u009f]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
      expect(check(checks, "login").reason).toBe(`${safe} on ${authenticationOrigin(endpoint)}`);
      expect(check(checks, "hub").reason).toBe(`${safe} has no access to ${WORKSPACE}, or it doesn't exist on this hub`);
      expect(check(checks, "hub").fix).toBe("ask a workspace admin for access");
    },
  );

  it.each([SYNC_PROTOCOL_VERSION + 1, SYNC_PROTOCOL_VERSION - 1])(
    "names who updates a device hub speaking protocol %s, preserving failure and its JSON fix", async hubVersion => {
      const endpoint = "wss://hub.example.invalid/custom-sync-path";
      vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "update-required", url: endpoint,
        protocolVersion: SYNC_PROTOCOL_VERSION, hubProtocolVersion: hubVersion });
      vi.spyOn(probes, "probeHubClock").mockResolvedValue(0);
      const box = deviceBox(endpoint);
      const { report, checks, ok } = await doctor(box);
      const mismatch = check(checks, "hub");
      expect(mismatch.status).toBe("fail");
      expect(ok).toBe(false);
      expect(mismatch.reason).toContain(authenticationOrigin(endpoint));
      if (hubVersion > SYNC_PROTOCOL_VERSION) expect(mismatch.fix).toMatch(/^ub update.*restart.*agents/);
      else {
        expect(mismatch.fix).toContain(authenticationOrigin(endpoint));
        expect(mismatch.fix).toMatch(/^ask .*update/);
        expect(mismatch.fix).not.toContain("ub update");
      }
      const json = JSON.parse(JSON.stringify(report)) as DoctorReport;
      expect(json.checks.find(one => one.name === "hub")?.fix).toBe(mismatch.fix);
      expect(renderDoctor(report, box.env)).toContain(`→ ${mismatch.fix}\n`);
    },
  );

  it("skips a free local listener and renders one line when both listeners skip", async () => {
    const port = await freePort();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` }, credentials: { signingSecret: SECRET } });
    const { report, checks } = await doctor(box, { PORT: String(port) });
    expect(check(checks, "local hub").status).toBe("skipped");
    expect(check(checks, "local hub").reason).toMatch(/ub open/);
    expect(check(checks, "local hub").reason).toMatch(/not running/);
    expect(renderDoctor(report).split("\n").filter(line => /^(?:ok|warn|FAIL|skip)\s+local hub\s/.test(line))).toHaveLength(1);
  });

  it("passes a running local hub and skips its clock check", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks } = await doctor(box, { PORT: String(hub.port) });
    expect(check(checks, "hub").status).toBe("skipped");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "local hub").status).toBe("pass");
    expect(listener(checks, "hub listener").status).toBe("pass");
    expect(listener(checks, "hub listener").reason).toMatch(/held by an uberblick hub/);
  });

  it("names both causes when the local hub refuses the secret", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: "a-secret-this-hub-was-not-deployed-with" } });
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks } = await doctor(box, { PORT: String(hub.port) });
    const local = check(checks, "local hub");
    expect(local.status).toBe("fail");
    expect(local.reason).toMatch(/refused the signing secret/);
    expect(local.fix).toMatch(/same (?:signing )?secret/);
    expect(local.fix).not.toContain("ub status");
  });

  it.each([["matching", SECRET, "pass"], ["refused", "another-local-signing-secret", "fail"]] as const)("reports an IPv6 local hub with a %s secret and HUB_HOST unset", async (_kind, signingSecret, status) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret } });
    const hub = await startHub(box, SYNC_PROTOCOL_VERSION, "::1");
    pointAt(box, `ws://[::1]:${hub.port}`);
    const { checks } = await doctor(box, { PORT: String(hub.port), HUB_HOST: undefined });
    expect(check(checks, "hub").status).toBe("skipped");
    const local = listener(checks, "hub listener");
    expect(local.status).toBe(status);
    expect(local.reason).toContain(`[::1]:${hub.port}`);
    expect(local.reason).toMatch(status === "pass" ? /held by an uberblick hub/ : /refused the signing secret/);
  });

  it.each([SYNC_PROTOCOL_VERSION + 1, SYNC_PROTOCOL_VERSION - 1])("explains sync protocol %s under local hub", async hubVersion => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await startHub(box, hubVersion);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks } = await doctor(box, { PORT: String(hub.port) });
    const mismatch = check(checks, "local hub");
    expect(mismatch.status).toBe("fail");
    expect(mismatch.reason).toContain(`this client speaks sync protocol ${SYNC_PROTOCOL_VERSION}`);
    expect(mismatch.reason).toContain(`the hub speaks ${hubVersion}`);
    if (hubVersion > SYNC_PROTOCOL_VERSION) expect(mismatch.fix).toMatch(/^ub update.*restart.*agents/);
    else {
      expect(mismatch.fix).toContain(`ws://127.0.0.1:${hub.port}`);
      expect(mismatch.fix).toMatch(/^ask .*update/);
      expect(mismatch.fix).not.toContain("ub update");
    }
  });

  it("fails a local hub that accepts a websocket but never serves the directory", async () => {
    const { port } = await silentServer();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` }, credentials: { signingSecret: SECRET } });
    const { checks } = await doctor(box, { PORT: String(port) });
    expect(check(checks, "local hub").status).toBe("fail");
    expect(check(checks, "local hub").reason).toMatch(/did not finish syncing/);
    expect(check(checks, "local hub").fix).toMatch(/ub open --no-browser/);
  });

  it("fails a foreign process holding the local hub port", async () => {
    const port = await foreignProcess();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` }, credentials: { signingSecret: SECRET } });
    const { checks } = await doctor(box, { PORT: String(port) });
    const local = check(checks, "local hub");
    expect(local.status).toBe("fail");
    expect(local.reason).toContain(`127.0.0.1:${port}`);
    expect(local.reason).toMatch(/not an uberblick hub/);
    expect(local.fix).toBe("stop that process, then run ub open");
    expect(local.fix).not.toContain("PORT");
  });

  it("skips an occupied local hub port when no signing secret can identify it", async () => {
    const port = await foreignProcess();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` } });
    const dial = vi.spyOn(probes, "probeHubState");
    const { checks } = await doctor(box, { PORT: String(port) });
    expect(check(checks, "local hub").status).toBe("skipped");
    expect(check(checks, "local hub").reason).toMatch(/signing secret/);
    expect(dial).not.toHaveBeenCalled();
  });

  it.each([["with", SECRET, "fail"], ["without", undefined, "skipped"]] as const)("reports a foreign IPv6 listener %s a secret with HUB_HOST unset", async (_kind, signingSecret, status) => {
    const port = await foreignProcess("::1");
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://[::1]:${port}` }, credentials: signingSecret === undefined ? undefined : { signingSecret } });
    const dial = vi.spyOn(probes, "probeHubState");
    const { checks } = await doctor(box, { PORT: String(port), HUB_HOST: undefined });
    const local = listener(checks, "hub listener");
    expect(local.status).toBe(status);
    expect(local.reason).toContain(`[::1]:${port}`);
    expect(local.reason).toMatch(status === "fail" ? /not an uberblick hub/ : /without a signing secret/);
    if (signingSecret === undefined) expect(dial).not.toHaveBeenCalled();
  });

  it.each(["not-a-number", "65536", "1.5"])("fails an invalid local PORT %s", async value => {
    const { checks } = await doctor(sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } }), { PORT: value });
    expect(check(checks, "local hub").status).toBe("fail");
    expect(check(checks, "local hub").reason).toContain(value);
    expect(check(checks, "local hub").reason).toMatch(/PORT/);
    expect(check(checks, "local hub").fix).toMatch(/^unset PORT\b/);
  });

  it("names both values when PORT disagrees with the local endpoint", async () => {
    const port = await freePort();
    const { checks } = await doctor(sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` } }), { PORT: "1" });
    const local = check(checks, "local hub");
    expect(local.status).toBe("fail");
    expect(local.reason).toContain(String(port));
    expect(local.reason).toContain("1");
    expect(local.fix).toMatch(/^unset PORT\b/);
  });

  it.each(["http://127.0.0.1:1234", "ftp://127.0.0.1:1234"])("fails a local endpoint that is not a websocket URL: %s", async endpoint => {
    // Binding parsing normally normalizes HTTP and rejects FTP before doctor
    // receives a config. Exercise the diagnostic's own invalid-endpoint guard.
    const resolveMcpConfig = budget.resolveMcpConfig;
    vi.spyOn(budget, "resolveMcpConfig").mockImplementation(env => ({ ...resolveMcpConfig(env), hubUrl: endpoint }));
    const { checks } = await doctor(sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } }));
    expect(check(checks, "local hub").status).toBe("fail");
    expect(check(checks, "local hub").reason).toMatch(/websocket|ws:/);
    expect(listener(checks, "hub listener").reason).not.toMatch(/ub open starts/);
  });

  it("does not promise ub open will start a refused secure local endpoint", async () => {
    const port = await freePort();
    const { checks } = await doctor(sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `wss://127.0.0.1:${port}` }, credentials: { signingSecret: SECRET } }), { PORT: String(port) });
    expect(listener(checks, "hub listener").reason).not.toMatch(/ub open starts/);
    expect(listener(checks, "hub listener").reason).toMatch(/wss|TLS|secure/i);
  });

  it.each([["62s fast", -62, "ahead of"], ["62s slow", 62, "behind"]] as const)("fails a device workspace clock %s", async (_name, offsetSeconds, direction) => {
    const server = await silentServer(offsetSeconds);
    const endpoint = `ws://127.0.0.1:${server.port}`;
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "unsettled", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "clock").status).toBe("fail");
    expect(check(checks, "clock").reason).toContain(`${direction} ${authenticationOrigin(endpoint)}`);
    expect(server.clockRequests).toBe(1);
    expect(check(checks, "clock").fix).toBe("turn on automatic time in your system settings");
  });

  it.each([0, 2, -2, -CLOCK_SKEW_SECONDS, REQUEST_PROOF_LIFETIME_SECONDS])(
    "passes a device clock offset of %ss, including either admission boundary", async skew => {
      const endpoint = "wss://hub.example.invalid/ws";
      vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "connected", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
      vi.spyOn(probes, "probeHubClock").mockResolvedValue(skew);
      const { checks } = await doctor(deviceBox(endpoint));
      expect(check(checks, "clock")).toEqual({ name: "clock", status: "pass",
        reason: `within ${Math.abs(skew)}s of the hub`, fix: null });
    },
  );

  it.each([
    { skew: -CLOCK_SKEW_SECONDS - 1, offset: `${CLOCK_SKEW_SECONDS + 1}s`, direction: "ahead of" },
    { skew: REQUEST_PROOF_LIFETIME_SECONDS + 1, offset: `${REQUEST_PROOF_LIFETIME_SECONDS + 1}s`, direction: "behind" },
    { skew: -240, offset: "4 min", direction: "ahead of" },
    { skew: 900, offset: "15 min", direction: "behind" },
  ])("fails a device clock $offset $direction the hub", async ({ skew, offset, direction }) => {
    const endpoint = "wss://hub.example.invalid/ws";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "connected", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    vi.spyOn(probes, "probeHubClock").mockResolvedValue(skew);
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "clock")).toEqual({ name: "clock", status: "fail",
      reason: `${offset} ${direction} ${authenticationOrigin(endpoint)}`, fix: "turn on automatic time in your system settings" });
    expect(check(checks, "clock").reason).not.toMatch(/tolerance|HTTP|Date|proxy/);
  });

  it.each(["hub-down", "connecting", "disabled"] as const)("does not read a device hub clock when its probe is %s", async status => {
    const server = await silentServer(-61);
    const endpoint = `ws://127.0.0.1:${server.port}`;
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status, url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toBe("needs the hub");
    expect(server.clockRequests).toBe(0);
  });

  it("skips a reached device hub clock when its HTTP Date cannot be read", async () => {
    const server = await silentServer(null);
    const endpoint = `ws://127.0.0.1:${server.port}`;
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "unsettled", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "hub").status).toBe("warn");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toBe(`${authenticationOrigin(endpoint)} did not provide a clock reading`);
    expect(server.clockRequests).toBe(1);
  });

  it.each([["ub-open", "pass"], ["foreign", "fail"], ["unidentified", "skipped"]] as const)("reports the default web port held by %s as %s for a device workspace", async (holder, status) => {
    const endpoint = "wss://hub.example.invalid";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "hub-down", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    vi.mocked(probes.probePort).mockResolvedValue({ host: open.WEB_HOST, port: open.DEFAULT_WEB_PORT, state: "in-use", code: null });
    const identify = vi.spyOn(open, "whoHoldsPort").mockResolvedValue(holder);
    const { checks } = await doctor(deviceBox(endpoint), { PORT: "invalid" });
    expect(probes.probePort).toHaveBeenCalledExactlyOnceWith("127.0.0.1", open.DEFAULT_WEB_PORT);
    expect(identify).toHaveBeenCalledExactlyOnceWith(open.DEFAULT_WEB_PORT);
    expect(check(checks, "local hub").status).toBe(status);
    expect(check(checks, "local hub").reason).toContain(String(open.DEFAULT_WEB_PORT));
  });

  it("skips a free default web port without trying to identify its holder", async () => {
    const identify = vi.spyOn(open, "whoHoldsPort");
    const endpoint = "wss://hub.example.invalid";
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: "hub-down", url: endpoint, protocolVersion: SYNC_PROTOCOL_VERSION });
    const { checks } = await doctor(deviceBox(endpoint));
    expect(check(checks, "local hub").status).toBe("skipped");
    expect(check(checks, "local hub").reason).toMatch(/not running.*ub open/);
    expect(identify).not.toHaveBeenCalled();
  });

  it.each(["web server", "hub listener"] as const)("fails the combined check when the %s fails and prints both listener verdicts", async failed => {
    const port = await freePort();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${port}` }, credentials: { signingSecret: SECRET } });
    vi.mocked(probes.probePort).mockImplementation((host, candidate) => Promise.resolve({ host, port: candidate, state: candidate === open.DEFAULT_WEB_PORT ? "in-use" : "free", code: null }));
    vi.spyOn(open, "whoHoldsPort").mockResolvedValue(failed === "web server" ? "foreign" : "ub-open");
    const { report, checks } = await doctor(box, { PORT: failed === "hub listener" ? "1" : String(port) });
    expect(check(checks, "local hub").status).toBe("fail");
    const lines = renderDoctor(report).split("\n").filter(line => /^(?:ok|warn|FAIL|skip)\s+local hub\s/.test(line));
    expect(lines).toHaveLength(2);
    expect(lines.some(line => line.includes("web server"))).toBe(true);
    expect(lines.some(line => line.includes("hub listener"))).toBe(true);
    expect(lines.find(line => line.includes(failed))).toMatch(/^FAIL/);
    expect(report.checks.filter(one => one.name === "local hub")).toHaveLength(1);
  });

  it.each(["pass", "fail"] as const)("renders one local hub line when both listeners %s", async status => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    vi.mocked(probes.probePort).mockImplementation((host, port) => Promise.resolve({ host, port, state: "in-use", code: null }));
    vi.spyOn(open, "whoHoldsPort").mockResolvedValue(status === "pass" ? "ub-open" : "foreign");
    vi.spyOn(probes, "probeHubState").mockResolvedValue({ status: status === "pass" ? "connected" : "auth-failed", url: "ws://localhost:1234", protocolVersion: SYNC_PROTOCOL_VERSION });
    const { report, checks } = await doctor(box);
    expect(check(checks, "local hub").status).toBe(status);
    expect(check(checks, "local hub").listeners).toBeUndefined();
    expect(renderDoctor(report).split("\n").filter(line => /^(?:ok|warn|FAIL|skip)\s+local hub\s/.test(line))).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)("fails database when its nearest existing directory is not writable", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const readOnly = join(box.cwd, "read-only");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      const database = join(readOnly, "missing", "uberblick.sqlite");
      const { checks } = await doctor(box, { UBERBLICK_DB: database });
      expect(check(checks, "database").status).toBe("fail");
      expect(check(checks, "database").reason).toContain(database);
      expect(check(checks, "database").fix).toMatch(/UBERBLICK_DB/);
    } finally { chmodSync(readOnly, 0o700); }
  });

  it("writes one JSON object with seven checks and its matching exit status", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const run = await runUbAsync(["doctor", "--json"], box, { PORT: "1234", HUB_HOST: "127.0.0.1" });
    const report = JSON.parse(run.stdout) as DoctorReport;
    expect(report.checks.map(one => one.name)).toEqual(NAMES);
    expect(report.ok).toBe(!report.checks.some(one => one.status === "fail"));
    expect(run.status).toBe(report.ok ? 0 : 1);
    expect(run.output).not.toContain(SECRET);
  });

  it("keeps a warning-only report successful for scripts and human output", async () => {
    const box = deviceBox(`ws://127.0.0.1:${await freePort()}`);
    const { report, checks, ok } = await doctor(box);
    expect(check(checks, "hub").status).toBe("warn");
    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(ok).toBe(true);
    const text = renderDoctor(report);
    expect(text).toMatch(/warn {2}hub/);
    expect(text).toMatch(/skip {2}clock {7}needs the hub/);
    expect(text).toMatch(/0 failed, 2 warnings, \d+ passed, \d+ skipped/);
  });

  it.each([0, 1, 2])("renders fixes only for problems and counts %s warnings", warnings => {
    const checks: Check[] = [
      { name: "workspace", status: "pass", reason: "configured", fix: null },
      { name: "login", status: "skipped", reason: "local workspace", fix: null },
      { name: "mcp", status: "fail", reason: "not registered", fix: "ub mcp install claude" },
      ...Array.from({ length: warnings }, (_, index): Check => ({ name: `hub ${index + 1}`, status: "warn", reason: "hub unavailable", fix: "check the network" })),
    ];
    const text = renderDoctor({ version: "test", ok: false, checks });
    expect(text).toContain("ok    workspace   configured\n");
    expect(text).toContain("skip  login       local workspace\n");
    expect(text).toContain("FAIL  mcp         not registered\n      → ub mcp install claude\n");
    expect(text.match(/→ /g)).toHaveLength(warnings + 1);
    expect(text).toContain(`1 failed, ${warnings} ${warnings === 1 ? "warning" : "warnings"}, 1 passed, 1 skipped\n`);
  });
});

// These checks keep their real CLI exit and output assertions across base changes.
describe("ub doctor MCP setup", () => {
  it("reports which MCP client is wired up, and points at `ub mcp install` when none is", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const none = await mcpDoctor(box);

    expect(check(none.checks, "mcp")).toEqual({
      name: "mcp",
      status: "warn",
      reason: "MCP client is not set up for this project",
      fix: "ub mcp install claude   (or codex)",
    });
    expect(none.run.status).toBe(0);

    wireMcp(box);
    const wired = await mcpDoctor(box);

    expect(check(wired.checks, "mcp").status).toBe("pass");
    expect(check(wired.checks, "mcp").reason).toBe("Claude Code (.mcp.json)");
    const human = await runUbAsync(["doctor"], box, { PORT: "1" });
    expect(human.stdout).toContain("ok    mcp         Claude Code (.mcp.json)\n");
  });

  it("ignores another server's multiline args in Codex's user config when Claude Code is set up", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireMcp(box);
    const config = join(homeOf(box), ".codex", "config.toml");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '[mcp_servers.github]\ncommand = "other"\nargs = [\n' +
      '  "serve",\n  "--token=SECRET",\n]\nlarge_integer = 9007199254740993\n', "utf8");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp")).toEqual({
      name: "mcp", status: "pass", reason: "Claude Code (.mcp.json)", fix: null,
    });
    expect(run.status).toBe(0);
  });

  it.each([
    {
      layout: "inline env",
      text: '[mcp_servers.uberblick]\ncommand = "custom"\n' +
        `env = { UB_WORKSPACE_ID = "${WORKSPACE}", UB_HUB_URL = "${DEAD_HUB_URL}", API_TOKEN = "${SECRET}" }\n`,
    },
    {
      layout: "dotted env keys",
      text: '[mcp_servers.uberblick]\ncommand = "custom"\n' +
        `env.UB_WORKSPACE_ID = "${WORKSPACE}"\nenv.UB_HUB_URL = "${DEAD_HUB_URL}"\nenv.API_TOKEN = "${SECRET}"\n`,
    },
  ])("accepts Codex's current pins in $layout", async ({ text }) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = clientFile(box, CLIENTS[1], "project");
    mkdirSync(dirname(path));
    writeFileSync(path, text, "utf8");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp")).toEqual({
      name: "mcp", status: "pass", reason: "Codex (.codex/config.toml)", fix: null,
    });
    expect(run.status).toBe(0);
    expect(run.output).not.toContain(SECRET);
  });

  it.each(CLIENTS)("reads $name's project config beside the binding and ignores a subdirectory's shadow", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireClient(box, client, "project", { command: "mise", args: ["exec", "--", "ub", "mcp", "serve"] });
    const nested = { ...box, cwd: join(box.cwd, "src") };
    mkdirSync(nested.cwd);
    wireClient(nested, client, "project", pin(PINNED));
    const { checks } = await mcpDoctor(nested);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`${client.name} (${client.path})`);
  });

  it("uses the working directory for an environment binding and names every set-up client", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const nested = { ...box, cwd: join(box.cwd, "src") };
    mkdirSync(nested.cwd);
    for (const client of CLIENTS) {
      wireClient(box, client, "project", pin(PINNED));
      wireClient(nested, client, "project", { command: "custom-wrapper", args: ["anything"] });
    }
    const { checks } = await mcpDoctor(nested, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: DEAD_HUB_URL });

    expect(check(checks, "mcp").status).toBe("pass");
    for (const client of CLIENTS) {
      expect(check(checks, "mcp").reason).toContain(`${client.name} (${client.path})`);
    }
    expect(check(checks, "mcp").reason).not.toMatch(/\(project\)|\(user\)|custom-wrapper/);
  });

  it.each(CLIENTS)("accepts an unpinned custom command in $name's user config", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = wireClient(box, client, "user", { command: SECRET, args: ["custom"], env: { API_TOKEN: SECRET } });
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`${client.name} (${path})`);
    expect(run.output).not.toContain(SECRET);
  });

  it.each(CLIENTS)("accepts $name's current pin with the workspace slug and normalized hub", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://hub.example.invalid/ws" } });
    wireClient(box, client, "project", pin(`a-workspace-${WORKSPACE}`, "https://hub.example.invalid"));
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`${client.name} (${client.path})`);
  });

  it("accepts the install pin for a local workspace whose project binding has a slug", async () => {
    const box = sandbox({ projectBinding: { workspaceId: `a-workspace-${WORKSPACE}`, hubUrl: null } });
    wireMcp(box, pin(WORKSPACE, "local"));
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
  });

  it.each([
    { hubUrl: DEAD_HUB_URL, workspaceId: WORKSPACE },
    { hubUrl: null, workspaceId: `a-workspace-${WORKSPACE}` },
  ])("resolves an id-only MCP pin through this machine's record ($hubUrl)", async ({ hubUrl, workspaceId }) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl } });
    await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl }, box.env);
    wireMcp(box, { ...UNPINNED, env: { UB_WORKSPACE_ID: workspaceId } });
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe("Claude Code (.mcp.json)");
  });

  it("warns about an id-only MCP pin without a machine record even when the project names that workspace", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireMcp(box, { ...UNPINNED, env: { UB_WORKSPACE_ID: WORKSPACE } });
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("could not read workspace pin");
  });

  it("warns when an id-only MCP pin's recorded hub differs from the project", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: null }, box.env);
    wireMcp(box, { ...UNPINNED, env: { UB_WORKSPACE_ID: WORKSPACE } });
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("pinned to another workspace or hub");
  });

  it.each([
    { what: "another workspace", env: { UB_WORKSPACE_ID: PINNED, UB_HUB_URL: DEAD_HUB_URL } },
    { what: "a local pin left after promote", env: { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" } },
    { what: "the same workspace on another hub", env: { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "wss://other.example.invalid/ws" } },
    { what: "an incomplete workspace pair", env: { UB_WORKSPACE_ID: SECRET } },
    { what: "an incomplete hub pair", env: { UB_HUB_URL: SECRET } },
    { what: "a refused legacy workspace variable", env: { WORKSPACE_ID: SECRET } },
    { what: "a refused legacy hub variable", env: { HUB_URL: SECRET } },
    { what: "a value the binding resolver refuses", env: { UB_WORKSPACE_ID: SECRET, UB_HUB_URL: DEAD_HUB_URL } },
    { what: "a non-string pin", env: { UB_WORKSPACE_ID: [SECRET], UB_HUB_URL: DEAD_HUB_URL } },
  ])("warns about $what instead of passing or leaking entry values", async ({ env }) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireMcp(box, { ...UNPINNED, env });
    // Another configured client cannot turn an unsafe pin into a pass.
    wireClient(box, CLIENTS[1], "project");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Claude Code (.mcp.json)");
    expect(run.status).toBe(0);
    expect(run.output).not.toContain(SECRET);
    expect(check(checks, "mcp").reason).not.toContain(PINNED);
    expect(check(checks, "mcp").reason).not.toContain("other.example.invalid");
  });

  it("reads Claude Code's local entry at the repository root even when the binding is in a package", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    repository(box);
    const project = { ...box, cwd: join(box.cwd, "package") };
    mkdirSync(project.cwd);
    writeJson(join(project.cwd, ".uberblick.json"), { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL });
    wireMcp(project);
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, {
      mcpServers: { uberblick: UNPINNED },
      projects: {
        [box.cwd]: { mcpServers: { uberblick: pin(PINNED) } },
        [project.cwd]: { mcpServers: { uberblick: UNPINNED } },
      },
    });
    const { checks } = await mcpDoctor(project);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`Claude Code (${path})`);
  });

  it("reads Claude Code's local entry under the project root outside a repository", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, { projects: {
      [box.cwd]: { mcpServers: { uberblick: UNPINNED } },
    } });
    // Scratch may itself be in a checkout. Bound Git's discovery to this
    // sandbox so the fixture still represents a project outside a repository.
    const { checks } = await mcpDoctor(box, { GIT_CEILING_DIRECTORIES: homeOf(box) });

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`Claude Code (${path})`);
  });

  it.each([null, "git-storage", "metadata/.git"])("uses Claude Code's shared local key in a linked worktree (Git metadata: %s)", async metadata => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    let localKey = box.cwd;
    if (metadata === null) repository(box);
    else {
      const gitDirectory = join(homeOf(box), metadata);
      mkdirSync(dirname(gitDirectory), { recursive: true });
      execFileSync("git", ["init", "--quiet", "--separate-git-dir", gitDirectory, box.cwd], { env: box.env });
      localKey = metadata.endsWith(".git") ? dirname(gitDirectory) : gitDirectory;
    }
    const tree = execFileSync("git", ["hash-object", "-t", "tree", "--stdin", "-w"], { cwd: box.cwd, env: box.env, input: "", encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["commit-tree", tree, "-m", "fixture"], {
      cwd: box.cwd,
      env: { ...box.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
      encoding: "utf8",
    }).trim();
    const project = { ...box, cwd: join(homeOf(box), "linked-worktree") };
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", project.cwd, commit], { cwd: box.cwd, env: box.env });
    writeJson(join(project.cwd, ".uberblick.json"), { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL });
    wireMcp(project);
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, { projects: {
      [localKey]: { mcpServers: { uberblick: pin(PINNED) } },
      [project.cwd]: { mcpServers: { uberblick: UNPINNED } },
    } });
    const { checks } = await mcpDoctor(project);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`Claude Code (${path})`);
  });

  it("uses the working repository root when Git metadata is stored separately in a .git directory", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const metadataRoot = join(homeOf(box), "metadata");
    mkdirSync(metadataRoot);
    execFileSync("git", ["init", "--quiet", "--separate-git-dir", join(metadataRoot, ".git"), box.cwd], { env: box.env });
    wireMcp(box);
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, { projects: {
      [box.cwd]: { mcpServers: { uberblick: pin(PINNED) } },
      [metadataRoot]: { mcpServers: { uberblick: UNPINNED } },
    } });
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`Claude Code (${path})`);
  });

  it("lets Claude Code's project entry hide a user pin, then its local entry hide the project pin", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    repository(box);
    wireClient(box, CLIENTS[0], "user", pin(PINNED));
    wireMcp(box);
    const project = await mcpDoctor(box);

    expect(check(project.checks, "mcp").status).toBe("pass");
    expect(check(project.checks, "mcp").reason).toBe("Claude Code (.mcp.json)");

    wireMcp(box, pin(PINNED));
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, { mcpServers: { uberblick: pin(PINNED) }, projects: {
      [box.cwd]: { mcpServers: { uberblick: UNPINNED } },
    } });
    const local = await mcpDoctor(box);

    expect(check(local.checks, "mcp").status).toBe("pass");
    expect(check(local.checks, "mcp").reason).toBe(`Claude Code (${path})`);
  });

  it.each(CLIENTS.filter(client => client.name !== "Claude Code").flatMap(client => [
    { client, badScope: "project" as const },
    { client, badScope: "user" as const },
  ]))("counts $client.name's $badScope pin even with a set-up entry in the other scope", async ({ client, badScope }) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const badPath = wireClient(box, client, badScope, pin(PINNED));
    wireClient(box, client, badScope === "project" ? "user" : "project");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`${client.name} (${badScope === "project" ? client.path : badPath})`);
    expect(run.status).toBe(0);
    expect(check(checks, "mcp").reason).not.toContain(PINNED);
  });

  it.each([
    `[mcp_servers.uberblick]\ncommand = "ub"\n[mcp_servers.uberblick.env]\nUB_WORKSPACE_ID = "${SECRET}"\n`,
    `[mcp_servers]\nuberblick = { command = "ub", env = { UB_WORKSPACE_ID = "${SECRET}" } }\n`,
  ])("warns when Codex's workspace pin is incomplete", async text => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = clientFile(box, CLIENTS[1], "project");
    mkdirSync(dirname(path));
    writeFileSync(path, text, "utf8");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Codex (.codex/config.toml)");
    expect(run.output).not.toContain(SECRET);
  });

  it("reports malformed Codex TOML without exposing its source or parser diagnostics", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireMcp(box);
    const path = clientFile(box, CLIENTS[1], "project");
    mkdirSync(dirname(path));
    writeFileSync(path, `[mcp_servers.uberblick]\ncommand = "${SECRET}\n`, "utf8");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp")).toEqual({
      name: "mcp", status: "warn", reason: "could not read Codex (.codex/config.toml)",
      fix: "repair or move the file named above, then ub mcp install claude   (or codex)",
    });
    const human = await runUbAsync(["doctor"], box, {
      PORT: "1", HUB_HOST: "127.0.0.1", CODEX_HOME: join(homeOf(box), ".codex"),
    });
    expect(human.stdout).toContain("warn  mcp         could not read Codex (.codex/config.toml)\n");
    for (const result of [run, human]) {
      expect(result.status).toBe(0);
      expect(result.output).not.toContain(SECRET);
      expect(result.output).not.toMatch(/SyntaxError|TomlError|Invalid TOML|parse error|line \d|column \d/);
    }
  });

  it("skips MCP when the workspace check has no usable binding", async () => {
    const box = sandbox({ raw: { projectBinding: `{ "workspaceId": "${SECRET}" }\n` } });
    wireMcp(box, pin(PINNED));
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "workspace").status).toBe("fail");
    expect(check(checks, "mcp").status).toBe("skipped");
    expect(check(checks, "mcp").reason).toBe("needs a workspace");
  });

  it("names a config it could not read, instead of calling it absent", async () => {
    // "No MCP client registers uberblick" would be an answer this check does
    // not have: the file is there and nothing here knows what is in it. It is
    // named by path and quoted nowhere — a config file is where tokens live.
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const config = join(box.cwd, ".mcp.json");
    writeFileSync(config, `{ "mcpServers": { "uberblick": "${SECRET}"\n`, "utf8");
    const { run, checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Claude Code (.mcp.json)");
    expect(check(checks, "mcp").reason).toMatch(/could not read/);
    expect(check(checks, "mcp").fix).toMatch(/repair or move/);
    expect(run.status).toBe(0);
    expect(run.output).not.toContain(SECRET);
  });

  it("names an unreadable Claude user/local config once and never quotes its parser error", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = join(homeOf(box), ".claude.json");
    writeFileSync(path, `{ "mcpServers": { "uberblick": "${SECRET}"\n`, "utf8");
    const { checks, run } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`Claude Code (${path})`);
    expect(check(checks, "mcp").reason.split(path)).toHaveLength(2);
    expect(check(checks, "mcp").fix).toMatch(/repair or move/);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(/SyntaxError|Unexpected token|JSON at position/);
  });

  it("treats a config path it cannot open as a warning even when another client is set up", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    mkdirSync(join(box.cwd, ".mcp.json"));
    wireClient(box, CLIENTS[1], "project");
    const { checks } = await mcpDoctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Claude Code (.mcp.json)");
    expect(check(checks, "mcp").reason).toMatch(/could not read/);
  });

  it("renders the same verdicts for a human, with the fix under the warning", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const run = await runUbAsync(["doctor"], box, { PORT: "1" });

    expect(run.stdout).toMatch(/ok {4}workspace/);
    expect(run.stdout).toMatch(/skip {2}login/);
    expect(run.stdout).toMatch(/warn {2}mcp/);
    expect(run.stdout).toContain("→ ub mcp install claude   (or codex)\n");
    expect(run.stdout).toMatch(/0 failed, 1 warning, \d+ passed, \d+ skipped/);
    expect(run.stdout.match(/→ /g)).toHaveLength(1);
    expect(run.status).toBe(0);
  });

  it("shortens home paths only in human output and keeps JSON reasons and fixes absolute", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { signingSecret: SECRET }, credentialsMode: 0o644 });
    const { report } = await doctor(box);
    const absoluteHome = homeOf(box);
    const human = renderDoctor(report, box.env);
    expect(human).toContain(`${WORKSPACE}, from ~/checkout/.uberblick.json`);
    expect(human).toContain(`~/data/uberblick/${WORKSPACE}.sqlite`);
    expect(human).toContain("~/config/uberblick/credentials.json");
    expect(human).not.toContain(absoluteHome);
    const json = JSON.stringify(report);
    expect(json).toContain(join(box.cwd, ".uberblick.json"));
    expect(json).toContain(join(box.configHome, "uberblick", "credentials.json"));
    expect(json).toContain(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`));
    expect(json).not.toContain("~/");
  });

  it.each(["neighbor", "embedded"] as const)("does not shorten an outside directory with a %s home substring", kind => {
    const box = sandbox();
    const home = homeOf(box);
    const path = kind === "neighbor" ? `${home}-neighbor/database.sqlite` : `/archive${home}/database.sqlite`;
    const report: DoctorReport = { version: "0.0.0", ok: false, checks: [
      { name: "database", status: "fail", reason: `${path}: cannot read the store`, fix: `restore access to ${path}` },
    ] };
    const text = renderDoctor(report, box.env);
    expect(text).toContain(path);
    expect(text).not.toContain("~");
  });
});

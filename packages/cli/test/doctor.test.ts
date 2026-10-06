/**
 * `ub doctor` — one test per documented failure mode, and one per property the
 * report itself has to hold.
 *
 * The checks are only worth anything if they are right about the world, so the
 * world is real here: a real hub on an ephemeral port, a real foreign process
 * holding one, a real unwritable directory. Every run goes through
 * {@link runUbAsync}, never `runUb`: `spawnSync` blocks this process's event
 * loop, so a `ub` child probing a hub or a socket *this* process is serving
 * would find it unreachable and the test would assert the opposite of the
 * truth.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { AUTH_REJECTED, SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { renderDoctor } from "../src/doctor.js";
import type { Run, Sandbox } from "./helpers.js";
import {
  DEAD_HUB_URL,
  pointAt,
  removeTempDirs,
  runUbAsync,
  sandbox,
  unboundSandbox,
} from "./helpers.js";

const WORKSPACE = "9f2c47a1-5b83-4e60-91d7-2a6c8b40e3f5";
/** A second workspace, for the case where the environment pins another. */
const PINNED = "3e8b1d09-47af-4c62-8f10-95d3c7b6a204";
const SECRET = "doctor-test-signing-secret-4b91c7";

const hubs: Hub[] = [];
const servers: { server: Server | HttpServer; sockets: Socket[] }[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  removeTempDirs();
});

async function startHub(
  box: Sandbox,
  protocolVersion = SYNC_PROTOCOL_VERSION,
): Promise<Hub> {
  const hub = await createHub({
    authSecret: SECRET,
    protocolVersion,
    port: 0,
    databasePath: join(box.cwd, "hub.sqlite"),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  return hub;
}

/** A process that holds a port and answers nothing — the foreign-holder case. */
async function foreignProcess(): Promise<number> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, sockets });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the foreign process did not bind a port");
  }
  return address.port;
}

/**
 * A server that completes the websocket handshake and then says nothing.
 *
 * The far side that is up, speaks enough of the protocol to open a socket, and
 * never serves the room. Its separate HTTP response supplies a clock reading,
 * including a missing Date or a failed upgrade when a test asks for one.
 */
async function silentServer(
  offsetSeconds: number | null = 0,
  upgrade: "accept" | "refuse" | "pending" = "accept",
): Promise<{ port: number; clockRequests: number }> {
  const sockets: Socket[] = [];
  const reading = { port: 0, clockRequests: 0 };
  const server = createHttpServer((_request, response) => {
    reading.clockRequests += 1;
    response.sendDate = false;
    if (offsetSeconds !== null) {
      response.setHeader(
        "Date",
        new Date(Date.now() + offsetSeconds * 1_000).toUTCString(),
      );
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("hub clock");
  });
  server.on("connection", (socket: Socket) => sockets.push(socket));
  server.on("upgrade", (request, socket: Socket) => {
    if (upgrade === "pending") return;
    if (upgrade === "refuse") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // …and not one frame after that.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, sockets });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server did not bind a port");
  }
  reading.port = address.port;
  return reading;
}

/** A port nothing is listening on: bound, read back, and released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

interface Check {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  reason: string;
  fix: string | null;
}

async function doctor(
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ run: Run; checks: Map<string, Check>; ok: boolean }> {
  // PORT and HUB_HOST are the hub's half of the port configuration, and a
  // developer's shell may well have them: every test names them itself so the
  // port checks answer about the fixture rather than about the machine.
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

function check(checks: Map<string, Check>, name: string): Check {
  const found = checks.get(name);
  if (found === undefined) {
    throw new Error(`no ${name} check in the report`);
  }
  return found;
}

describe("ub doctor", () => {
  it("reports every check with no configuration at all, and never throws", async () => {
    const box = unboundSandbox();
    const { run, checks, ok } = await doctor(box);

    // A stack with nothing configured still gets an answer for every check.
    expect([...checks.keys()]).toEqual([
      "workspace",
      "credential",
      "database",
      "persistence",
      "hub",
      "clock",
      "port",
      "bind",
      "mcp",
    ]);
    for (const one of checks.values()) {
      expect(one.status).toMatch(/^(pass|warn|fail|skipped)$/);
      expect(one.reason).not.toBe("");
      if (one.status === "fail") {
        expect(one.fix).not.toBeNull();
      }
    }
    // The one value with no default: a failed check naming the two commands
    // that set one, not a thrown error.
    expect(check(checks, "workspace").status).toBe("fail");
    expect(check(checks, "workspace").fix).toMatch(/ub init/);
    expect(check(checks, "workspace").fix).toMatch(/ub workspace use/);
    expect(check(checks, "workspace").fix).toMatch(/ub workspace join/);
    // The recovery explains the explicit project binding rather than directing
    // the operator to the obsolete machine-wide default.
    expect(check(checks, "workspace").reason).toContain(".uberblick.json");
    expect(check(checks, "clock").reason).toBe("needs the hub");
    expect(ok).toBe(false);
    expect(run.status).not.toBe(0);
  });

  it("reports the built-in defaults when only a workspace is configured", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const { checks } = await doctor(box);

    expect(check(checks, "workspace").status).toBe("pass");
    // No credential, so nothing was dialled — and the endpoint that would have
    // been is the built-in default.
    expect(check(checks, "hub").status).toBe("skipped");
    expect(check(checks, "hub").reason).toMatch(/ws:\/\/localhost:1234/);
    expect(check(checks, "database").reason).toBe(
      join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    );
  });

  it("reports an atomic environment binding ahead of the project file", async () => {
    // A complete environment pair deliberately overrides the complete file.
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });
    const { run, checks } = await doctor(box, { UB_WORKSPACE_ID: PINNED, UB_HUB_URL: DEAD_HUB_URL });

    expect(check(checks, "workspace").status).toBe("pass");
    expect(check(checks, "workspace").reason).toContain("environment");
    expect(check(checks, "workspace").reason).toContain(PINNED);
    expect(run.stderr).not.toContain("names a different workspace");
  });

  it("calls an absent credential a skip that keeps every MCP tool working", async () => {
    const { checks, ok } = await doctor(
      sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } }),
    );
    const credential = check(checks, "credential");

    // Offline-first by construction: no secret disables sync and nothing else,
    // so this is never the check that fails.
    expect(credential.status).toBe("skipped");
    expect(credential.reason).toMatch(/hub sync is disabled/);
    expect(credential.reason).toMatch(/every MCP tool still works/);
    expect(credential.reason).toMatch(/ub init/);
    expect(credential.fix).toBeNull();
    // The hub is not dialled either, so nothing here failed on the network.
    expect(check(checks, "hub").status).toBe("skipped");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toBe("needs the hub");
    expect(check(checks, "mcp").status).toBe("warn");
    expect(ok).toBe(true);
  });

  it("reports a configured credential without printing it", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });
    const { run, checks } = await doctor(box);

    expect(check(checks, "credential").status).toBe("pass");
    expect(check(checks, "credential").reason).toMatch(/credentials file/);
    // Neither the secret nor a token minted from it, on either stream.
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
  });

  it("fails the credential check when the file lets other users read it", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
      credentialsMode: 0o644,
    });
    const { run, checks } = await doctor(box);
    const credential = check(checks, "credential");

    // The secret exists and was refused: a real failure with a one-line fix.
    expect(credential.status).toBe("fail");
    expect(credential.reason).toMatch(/mode 0644/);
    expect(credential.fix).toMatch(/chmod 600 .*credentials\.json/);
    expect(run.output).not.toContain(SECRET);
  });

  it("warns with no local hub running, names the URL and fixes it with `ub open`", async () => {
    const { checks, run } = await doctor(
      sandbox({
        projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
        credentials: { signingSecret: SECRET },
      }),
    );
    const hub = check(checks, "hub");

    expect(hub.status).toBe("warn");
    expect(hub.reason).toContain(DEAD_HUB_URL);
    // A fix is only a fix if the reader can run it: `ub` recommends `ub`,
    // never a task that exists in a checkout and nowhere else.
    expect(hub.fix).toMatch(/ub open --no-browser/);
    expect(hub.fix).not.toMatch(/mise/);
    expect(run.status).toBe(0);
  });

  it("separates a missing login from an unreachable remote deployment", async () => {
    // A hub somebody deployed is not one this machine can start, so naming any
    // start command here would send the reader after a hub that is not theirs.
    const { checks } = await doctor(
      sandbox({
        projectBinding: {
          workspaceId: WORKSPACE,
          hubUrl: "wss://hub.example.invalid:443",
        },
        credentials: { signingSecret: SECRET },
      }),
    );
    const hub = check(checks, "hub");
    const credential = check(checks, "credential");

    expect(credential.status).toBe("fail");
    expect(credential.fix).toMatch(/ub auth login/);
    expect(hub.status).toBe("warn");
    expect(hub.reason).toContain("hub.example.invalid");
    expect(hub.fix).toMatch(/network/);
    expect(hub.fix).toMatch(/whoever runs the hub/);
    expect(hub.fix).toMatch(/work stays here/);
    expect(hub.fix).toMatch(/syncs once.*back/);
    expect(hub.fix).not.toMatch(/ub open/);
    expect(hub.fix).not.toMatch(/mise/);
  });

  it.each([false, true])("names sign-in recovery for a reachable device deployment through loopback (recorded admission: %s)", async recorded => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await createHub({ port: 0, address: "0.0.0.0", databasePath: join(box.cwd, "device-hub.sqlite"),
      github: { clientId: "Iv1.0123456789abcdef" }, log: silentLogger });
    hubs.push(hub);
    const endpoint = `ws://127.0.0.1:${hub.port}/custom-proxy-path`;
    pointAt(box, endpoint);
    if (recorded) writeFileSync(join(box.configHome, "uberblick", "config.json"), JSON.stringify({ hubAdmissions: { [endpoint]: "device" } }));
    const { checks } = await doctor(box);
    const upstream = check(checks, "hub");
    expect(upstream.status).toBe("fail");
    expect(upstream.fix).toContain(`ub auth login http://127.0.0.1:${hub.port}`);
    expect(upstream.fix).not.toContain("signing secret");
    expect(upstream.fix).not.toContain("ub open");
  });

  it("does not recommend replacing a stopped loopback device deployment with ub open", async () => {
    const port = await freePort();
    const endpoint = `ws://127.0.0.1:${port}/custom-proxy-path`;
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      userConfig: { hubAdmissions: { [endpoint]: "device" } }, credentials: { signingSecret: SECRET } });
    const { checks } = await doctor(box);
    const upstream = check(checks, "hub");
    expect(upstream.status).toBe("warn");
    expect(upstream.reason).toContain(endpoint);
    expect(upstream.fix).toMatch(/network/);
    expect(upstream.fix).toMatch(/whoever runs the hub/);
    expect(upstream.fix).toMatch(/work stays here/);
    expect(upstream.fix).toMatch(/syncs once.*back/);
    expect(upstream.fix).not.toContain("ub open");
  });

  it("passes the hub check against a running hub, and says our hub holds the port", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks } = await doctor(box, {
      PORT: String(hub.port),
    });

    expect(check(checks, "hub").status).toBe("pass");
    // A hub on this machine reads this machine's clock, so they agree.
    expect(check(checks, "clock").status).toBe("pass");
    expect(check(checks, "port").status).toBe("pass");
    // Taken is not a problem when we are the ones holding it.
    expect(check(checks, "bind").status).toBe("pass");
    expect(check(checks, "bind").reason).toMatch(/uberblick hub/);
  });

  it("names both causes when the hub refuses the secret", async () => {
    // The refusal an older hub sends is byte-identical to the one a wrong
    // secret sends — it cannot read this client's envelope at all — so the
    // fix has to name both rather than send the reader after the secret
    // alone. Same sentence every other surface prints.
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: "a-secret-this-hub-was-not-deployed-with" } });
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks, run } = await doctor(box);

    expect(check(checks, "hub").status).toBe("fail");
    expect(check(checks, "hub").fix).toContain(AUTH_REJECTED);
    expect(check(checks, "hub").fix).toMatch(/same secret/);
    expect(check(checks, "hub").fix).not.toContain("ub status");
    expect(check(checks, "credential").reason).toContain("credentials file");
    expect(check(checks, "clock").status).toBe("pass");
    // And the probe stays loud here. `ub workspace join` silences its own
    // pre-prompt probe (#447); `probeHub` — this check, and `ub open`, which
    // reduces it to a boolean and so never names a refusal itself — must not
    // be silenced with it. This is the cheapest command on that path.
    expect(run.stderr).toContain("hub rejected the token");
  });

  it("explains both protocol versions and which side to update", async () => {
    const hubVersion = SYNC_PROTOCOL_VERSION + 1;
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await startHub(box, hubVersion);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const { checks, run } = await doctor(box);
    const mismatch = check(checks, "hub");

    expect(mismatch.status).toBe("fail");
    expect(mismatch.reason).toContain(`this client speaks sync protocol ${SYNC_PROTOCOL_VERSION}`);
    expect(mismatch.reason).toContain(`the hub speaks ${hubVersion}`);
    expect(`${mismatch.reason} ${mismatch.fix}`).toContain("update this client");
    expect(mismatch.fix).not.toContain("ub status");
    expect(check(checks, "clock").status).toBe("pass");
    expect(run.status).toBe(1);
  });

  // The two thresholds, and the asymmetry between them: running fast trips the
  // hub's 60s issued-in-the-future bound, running slow mints a token that has
  // already expired — which takes a whole 900s token lifetime to reach, so a
  // minute slow is fine and a quarter of an hour slow is not.
  //
  // `offsetSeconds` is the hub's clock relative to ours, so a negative offset
  // is *this machine* running fast.
  it.each([
    ["61s fast", "fail", -61, /ahead of/],
    ["61s slow", "pass", 61, /behind/],
  ])(
    "a clock %s is a %s",
    async (_name, status, offsetSeconds, direction) => {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
      const server = await silentServer(offsetSeconds);
      pointAt(box, `ws://127.0.0.1:${server.port}`);
      const { checks } = await doctor(box);

      const clock = check(checks, "clock");
      expect(clock.status).toBe(status);
      expect(clock.reason).toMatch(direction);
      expect(server.clockRequests).toBe(1);
      if (status === "fail") {
        expect(clock.fix).toMatch(/clock/);
      }
    },
  );

  it("skips the clock check when the hub does not answer", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    pointAt(box, DEAD_HUB_URL);
    const { checks } = await doctor(box);

    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toBe("needs the hub");
  });

  it.each(["skipped", "refuse", "pending"] as const)("does not read the HTTP clock when the hub probe is %s", async state => {
    const server = await silentServer(-61, state === "pending" ? "pending" : "refuse");
    const endpoint = `ws://127.0.0.1:${server.port}`;
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      ...(state === "skipped" ? {} : { credentials: { signingSecret: SECRET } }),
    });
    const { checks } = await doctor(box);

    expect(check(checks, "hub").status).toBe(state === "skipped" ? "skipped" : "warn");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toBe("needs the hub");
    expect(server.clockRequests).toBe(0);
  });

  it("keeps the clock skip when a reached hub supplies no usable HTTP Date", async () => {
    const server = await silentServer(null);
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: `ws://127.0.0.1:${server.port}` },
      credentials: { signingSecret: SECRET },
    });
    const { checks } = await doctor(box);

    expect(check(checks, "hub").status).toBe("warn");
    expect(check(checks, "clock").status).toBe("skipped");
    expect(check(checks, "clock").reason).toMatch(/answered no HTTP date/);
    expect(server.clockRequests).toBe(1);
  });

  it("names both values when the hub's port and the configured endpoint disagree", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const hub = await startHub(box);
    const dialled = await freePort();
    pointAt(box, `ws://127.0.0.1:${dialled}`);
    const { checks } = await doctor(box, {
      PORT: String(hub.port),
    });
    const port = check(checks, "port");

    expect(port.status).toBe("fail");
    // Which two values disagree…
    expect(port.reason).toContain(String(hub.port));
    expect(port.reason).toContain(String(dialled));
    // …and how each half is set: one is an environment variable, the other is
    // this machine's configuration and a `ub` command away.
    expect(port.fix).toMatch(/PORT/);
    expect(port.fix).toMatch(/ub workspace join/);
  });

  it("tells a foreign process holding the port from our own hub", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const port = await foreignProcess();
    pointAt(box, `ws://127.0.0.1:${port}`);
    const { checks } = await doctor(box, {
      PORT: String(port),
    });
    const bind = check(checks, "bind");

    expect(bind.status).toBe("fail");
    expect(bind.reason).toContain(`127.0.0.1:${port}`);
    expect(bind.reason).toMatch(/not an uberblick hub/);
    expect(bind.fix).toMatch(/PORT/);
    expect(bind.fix).toMatch(/ub workspace join/);
  });

  it("refuses to call a hub that never serves the room reachable, or the port ours", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, credentials: { signingSecret: SECRET } });
    const { port } = await silentServer();
    pointAt(box, `ws://127.0.0.1:${port}`);
    const { checks } = await doctor(box, {
      PORT: String(port),
    });

    // Up, and serving nothing: a connection is not a hub.
    expect(check(checks, "hub").status).toBe("warn");
    expect(check(checks, "hub").reason).toMatch(/did not finish syncing/);
    // The endpoint is loopback, so the restart it suggests is one `ub` can do.
    expect(check(checks, "hub").fix).toMatch(/ub open --no-browser/);
    expect(check(checks, "hub").fix).not.toMatch(/mise/);
    // And speaking the protocol is not proof of whose server it is — only a
    // directory read with our own token would be.
    expect(check(checks, "bind").status).toBe("skipped");
    expect(check(checks, "bind").reason).toMatch(/speaks the protocol/);
    expect(check(checks, "bind").reason).not.toMatch(/is held by an uberblick hub/);
    expect(check(checks, "bind").reason).toMatch(/same signing secret/);
    expect(check(checks, "bind").fix).toBeNull();
    expect(check(checks, "clock").status).toBe("pass");
  });

  // `access(W_OK)` is advisory for root, which would make the fixture a
  // directory root can write to and the assertion a lie.
  it.skipIf(process.getuid?.() === 0)(
    "fails the database check when its directory cannot be written, and prints the path",
    async () => {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
      const readOnly = join(box.cwd, "read-only");
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o500);
      try {
        const database = join(readOnly, "uberblick.sqlite");
        const { checks } = await doctor(box, { UBERBLICK_DB: database });

        expect(check(checks, "database").status).toBe("fail");
        expect(check(checks, "database").reason).toContain(database);
        expect(check(checks, "database").fix).toMatch(/UBERBLICK_DB/);
      } finally {
        // Or the sandbox cannot be removed afterwards.
        chmodSync(readOnly, 0o700);
      }
    },
  );

  it("reports which MCP client is wired up, and points at `ub mcp install` when none is", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const none = await doctor(box);

    expect(check(none.checks, "mcp")).toEqual({
      name: "mcp",
      status: "warn",
      reason: "MCP client is not set up for this project",
      fix: "ub mcp install claude   (or codex)",
    });
    expect(none.run.status).toBe(0);

    wireMcp(box);
    const wired = await doctor(box);

    expect(check(wired.checks, "mcp").status).toBe("pass");
    expect(check(wired.checks, "mcp").reason).toBe("Claude Code (.mcp.json)");
    const human = await runUbAsync(["doctor"], box, { PORT: "1" });
    expect(human.stdout).toContain("ok    mcp         Claude Code (.mcp.json)\n");
  });

  it.each(CLIENTS)("reads $name's project config beside the binding and ignores a subdirectory's shadow", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    wireClient(box, client, "project", { command: "mise", args: ["exec", "--", "ub", "mcp", "serve"] });
    const nested = { ...box, cwd: join(box.cwd, "src") };
    mkdirSync(nested.cwd);
    wireClient(nested, client, "project", pin(PINNED));
    const { checks } = await doctor(nested);

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
    const { checks } = await doctor(nested, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: DEAD_HUB_URL });

    expect(check(checks, "mcp").status).toBe("pass");
    for (const client of CLIENTS) {
      expect(check(checks, "mcp").reason).toContain(`${client.name} (${client.path})`);
    }
    expect(check(checks, "mcp").reason).not.toMatch(/\(project\)|\(user\)|custom-wrapper/);
  });

  it.each(CLIENTS)("accepts an unpinned custom command in $name's user config", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = wireClient(box, client, "user", { command: SECRET, args: ["custom"], env: { API_TOKEN: SECRET } });
    const { checks, run } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`${client.name} (${path})`);
    expect(run.output).not.toContain(SECRET);
  });

  it.each(CLIENTS)("accepts $name's current pin with the workspace slug and normalized hub", async client => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://hub.example.invalid/ws" } });
    wireClient(box, client, "project", pin(`a-workspace-${WORKSPACE}`, "https://hub.example.invalid"));
    const { checks } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
    expect(check(checks, "mcp").reason).toBe(`${client.name} (${client.path})`);
  });

  it("accepts the install pin for a local workspace whose project binding has a slug", async () => {
    const box = sandbox({ projectBinding: { workspaceId: `a-workspace-${WORKSPACE}`, hubUrl: null } });
    wireMcp(box, pin(WORKSPACE, "local"));
    const { checks } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("pass");
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
    const { checks, run } = await doctor(box);

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
    const { checks } = await doctor(project);

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
    const { checks } = await doctor(box, { GIT_CEILING_DIRECTORIES: homeOf(box) });

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
    const { checks } = await doctor(project);

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
    const { checks } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`Claude Code (${path})`);
  });

  it("lets Claude Code's project entry hide a user pin, then its local entry hide the project pin", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    repository(box);
    wireClient(box, CLIENTS[0], "user", pin(PINNED));
    wireMcp(box);
    const project = await doctor(box);

    expect(check(project.checks, "mcp").status).toBe("pass");
    expect(check(project.checks, "mcp").reason).toBe("Claude Code (.mcp.json)");

    wireMcp(box, pin(PINNED));
    const path = join(homeOf(box), ".claude.json");
    writeJson(path, { mcpServers: { uberblick: pin(PINNED) }, projects: {
      [box.cwd]: { mcpServers: { uberblick: UNPINNED } },
    } });
    const local = await doctor(box);

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
    const { checks, run } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain(`${client.name} (${badScope === "project" ? client.path : badPath})`);
    expect(run.status).toBe(0);
    expect(check(checks, "mcp").reason).not.toContain(PINNED);
  });

  it.each([
    `[mcp_servers.uberblick]\ncommand = "ub"\n[mcp_servers.uberblick.env]\nUB_WORKSPACE_ID = "${SECRET}"\n`,
    `[mcp_servers]\nuberblick = { command = "ub", env = { UB_WORKSPACE_ID = "${SECRET}" } }\n`,
  ])("warns when Codex's workspace pin is incomplete or cannot be read", async text => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const path = clientFile(box, CLIENTS[1], "project");
    mkdirSync(dirname(path));
    writeFileSync(path, text, "utf8");
    const { checks, run } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Codex (.codex/config.toml)");
    expect(run.output).not.toContain(SECRET);
  });

  it("skips MCP when the workspace check has no usable binding", async () => {
    const box = sandbox({ raw: { projectBinding: `{ "workspaceId": "${SECRET}" }\n` } });
    wireMcp(box, pin(PINNED));
    const { checks } = await doctor(box);

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
    const { run, checks } = await doctor(box);

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
    const { checks, run } = await doctor(box);

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
    const { checks } = await doctor(box);

    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "mcp").reason).toContain("Claude Code (.mcp.json)");
    expect(check(checks, "mcp").reason).toMatch(/could not read/);
  });

  it("writes exactly one JSON object to stdout with --json, and nothing else", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });
    const run = await runUbAsync(["doctor", "--json"], box, { PORT: "1" });

    // One object: parsing the whole stream is the assertion — a second object,
    // a log line or a stray warning would all break it.
    const report = JSON.parse(run.stdout) as { ok: boolean; checks: unknown[] };
    expect(run.stdout.trimEnd().endsWith("}")).toBe(true);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.ok).toBe(true);
    expect(run.status).toBe(0);
    expect(run.output).not.toContain(SECRET);
  });

  it("passes a script gate when the only problems are warnings and skips", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });
    const { checks, ok, run } = await doctor(box);

    expect(check(checks, "hub").status).toBe("warn");
    expect(check(checks, "mcp").status).toBe("warn");
    expect(check(checks, "clock").status).toBe("skipped");
    expect([...checks.values()].some(one => one.status === "fail")).toBe(false);
    expect(ok).toBe(true);
    expect(run.status).toBe(0);

    const human = await runUbAsync(["doctor"], box, { PORT: "1", HUB_HOST: "127.0.0.1" });
    expect(human.stdout).toMatch(/warn {2}hub/);
    expect(human.stdout).toMatch(/skip {2}clock {7}needs the hub/);
    expect(human.stdout).toMatch(/0 failed, 2 warnings, \d+ passed, \d+ skipped/);
    expect(human.status).toBe(0);
  });

  it("renders the same verdicts for a human, with the fix under the warning", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const run = await runUbAsync(["doctor"], box, { PORT: "1" });

    expect(run.stdout).toMatch(/ok {4}workspace/);
    expect(run.stdout).toMatch(/skip {2}credential/);
    expect(run.stdout).toMatch(/warn {2}mcp/);
    expect(run.stdout).toContain("→ ub mcp install claude   (or codex)\n");
    expect(run.stdout).toMatch(/0 failed, 1 warning, \d+ passed, \d+ skipped/);
    expect(run.stdout.match(/→ /g)).toHaveLength(1);
    expect(run.status).toBe(0);
  });

  it.each([0, 1, 2])("renders fix lines only for problems and counts %s warnings", warnings => {
    const checks: Check[] = [
      { name: "workspace", status: "pass", reason: "configured", fix: null },
      { name: "credential", status: "skipped", reason: "local-only; use ub init for hub sync", fix: null },
      { name: "mcp", status: "fail", reason: "not registered", fix: "ub mcp install claude" },
      ...Array.from({ length: warnings }, (_, index): Check => ({
        name: `hub ${index + 1}`,
        status: "warn",
        reason: "hub unavailable",
        fix: "check the network",
      })),
    ];
    const text = renderDoctor({ version: "test", ok: false, checks });

    expect(text).toContain("ok    workspace   configured\n");
    expect(text).toContain("skip  credential  local-only; use ub init for hub sync\n");
    expect(text).toContain("FAIL  mcp         not registered\n      → ub mcp install claude\n");
    for (let index = 0; index < warnings; index += 1) {
      const name = `hub ${index + 1}`;
      expect(text).toContain(`warn  ${name.padEnd(12)}hub unavailable\n      → check the network\n`);
    }
    expect(text.match(/→ /g)).toHaveLength(warnings + 1);
    expect(text).toContain(`1 failed, ${warnings} ${warnings === 1 ? "warning" : "warnings"}, 1 passed, 1 skipped\n`);
  });
});

/**
 * `ub open` — one test per acceptance criterion of #97.
 *
 * The world is real here, as it is in the `ub doctor` suite: a real hub on an
 * ephemeral port for "a hub is already answering", a real foreign listener for
 * "the port is taken", real HTTP requests against the served bundle, and a real
 * SIGINT to end the foreground. Nothing here calls {@link runUb}: `spawnSync`
 * blocks this process's event loop (#154), so a `ub open` child probing a hub
 * *this* process is serving would find it unreachable and every assertion would
 * be about the blockage rather than about the command.
 *
 * The bundle is a fixture rather than a real `vite build`: `UBERBLICK_WEB_DIST`
 * is the seam `ub open` reads, and what these tests are about is what gets
 * served, not what Vite emits.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub, TokenClaims, TokenScope } from "@uberblick/hub";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  createHub,
  importRootSecret,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/hub/protocol";
import {
  createMcpServer,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import {
  directoryRoom,
  editBlock,
  getBlocks,
  getDirectoryEntry,
  roomForDoc,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { acquireInitLock } from "../src/init-lock.js";
import type { Io } from "../src/io.js";
import type { Stop } from "../src/open.js";
import { bundlePlan, ensureBundle, whoHoldsPort } from "../src/open.js";
import { probeHub, probePort } from "../src/probes.js";
import type { Sandbox } from "./helpers.js";
import {
  UB_BIN,
  WAIT_TIMEOUT_MS,
  pointAt,
  removeTempDirs,
  runUbAsync,
  sandbox,
  sleep,
  waitUntil,
} from "./helpers.js";

const WORKSPACE = "b4d1f0a7-3c62-4e91-8f05-7ad2c9e61b38";
const SECRET = "open-test-signing-secret-9d31fa";

/** What a `ub remote join` mid-run leaves behind, for the #449 tests. */
const REBOUND_WORKSPACE = "c7e2b105-9a48-4d6f-b3e1-5f0c8a71d264";
const REBOUND_SECRET = "open-test-rotated-secret-4b7c21";
const FIRST_REMOTE = "wss://first.example.ts.net/ws";
const SECOND_REMOTE = "wss://second.example.ts.net/ws";

const hubs: Hub[] = [];
const listeners: { server: Server; sockets: Socket[] }[] = [];
const children: ChildProcess[] = [];
/** {@link anotherRunBuilding} holders, so no build outlives the test that made it. */
const holders: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const hub of hubs.splice(0)) {
    await hub.stop().catch(() => {});
  }
  for (const { server, sockets } of listeners.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
  // Idempotent, so a test that finished its own holder pays nothing, and one
  // that failed first still leaves no build running and no lock behind.
  for (const finish of holders.splice(0)) {
    await finish().catch(() => {});
  }
  removeTempDirs();
});

// --- fixtures ----------------------------------------------------------------

/** A port nothing is listening on: bound, read back, and released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/**
 * A second connection to a store a live `ub open` process is serving.
 *
 * That process writes while these tests provoke it, so a connection with
 * SQLite's default zero busy timeout throws `database is locked` on a loaded
 * host instead of waiting the write out — an intermittent false red on the
 * whole review gate (#901). The wait matches the store's own
 * `BUSY_TIMEOUT_MS` (`packages/mcp-server/src/store.ts`).
 */
function openStore(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

/**
 * A process holding a port and answering nothing — the unidentified case.
 *
 * It never answers at all, so the probe's verdict does not depend on beating a
 * deadline: no ceiling makes this holder identifiable.
 */
async function silentListener(port: number): Promise<void> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  listeners.push({ server, sockets });
}

/** A process holding a port and giving one complete HTTP answer to everything. */
async function answeringListener(
  port: number,
  status: number,
  body: string,
): Promise<void> {
  const sockets: Socket[] = [];
  const server = createHttpServer((_request, response) => {
    response.writeHead(status);
    response.end(body);
  });
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  listeners.push({ server, sockets });
}

async function startHub(box: Sandbox, port = 0): Promise<Hub> {
  const hub = await createHub({
    authSecret: SECRET,
    port,
    databasePath: join(box.cwd, "existing-hub.sqlite"),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  return hub;
}

/** What the web build stamps the protocol it speaks into; `ub open` reads it. */
const BUILD_STAMP = "uberblick-build.json";

/** Give a fixture bundle the stamp of a build — `version`, or none at all. */
function stamp(dir: string, version: number | null): void {
  if (version === null) {
    rmSync(join(dir, BUILD_STAMP), { force: true });
    return;
  }
  writeFileSync(join(dir, BUILD_STAMP), JSON.stringify({ syncProtocolVersion: version }), "utf8");
}

/**
 * A bundle the way `ub open` finds one: a directory with an index.html in it —
 * and, since #452, a stamp saying it speaks the protocol this command does.
 * Everything below serves rather than refuses because of that one line.
 */
function fixtureBundle(box: Sandbox): string {
  const dir = join(box.cwd, "bundle");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><title>uberblick</title><div id=root></div>\n",
    "utf8",
  );
  writeFileSync(join(dir, "assets", "app.js"), "export const marker = 42;\n", "utf8");
  stamp(dir, SYNC_PROTOCOL_VERSION);
  return dir;
}

/** This checkout, which is where `ub open` runs `mise run build-web` (#475). */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

interface FakeTool {
  /** The directory to put on PATH; every fake tool of one sandbox shares it. */
  path: string;
  /** One `<cwd> <args>` line per invocation. */
  calls: () => string[];
  /** What `HUB_AUTH_TOKEN` was for each invocation — `<unset>` when it was not. */
  tokens: () => string[];
}

/**
 * A build command on PATH that records how it was called and behaves as it is
 * told: `FAKE_SLEEP` seconds of work, `FAKE_HOLD` a file to keep building until
 * somebody removes, `FAKE_STAMP_VERSION` stamped into `FAKE_STAMP_DIR`,
 * `FAKE_EXIT_CODE` to exit with, `FAKE_KILL_SELF` to die of a signal nobody here
 * sent. A real `mise run build-web` or `pnpm … build` here
 * would be a Vite build of the repository's own bundle — minutes, and a
 * checkout mutated by a test.
 *
 * `FAKE_BUSY_DIR` is the overlap sentinel: a directory only one build can hold,
 * created before the work and removed after it, so a second build running at
 * the same time exits 9 instead of quietly succeeding.
 */
function fakeTool(box: Sandbox, command: string): FakeTool {
  const bin = join(box.cwd, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const record = join(box.cwd, `${command}-calls.txt`);
  const tokens = join(box.cwd, `${command}-tokens.txt`);
  writeFileSync(
    join(bin, command),
    "#!/bin/sh\n" +
      // The tests point PATH at this directory alone, to prove the build
      // command is found there; the fixture still needs `mkdir` and `sleep`.
      'PATH="$PATH:/bin:/usr/bin"\n' +
      `printf '%s %s\\n' "$PWD" "$*" >> ${record}\n` +
      `printf '%s\\n' "\${HUB_AUTH_TOKEN-<unset>}" >> ${tokens}\n` +
      'if [ -n "$FAKE_KILL_SELF" ]; then kill -TERM $$; fi\n' +
      'if [ -n "$FAKE_BUSY_DIR" ]; then mkdir "$FAKE_BUSY_DIR" || exit 9; fi\n' +
      'if [ -n "$FAKE_HOLD" ]; then while [ -e "$FAKE_HOLD" ]; do sleep 0.05; done; fi\n' +
      'if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi\n' +
      'if [ -n "$FAKE_BUSY_DIR" ]; then rmdir "$FAKE_BUSY_DIR"; fi\n' +
      'if [ -n "$FAKE_STAMP_VERSION" ]; then\n' +
      '  mkdir -p "$FAKE_STAMP_DIR"\n' +
      '  printf \'{"syncProtocolVersion":%s}\' "$FAKE_STAMP_VERSION" \\\n' +
      '    > "$FAKE_STAMP_DIR/uberblick-build.json"\n' +
      "fi\n" +
      'if [ -z "$FAKE_EXIT_CODE" ]; then FAKE_EXIT_CODE=0; fi\n' +
      'exit "$FAKE_EXIT_CODE"\n',
    "utf8",
  );
  chmodSync(join(bin, command), 0o755);
  const lines = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return { path: bin, calls: () => lines(record), tokens: () => lines(tokens) };
}

const fakeMise = (box: Sandbox): FakeTool => fakeTool(box, "mise");

/** A {@link Stop} that never fires: the paths where no signal is involved. */
function calm(): Stop {
  return { interrupted: () => false, signalled: new Promise<void>(() => {}) };
}

/** A {@link Stop} the test decides the moment of, standing in for Ctrl-C. */
function stoppable(): Stop & { stop: () => void } {
  let seen = false;
  let wake!: () => void;
  const signalled = new Promise<void>((done) => {
    wake = done;
  });
  return {
    interrupted: () => seen,
    signalled,
    stop: () => {
      seen = true;
      wake();
    },
  };
}

/**
 * Another `ub open` really building `dir`: it holds the build lock from the
 * moment this resolves until `finish()` lets its build end, and leaves the
 * bundle `leaves` stamps, or nothing at all.
 *
 * Contention rather than a reconstructed lock path. A test that spells the file
 * name out asserts on the hash that produces it, so it fails changes that keep
 * exclusion and moves nothing — and it would still pass the mistake this lock
 * has already made once, of keying itself on something other than the output.
 * Two real runs over one directory can only agree by excluding each other.
 */
async function anotherRunBuilding(
  dir: string,
  leaves?: number,
): Promise<{ finish: () => Promise<void> }> {
  const box = sandbox();
  const tool = fakeMise(box);
  const hold = join(box.cwd, "still-building");
  writeFileSync(hold, "", "utf8");
  const run = ensureBundle(
    { action: "serve", dir, ours: true, installed: false },
    {
      ...box.env,
      PATH: tool.path,
      FAKE_HOLD: hold,
      ...(leaves === undefined
        ? {}
        : { FAKE_STAMP_DIR: dir, FAKE_STAMP_VERSION: String(leaves) }),
    },
    stderrIo(),
    calm(),
  );
  const finish = async (): Promise<void> => {
    rmSync(hold, { force: true });
    await run;
  };
  holders.push(finish);
  await waitUntil(`another run to start building ${dir}`, () => tool.calls().length === 1);
  return { finish };
}

/**
 * An {@link Io} that collects stderr and refuses stdout: which stream a bundle
 * message lands on is the CLI contract's, not a detail.
 */
function stderrIo(): Io & { text: () => string } {
  let text = "";
  return {
    out: () => {
      throw new Error("a bundle message went to stdout, which carries the URL");
    },
    err: (chunk) => {
      text += chunk;
    },
    text: () => text,
  };
}

/** A `BROWSER` command that records the URL it was handed instead of opening it. */
function browserRecorder(box: Sandbox): { command: string; opened: string } {
  const opened = join(box.cwd, "opened.txt");
  const command = join(box.cwd, "record-browser.sh");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${opened}\n`, "utf8");
  chmodSync(command, 0o755);
  return { command, opened };
}

/** Whether a real client can open the workspace's directory room on `hubUrl`. */
async function hubAnswers(box: Sandbox, hubUrl: string): Promise<boolean> {
  const config = resolveMcpConfig({
    ...box.env,
    WORKSPACE_ID: WORKSPACE,
    HUB_AUTH_TOKEN: SECRET,
    UBERBLICK_DB: join(box.cwd, `probe-${Math.random().toString(36).slice(2)}.sqlite`),
  });
  return (await probeHub(config, hubUrl)) === "connected";
}

// --- the running command -----------------------------------------------------

interface Running {
  url: string;
  stdout: () => string;
  stderr: () => string;
  /** The command's own terminal outcome, without sending it a signal. */
  wait: () => Promise<{ status: number | null; signal: string | null }>;
  /** SIGINT, then the exit status — what Ctrl-C in a terminal does. */
  interrupt: () => Promise<{ status: number | null; signal: string | null }>;
}

const BANNER = /uberblick is at (http:\/\/\S+)/;

/**
 * Start `ub open` and resolve once it is actually serving.
 *
 * The banner is the readiness signal, and it is printed after both ports are
 * bound — so a test that has this handle can make a request without polling.
 */
async function open(
  box: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Running> {
  const child = spawn(process.execPath, [UB_BIN, "open", ...args], {
    cwd: box.cwd,
    env: { ...box.env, ...extraEnv },
  });
  children.push(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ status: number | null; signal: string | null }>(
    (done) => {
      child.on("close", (status, signal) => done({ status, signal }));
    },
  );
  let over = false;
  void exited.then(() => {
    over = true;
  });

  try {
    await waitUntil("`ub open` to print its banner", () => {
      if (over) throw new Error("ub open exited before it served");
      return BANNER.test(stdout);
    });
  } catch (reason) {
    child.kill("SIGKILL");
    const said = reason instanceof Error ? reason.message : String(reason);
    throw new Error(`${said}:\n${stdout}${stderr}`);
  }

  const url = BANNER.exec(stdout)?.[1];
  if (url === undefined) throw new Error(`ub open named no URL:\n${stdout}`);
  return {
    url,
    stdout: () => stdout,
    stderr: () => stderr,
    wait: () => exited,
    interrupt: async () => {
      child.kill("SIGINT");
      await waitUntil("`ub open` to exit after Ctrl-C", () => over);
      return await exited;
    },
  };
}

/**
 * Start `ub open` and interrupt it the moment `when` says so.
 *
 * Deliberately does not wait for the banner: the window this exists to test is
 * the one *before* there is one — after the hub has bound its socket and before
 * the command is fully up — and waiting on the hub's own port is what makes
 * hitting that window repeatable rather than a matter of timing.
 */
async function interruptWhen(
  box: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
  when: () => Promise<void>,
): Promise<{ status: number | null; signal: string | null; output: string }> {
  const child = spawn(process.execPath, [UB_BIN, "open", ...args], {
    cwd: box.cwd,
    env: { ...box.env, ...extraEnv },
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise<{
    status: number | null;
    signal: string | null;
    output: string;
  }>((done) => {
    child.on("close", (status, signal) => done({ status, signal, output }));
  });
  let over = false;
  void exited.then(() => {
    over = true;
  });

  await when();
  child.kill("SIGINT");
  await waitUntil(
    "`ub open` to exit after an interrupt while it was still coming up",
    () => over,
  );
  return await exited;
}

/** Resolve once something is listening on `port` — here, the hub `ub open` started. */
async function untilBound(port: number): Promise<void> {
  await waitUntil(
    `the hub \`ub open\` starts to bind port ${port}`,
    async () => (await probePort("127.0.0.1", port)).state !== "free",
  );
}

/** Run `ub open` expecting it to refuse, and hand back what it said. */
async function openFails(
  box: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; output: string }> {
  const run = await runUbAsync(["open", ...args], box, extraEnv, WAIT_TIMEOUT_MS);
  return { status: run.status, output: run.output };
}

/**
 * A sandbox that can start a hub: a workspace, a signing secret, a fixture
 * bundle, a hub database of its own, and no browser.
 */
function configured(): {
  box: Sandbox;
  env: NodeJS.ProcessEnv;
  bundle: string;
} {
  const box = sandbox({
    userConfig: { workspace: WORKSPACE },
    credentials: { signingSecret: SECRET },
  });
  const bundle = fixtureBundle(box);
  return {
    box,
    bundle,
    env: {
      UBERBLICK_WEB_DIST: bundle,
      // Never the repository's own packages/hub/data/hub.sqlite.
      HUB_DB_PATH: join(box.cwd, "started-hub.sqlite"),
      BROWSER: "none",
    },
  };
}

async function get(url: string): Promise<Response> {
  return await fetch(url, { cache: "no-store" });
}

async function getWithHost(
  url: string,
  host: string | null,
  authorization?: string,
): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "GET",
        ...(host === null ? { setHost: false } : {}),
        headers: {
          ...(host === null ? {} : { host }),
          ...(authorization === undefined ? {} : bearer(authorization)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** This machine's config directory — the one the sandbox points XDG at. */
function configDir(box: Sandbox): string {
  return join(box.configHome, "uberblick");
}

/**
 * Rebind this machine, the way `ub remote join` or `ub workspace use` leaves it:
 * a different endpoint, workspace and signing secret, across both files.
 */
function rebind(
  box: Sandbox,
  binding: { hubUrl: string; workspace: string; signingSecret: string },
): void {
  const dir = configDir(box);
  mkdirSync(dir, { recursive: true });
  writeCredentials(box, binding.signingSecret);
  writeBinding(box, binding.hubUrl, binding.workspace);
}

function writeCredentials(box: Sandbox, signingSecret: string): void {
  const dir = configDir(box);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    `${JSON.stringify({ signingSecret }, null, 2)}\n`,
    "utf8",
  );
  chmodSync(join(dir, "credentials.json"), 0o600);
}

function writeBinding(box: Sandbox, hubUrl: string, workspace: string): void {
  const dir = configDir(box);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify({ workspace, hubUrl }, null, 2)}\n`,
    "utf8",
  );
}

function servingDocumentOf(
  appUrl: string,
  remoteHubUrl: string,
  workspace: string,
  secret: string,
  rebound = false,
): string {
  const hubUrl = appUrl.replace(/^http:/, "ws:").replace(/\/$/, "");
  return JSON.stringify({
    hubUrl,
    workspaces: [workspace],
    hubAuthToken: secret,
    remoteHubUrl,
    ...(rebound ? { rebound: true } : {}),
  });
}

async function authMessage(
  key: string,
  scope: TokenScope = "read-only",
  options: {
    secret?: string;
    workspace?: string;
    protocolVersion?: number;
  } = {},
): Promise<string> {
  const token = await mintToken(
    await importRootSecret(options.secret ?? key),
    {
      typ: "room",
      sub: "open-api-test",
      workspace: options.workspace ?? WORKSPACE,
      scope,
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    },
  );
  return wrapToken(token, options.protocolVersion ?? SYNC_PROTOCOL_VERSION);
}

async function forgedAuthMessage(key: string, claims: TokenClaims): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importRootSecret(key),
    new TextEncoder().encode(payload),
  );
  return wrapToken(`${payload}.${Buffer.from(signature).toString("base64url")}`);
}

function bearer(auth: string): Record<string, string> {
  return { authorization: `Bearer ${auth}` };
}

// --- the criteria ------------------------------------------------------------

describe("ub open", () => {
  it("starts a hub, serves the bundle, and opens the browser at the served URL", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    const browser = browserRecorder(box);
    pointAt(box, hubUrl);

    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      BROWSER: browser.command,
    });

    expect(app.url).toBe(`http://127.0.0.1:${webPort}/`);
    const configuration = await (await get(`${app.url}uberblick-config.json`)).text();
    expect(configuration).not.toContain(SECRET);
    expect(JSON.parse(configuration).hubAuthToken).toBe(localBrowserKey(WORKSPACE, box.env));
    expect(app.stdout() + app.stderr()).not.toContain(localBrowserKey(WORKSPACE, box.env));
    expect(await (await get(app.url)).text()).toContain("<title>uberblick</title>");
    expect(await (await get(`${app.url}assets/app.js`)).text()).toContain("marker");

    // The hub it started is one a real client can open the workspace's
    // directory room on — which is what the document list hydrates from.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
    expect(app.stdout()).toContain("started here");

    // The browser was handed the address that is actually being served. `ub
    // open` spawns that command and carries on without awaiting it, so the
    // recording lands whenever the machine gets to it: wait for the recording
    // rather than for a duration, or load fails this case instead of delaying
    // it (#531). The recorder appends, and `>>` creates the file before
    // `printf` fills it — so a finished line, not an existing file, is the
    // recording.
    const recording = (): string =>
      existsSync(browser.opened) ? readFileSync(browser.opened, "utf8") : "";
    await waitUntil(
      "the `BROWSER` command to record the URL it was handed",
      () => recording().endsWith("\n"),
    );
    expect(recording().trim()).toBe(app.url);

    expect((await app.interrupt()).status).toBe(0);
  });

  it("uses a hub that is already answering, and Ctrl-C leaves it running", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;
    const webPort = await freePort();
    pointAt(box, hubUrl);

    const app = await open(box, ["--port", String(webPort)], env);

    // Nothing was started: a bind of the occupied port would have failed with
    // EADDRINUSE and taken the command down before it ever served.
    expect(app.stdout()).toContain("already running — left alone");
    expect(app.stderr()).not.toContain("EADDRINUSE");
    expect(await (await get(`${app.url}uberblick-config.json`)).json()).toMatchObject({
      hubUrl: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      remoteHubUrl: hubUrl,
    });

    expect((await app.interrupt()).status).toBe(0);
    // The hub this command did not start is the hub it did not stop.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
  });

  it("serves the local browser endpoint and names the configured upstream", async () => {
    const { box, env } = configured();
    const remote = "wss://hub.example.ts.net/ws";
    pointAt(box, remote);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    // Byte-exact: the path and the shape are #91's contract, and the web
    // client's fallback is silent enough that a wrong document looks like an
    // offline hub rather than a misconfiguration. Its independent key admits
    // the page only to the local server, never to the upstream hub.
    const document = await get(`${app.url}uberblick-config.json`);
    expect(await document.text()).toBe(
      servingDocumentOf(app.url, remote, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );
    expect(app.stdout()).toContain("remote — nothing started here");

    expect((await app.interrupt()).status).toBe(0);
  });

  it.each(["hub-down", "no-credentials"])("bridges durable browser and MCP edits through the shared store (%s)", async (mode) => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    if (mode === "no-credentials") {
      rmSync(join(configDir(box), "credentials.json"));
    }
    const webPort = await freePort();
    let app = await open(box, ["--port", String(webPort)], env);

    const instance = createMcpServer(
      resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
        HUB_URL: FIRST_REMOTE,
        ...(mode === "hub-down" ? { HUB_AUTH_TOKEN: SECRET } : {}),
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ub-open-store-test", version: "0.0.0" });
    const doc = new Y.Doc();
    const directory = new Y.Doc();
    let provider: HocuspocusProvider | null = null;
    let directoryProvider: HocuspocusProvider | null = null;
    try {
      await Promise.all([
        instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as { text?: string }[];
        return JSON.parse(content[0]?.text ?? "null") as T;
      };
      const created = await call<{ uuid: string }>("create_doc", {
        title: "Browser durability boundary",
        description: "A document shared by ub open and an MCP session.",
        blocks: [{ type: "paragraph", text: "before" }],
      });

      provider = new HocuspocusProvider({
        url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
        name: roomForDoc(WORKSPACE, created.uuid),
        document: doc,
        token: wrapToken(
          await mintToken(await importRootSecret(localBrowserKey(WORKSPACE, box.env)), {
            typ: "room",
            sub: "open-test-browser",
            workspace: WORKSPACE,
            scope: "read-write",
            kid: null,
            lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
          }),
        ),
        ...{
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string | URL) {
              super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]);
            }
          },
        },
      });
      await waitUntil("the browser room to hydrate from the store", () =>
        provider?.isSynced === true,
      );
      directoryProvider = new HocuspocusProvider({
        url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
        name: directoryRoom(WORKSPACE),
        document: directory,
        token: wrapToken(
          await mintToken(await importRootSecret(localBrowserKey(WORKSPACE, box.env)), {
            typ: "room",
            sub: "open-test-directory",
            workspace: WORKSPACE,
            scope: "read-write",
            kid: null,
            lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
          }),
        ),
        ...{
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string | URL) {
              super(url, { headers: { Origin: app.url.slice(0, -1) } } as unknown as string[]);
            }
          },
        },
      });
      await waitUntil("the browser directory to hydrate from the store", () =>
        directoryProvider?.isSynced === true,
      );
      const block = getBlocks(doc)[0];
      if (block === undefined) throw new Error("the store-hydrated document has no block");
      expect(block.text).toBe("before");

      editBlock(doc, block.id, "before", "durable before acknowledgement", {
        rev: block.rev,
      });
      await waitUntil("the local server to acknowledge the browser edit", () =>
        provider?.hasUnsyncedChanges === false,
      );

      const read = await call<{ blocks: { text: string }[] }>("get_doc", {
        uuid: created.uuid,
      });
      expect(read.blocks[0]?.text).toBe("durable before acknowledgement");
      const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));
      const readStatus = async () => await (await fetch(`${app.url}api/status`, {
        headers: bearer(auth),
      })).json() as { caughtUp: boolean; notSharedReason: string | null;
        rooms: Record<string, { hubAcked: boolean }> };
      expect(await readStatus()).toMatchObject({
        caughtUp: false,
        notSharedReason: mode === "no-credentials" ? "no-hub-credentials" : null,
        rooms: { [roomForDoc(WORKSPACE, created.uuid)]: { hubAcked: false } },
      });
      const stored = openStore(instance.store.databasePath);
      try {
        expect(stored.prepare("SELECT COUNT(*) AS count FROM pending_rooms").get()?.count)
          .toBeGreaterThan(0);
      } finally { stored.close(); }


      const current = await call<{
        blocks: { id: string; text: string; rev: string }[];
      }>("get_doc", { uuid: created.uuid });
      const initialBlock = current.blocks[0];
      if (initialBlock === undefined) throw new Error("the MCP replica has no block");
      let currentBlock: { id: string; text: string; rev: string } = initialBlock;
      const liveLatencies: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const newText = `agent edit arrived live ${index}`;
        const startedAt = performance.now();
        const edited: { block: { id: string; text: string; rev: string } } = await call<{
          block: { id: string; text: string; rev: string };
        }>("edit_block", {
          uuid: created.uuid,
          block_id: currentBlock.id,
          old_text: currentBlock.text,
          new_text: newText,
          rev: currentBlock.rev,
        });
        await waitUntil("the MCP edit to reach the live browser room", () =>
          getBlocks(doc)[0]?.text === newText,
        );
        liveLatencies.push(performance.now() - startedAt);
        currentBlock = edited.block;
      }
      const p95 = [...liveLatencies].sort((a, b) => a - b)[18];
      expect(p95, JSON.stringify(liveLatencies)).toBeLessThan(250);

      const creationLatencies: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const title = `Created by the agent ${index}`;
        const startedAt = performance.now();
        const added = await call<{ uuid: string }>("create_doc", {
          title,
          description: "A document whose directory entry arrives live.",
        });
        await waitUntil("the MCP-created document to reach the browser directory", () =>
          getDirectoryEntry(directory, added.uuid)?.title === title,
        );
        creationLatencies.push(performance.now() - startedAt);
      }
      const creationP95 = [...creationLatencies].sort((a, b) => a - b)[18];
      expect(creationP95, JSON.stringify(creationLatencies)).toBeLessThan(250);
      if (mode === "no-credentials") {
        const key = localBrowserKey(WORKSPACE, box.env);
        const hub = await startHub(box);
        const hubUrl = `ws://127.0.0.1:${hub.port}`;
        writeCredentials(box, SECRET);
        expect(await (await get(`${app.url}uberblick-config.json`)).json())
          .toMatchObject({ hubAuthToken: key, rebound: true });
        pointAt(box, hubUrl);
        expect((await app.interrupt()).status).toBe(0);
        app = await open(box, ["--port", String(webPort)], env);
        expect(localBrowserKey(WORKSPACE, box.env)).toBe(key);
        await waitUntil("pending local-only edits to reach and be acknowledged by the hub", async () => {
          const status = await readStatus();
          return status.caughtUp && status.rooms[roomForDoc(WORKSPACE, created.uuid)]?.hubAcked === true;
        });
        const remoteDoc = new Y.Doc();
        const remote = new HocuspocusProvider({
          url: hubUrl, name: roomForDoc(WORKSPACE, created.uuid), document: remoteDoc,
          token: await authMessage(SECRET),
        });
        try {
          await waitUntil("a fresh hub peer to read the same pending document", () => remote.isSynced);
          expect(getBlocks(remoteDoc)[0]?.text).toBe(currentBlock.text);
          expect(instance.store.pendingRooms()).toEqual([]);
        } finally { remote.destroy(); remoteDoc.destroy(); }

        // The still-open local providers keep their original key after losing hub auth too.
        rmSync(join(configDir(box), "credentials.json"));
        expect(await (await get(`${app.url}uberblick-config.json`)).json())
          .toMatchObject({ hubAuthToken: key, rebound: true });
        expect((await app.interrupt()).status).toBe(0);
        app = await open(box, ["--port", String(webPort)], env);
        await waitUntil("the same browser room to resume local-only after restart", () =>
          provider?.isSynced === true,
        );
        expect(await readStatus()).toMatchObject({
          notSharedReason: "no-hub-credentials", caughtUp: false,
          rooms: { [roomForDoc(WORKSPACE, created.uuid)]: { hubAcked: false } },
        });
      }

    } finally {
      provider?.destroy();
      directoryProvider?.destroy();
      doc.destroy();
      directory.destroy();
      await client.close().catch(() => {});
      await instance.close().catch(() => {});
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("relays presence across reconnect and lets a served tab expire upstream", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], env);
    const room = roomForDoc(WORKSPACE, "671ed55d-36de-42a9-bd85-701eff199942");
    const token = wrapToken(
      await mintToken(await importRootSecret(SECRET), {
        typ: "room",
        sub: "open-presence-test",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
    );
    const browserDoc = new Y.Doc();
    const agentDoc = new Y.Doc();
    const browser = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: room,
      document: browserDoc,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-write"),
      ...{
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string | URL) {
            super(url, {
              headers: { Origin: app.url.slice(0, -1) },
            } as unknown as string[]);
          }
        },
      },
    });
    const agent = new HocuspocusProvider({
      url: hubUrl,
      name: room,
      document: agentDoc,
      token,
    });

    try {
      await waitUntil("both presence peers to sync", () =>
        [browser, agent].every((provider) => provider.isSynced),
      );
      browser.setAwarenessField("client", "web");
      browser.setAwarenessField("user", {
        name: "browser tab",
        color: "#112233",
      });
      agent.setAwarenessField("client", "agent");
      agent.setAwarenessField("user", {
        name: "coding agent",
        color: "#abcdef",
      });
      agent.setAwarenessField("cursor", {
        blockId: "block-1",
        anchor: 1,
        head: 1,
      });

      const browserId = browser.awareness?.clientID;
      const agentId = agent.awareness?.clientID;
      if (browserId === undefined || agentId === undefined) {
        throw new Error("the presence peers have no awareness");
      }
      await waitUntil("presence to cross the local/upstream seam", () =>
        browser.awareness?.getStates().has(agentId) === true &&
        agent.awareness?.getStates().has(browserId) === true,
      );
      expect(browser.awareness?.getStates().get(agentId)).toMatchObject({
        client: "agent",
        cursor: { blockId: "block-1", anchor: 1, head: 1 },
      });
      expect(agent.awareness?.getStates().get(browserId)).toMatchObject({
        client: "web",
        user: { name: "browser tab", color: "#112233" },
      });

      await hub.stop();
      await waitUntil("the disconnected agent to leave the served browser", () =>
        browser.awareness?.getStates().has(agentId) === false,
      );
      expect(browser.awareness?.getStates().has(browserId)).toBe(true);

      await startHub(box, hub.port);
      // These ordinary awareness updates stand in for each peer's periodic
      // renewal. Neither document nor provider is recreated across the loss.
      browser.setAwarenessField("renewal", 1);
      agent.setAwarenessField("renewal", 1);
      await waitUntil("presence to return after the upstream reconnects", () =>
        browser.awareness?.getStates().has(agentId) === true &&
        agent.awareness?.getStates().has(browserId) === true,
      );

      browser.destroy();
      await sleep(1_000);
      expect(agent.awareness?.getStates().has(browserId)).toBe(true);
    } finally {
      browser.destroy();
      agent.destroy();
      browserDoc.destroy();
      agentDoc.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("searches the shared store while the hub is unreachable and discloses its cap", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const app = await open(box, ["--port", String(await freePort())], env);
    const instance = createMcpServer(
      resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
        HUB_URL: FIRST_REMOTE,
        HUB_AUTH_TOKEN: SECRET,
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ub-open-search-test", version: "0.0.0" });
    try {
      await Promise.all([
        instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "create_doc",
        arguments: {
          title: "Offline badger",
          description: "A document written by another local process.",
          blocks: [{ type: "paragraph", text: "orchard telemetry" }],
        },
      });
      const content = result.content as { text?: string }[];
      const created = JSON.parse(content[0]?.text ?? "null") as { uuid: string };
      const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));

      const found = await fetch(`${app.url}api/search?q=offline+badg*`, {
        headers: bearer(auth),
      });
      expect(found.status).toBe(200);
      expect(found.headers.get("cache-control")).toBe("no-store");
      expect(found.headers.get("access-control-allow-origin")).toBeNull();
      expect(await found.json()).toEqual({
        hits: [{ uuid: created.uuid }],
        limit: 100,
        capped: false,
      });

      for (let index = 0; index <= 100; index += 1) {
        instance.store.indexDoc(
          {
            uuid: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            title: `Capacity ${index}`,
            description: "",
            tags: [],
            links: [],
            body: "capacityneedle",
          },
          1,
        );
      }
      const capped = await fetch(`${app.url}api/search?q=capacityneedle`, {
        headers: bearer(auth),
      });
      const cappedBody = (await capped.json()) as {
        hits: { uuid: string }[];
        limit: number;
        capped: boolean;
      };
      expect(cappedBody).toMatchObject({
        limit: 100,
        capped: true,
      });
      expect(cappedBody.hits).toHaveLength(100);
      expect(cappedBody.hits.every((hit) => Object.keys(hit).join() === "uuid"))
        .toBe(true);

      const empty = await fetch(`${app.url}api/search?q=%F0%9F%8C%BF`, {
        headers: bearer(auth),
      });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ hits: [], limit: 100, capped: false });

      const missing = await fetch(`${app.url}api/search`, {
        headers: bearer(auth),
      });
      expect(missing.status).toBe(400);
      expect(missing.headers.get("cache-control")).toBe("no-store");
    } finally {
      await client.close().catch(() => {});
      await instance.close().catch(() => {});
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("reports loaded rooms and the full replica's upstream acknowledgement", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const hub = await startHub(box, hubPort);
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], env);
    const room = directoryRoom(WORKSPACE);
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      name: room,
      document: doc,
      token: await authMessage(localBrowserKey(WORKSPACE, box.env)),
      ...{
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string | URL) {
            super(url, {
              headers: { Origin: app.url.slice(0, -1) },
            } as unknown as string[]);
          }
        },
      },
    });
    const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const readStatus = async (): Promise<{
      response: Response;
      body: { caughtUp: boolean; rooms: Record<string, { hubAcked: boolean }> };
    }> => {
      const response = await fetch(`${app.url}api/status`, {
        headers: bearer(auth),
      });
      return {
        response,
        body: (await response.json()) as {
          caughtUp: boolean;
          rooms: Record<string, { hubAcked: boolean }>;
        },
      };
    };

    try {
      await waitUntil("the browser directory to load locally", () =>
        provider.isSynced,
      );
      await waitUntil("the serving replica to be caught up", async () => {
        const { body } = await readStatus();
        return body.caughtUp && body.rooms[room]?.hubAcked === true;
      });
      const current = await readStatus();
      expect(current.response.status).toBe(200);
      expect(current.response.headers.get("cache-control")).toBe("no-store");
      expect(current.response.headers.get("access-control-allow-origin")).toBeNull();
      expect(current.body).toEqual({
        notSharedReason: null,
        caughtUp: true,
        rooms: { [room]: { hubAcked: true } },
      });

      await hub.stop();
      await waitUntil("the status reading to notice the lost hub", async () => {
        const { body } = await readStatus();
        return !body.caughtUp && body.rooms[room]?.hubAcked === false;
      });

      await startHub(box, hubPort);
      await waitUntil("the serving replica to catch up after reconnect", async () => {
        const { body } = await readStatus();
        return body.caughtUp && body.rooms[room]?.hubAcked === true;
      });
    } finally {
      provider.destroy();
      doc.destroy();
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("admits API requests exactly through the served workspace token boundary", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const app = await open(box, ["--port", String(await freePort())], env);
    const now = Math.floor(Date.now() / 1_000);
    const valid = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const refused: { name: string; auth?: string; suffix?: string }[] = [
      { name: "missing" },
      { name: "hub signing secret", auth: await authMessage(SECRET) },
      { name: "malformed", auth: "not-an-envelope" },
      { name: "bad signature", auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", { secret: "wrong" }) },
      {
        name: "protocol mismatch",
        auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", {
          protocolVersion: SYNC_PROTOCOL_VERSION + 1,
        }),
      },
      {
        name: "other workspace",
        auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", { workspace: REBOUND_WORKSPACE }),
      },
      {
        name: "lifetime beyond the ceiling",
        auth: await forgedAuthMessage(localBrowserKey(WORKSPACE, box.env), {
          typ: "room",
          sub: "compromised-minter",
          workspace: WORKSPACE,
          scope: "read-only",
          kid: null,
          iat: now,
          exp: now + MAX_TOKEN_LIFETIME_SECONDS + 1,
        }),
      },
      {
        name: "token in query",
        auth: valid,
        suffix: `&token=${encodeURIComponent(valid)}`,
      },
    ];

    try {
      for (const sample of refused) {
        const paths = [
          `api/search?q=nothing${sample.suffix ?? ""}`,
          `api/status${sample.suffix?.replace(/^&/, "?") ?? ""}`,
        ];
        for (const path of paths) {
          const response = await fetch(
            `${app.url}${path}`,
            sample.auth === undefined
              ? undefined
              : { headers: bearer(sample.auth) },
          );
          expect(response.status, `${sample.name}: ${path}`).toBe(401);
          expect(response.headers.get("cache-control"), `${sample.name}: ${path}`)
            .toBe("no-store");
          expect(
            response.headers.get("access-control-allow-origin"),
            `${sample.name}: ${path}`,
          ).toBeNull();
        }
      }

      const unknown = await fetch(`${app.url}api/unknown`, {
        headers: bearer(valid),
      });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("cache-control")).toBe("no-store");
      expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  // --- #758: serving freezes the startup binding and reports rebound ----------

  it("freezes the serving binding and marks a later machine rebind", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    const before = await get(url);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );

    // `ub remote join` completes while this `ub open` keeps running.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: REBOUND_WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });

    // The live engine keeps its startup identity. A reload is told that the
    // machine moved underneath it, without silently retargeting the replica.
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env), true),
    );

    expect((await app.interrupt()).status).toBe(0);

    const restarted = await open(box, ["--port", String(webPort)], env);
    expect(await (await get(`${restarted.url}uberblick-config.json`)).text()).toBe(
      servingDocumentOf(
        restarted.url,
        SECOND_REMOTE,
        REBOUND_WORKSPACE,
        localBrowserKey(REBOUND_WORKSPACE, box.env),
      ),
    );
    expect((await restarted.interrupt()).status).toBe(0);
  });

  it("serves the last coherent document while `.init.lock` is held", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );

    // A write is in flight after its first publication. Pairing this new secret
    // with the old endpoint would authenticate against a hub nobody configured.
    const lock = await acquireInitLock(box.env);
    writeCredentials(box, REBOUND_SECRET);

    // Answered from the last document that resolved outside a write, and
    // answered *now*: the lock is consulted, never waited on. Its own holder
    // timeout is 2s, so anything near that would be this server waiting.
    const started = Date.now();
    const held = await get(url);
    const text = await held.text();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(text).toBe(servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)));

    writeBinding(box, SECOND_REMOTE, REBOUND_WORKSPACE);
    lock.release();
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env), true),
    );

    // Only an *active* write falls back like that. A completed removal is the
    // configuration: the frozen serving identity remains usable, but is marked
    // stale so a restart can adopt the removal coherently.
    rmSync(join(configDir(box), "credentials.json"), { force: true });
    expect(await (await get(url)).json()).toMatchObject({
      hubAuthToken: localBrowserKey(WORKSPACE, box.env),
      rebound: true,
    });

    expect((await app.interrupt()).status).toBe(0);
  });

  it("establishes its first document only after a two-file writer completes", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();

    // A real writer lock spans the two publications. Start `ub open` after the
    // new credential is visible but before its endpoint/workspace is: accepting
    // a startup document here would seed old/new for the server's lifetime.
    const writer = await acquireInitLock(box.env);
    writeCredentials(box, REBOUND_SECRET);
    const opening = open(box, ["--port", String(webPort)], env);

    const openedWhileTorn = await Promise.race([
      opening.then(() => true),
      sleep(500).then(() => false),
    ]);
    expect(openedWhileTorn).toBe(false);

    writeBinding(box, SECOND_REMOTE, REBOUND_WORKSPACE);
    writer.release();

    const app = await opening;
    expect(await (await get(`${app.url}uberblick-config.json`)).text()).toBe(
      servingDocumentOf(app.url, SECOND_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env)),
    );
    expect((await app.interrupt()).status).toBe(0);
  });

  it("keeps a genuine environment pin winning over the files it re-reads", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    // The pin a repository puts in its project MCP entry. It outranks this
    // machine's default, and re-resolving must not quietly demote it — nor
    // promote the file-sourced secret beside it into a pin of its own.
    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      WORKSPACE_ID: REBOUND_WORKSPACE,
    });
    const url = `${app.url}uberblick-config.json`;

    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env)),
    );

    // The files change underneath, naming a different workspace. The pin still
    // wins; changes in the endpoint and secret mark this process stale, while
    // the engine continues with its coherent startup snapshot.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env), true),
    );

    expect((await app.interrupt()).status).toBe(0);
  });

  it("releases both ports on Ctrl-C, so a second `ub open` succeeds at once", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    pointAt(box, hubUrl);

    const first = await open(box, ["--port", String(webPort)], env);
    expect(first.stdout()).toContain("started here");
    // A request first, so a keep-alive connection is open when the signal
    // arrives: `close()` alone waits for it, and the port would still be held.
    expect((await get(first.url)).status).toBe(200);
    expect((await first.interrupt()).status).toBe(0);

    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");

    const second = await open(box, ["--port", String(webPort)], env);
    expect(second.url).toBe(`http://127.0.0.1:${webPort}/`);
    expect((await second.interrupt()).status).toBe(0);
  });

  it("exits and releases the serving role when its replica refresh loop stops", async () => {
    const { box, env } = configured();
    const upstream = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${upstream.port}`);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    const databasePath = resolveMcpConfig({
      ...box.env,
      ...env,
      WORKSPACE_ID: WORKSPACE,
    }).databasePath;
    const database = openStore(databasePath);
    database.exec("DROP TABLE snapshots");
    database.close();

    const stopped = await app.wait();
    expect(stopped).toEqual({ status: 1, signal: null });
    expect(app.stderr()).toContain("local replica refresh failed");
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");

    // The same store and port can be served again immediately: the failed
    // process released its serving-role lock as part of the non-zero exit.
    const restarted = await open(box, ["--port", String(webPort)], env);
    expect((await restarted.interrupt()).status).toBe(0);
  });

  it("exits and releases the serving role when its replica is quarantined", async () => {
    const { box, env } = configured();
    const upstream = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${upstream.port}`;
    pointAt(box, hubUrl);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const room = directoryRoom(WORKSPACE);
    const remoteDoc = new Y.Doc();
    const remote = new HocuspocusProvider({
      url: hubUrl,
      name: room,
      document: remoteDoc,
      token: await authMessage(SECRET, "read-write"),
    });

    try {
      await waitUntil("the upstream peer to sync", () => remote.isSynced);
      const databasePath = resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
      }).databasePath;
      const database = openStore(databasePath);
      database.exec(`
        CREATE TRIGGER refuse_updates
        BEFORE INSERT ON updates
        BEGIN
          SELECT RAISE(FAIL, 'simulated append refusal');
        END
      `);
      database.close();

      // A remote update is already in this engine replica when its observer
      // reaches the refused append, which is the quarantine boundary.
      remoteDoc.getMap("quarantine-probe").set("changed", true);
      const stopped = await app.wait();
      expect(stopped).toEqual({ status: 1, signal: null });
      const terminalLines = app
        .stderr()
        .split("\n")
        .filter((line) => line.startsWith("ub open: local replica quarantined"));
      expect(terminalLines).toHaveLength(1);
      expect(terminalLines[0]).toContain(room);
      expect(terminalLines[0]).toContain("simulated append refusal");
      expect((await probePort("127.0.0.1", webPort)).state).toBe("free");

      const repaired = openStore(databasePath);
      repaired.exec("DROP TRIGGER refuse_updates");
      repaired.close();
      const restarted = await open(box, ["--port", String(webPort)], env);
      expect((await restarted.interrupt()).status).toBe(0);
    } finally {
      remote.destroy();
      remoteDoc.destroy();
    }
  });

  it("serves the configuration document uncached, ahead of the SPA fallback", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    pointAt(box, "wss://hub.example.ts.net/ws");
    const app = await open(box, ["--port", String(webPort)], env);

    const document = await get(`${app.url}uberblick-config.json`);
    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(document.headers.get("content-type")).toBe("application/json");
    const body = await document.text();
    expect(body).not.toContain("<!doctype html");
    expect(JSON.parse(body)).toMatchObject({
      hubUrl: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      remoteHubUrl: "wss://hub.example.ts.net/ws",
    });

    // The fallback is still there for deep links (#68) — which is exactly why
    // the document has to be matched before it.
    const deepLink = await get(`${app.url}${WORKSPACE}/6bd9d0b1-6d0e-4e5a-9c93-0a5c9f5a7e11`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("<title>uberblick</title>");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("refuses every HTTP surface before routing when Host is not the served address", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    pointAt(box, "wss://hub.example.ts.net/ws");
    const app = await open(box, ["--port", String(webPort)], env);
    const valid = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const samples = [
      { path: "uberblick-config.json", host: `rebound.example:${webPort}` },
      { path: "assets/app.js", host: `localhost:${webPort}` },
      { path: `${WORKSPACE}/unknown`, host: `[::1]:${webPort}` },
      { path: "api/unknown", host: `127.0.0.1:${webPort + 1}` },
      { path: "api/status", host: `rebound.example:${webPort}`, authorization: valid },
    ];

    try {
      for (const sample of samples) {
        const response = await getWithHost(
          `${app.url}${sample.path}`,
          sample.host,
          sample.authorization,
        );
        expect(response.status, sample.path).toBe(421);
        expect(response.headers["cache-control"], sample.path).toBe("no-store");
        expect(response.body, sample.path).toBe("misdirected request\n");
      }

      // Node may reject HTTP/1.1 without Host before the request reaches our
      // handler. Either layer must refuse it without exposing served content.
      const missing = await getWithHost(`${app.url}uberblick-config.json`, null);
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(missing.status).toBeLessThan(500);
      expect(missing.body).not.toContain(SECRET);
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("refuses rather than serving a blank page when there is no bundle", async () => {
    const { box, env } = configured();
    const empty = join(box.cwd, "not-a-bundle");
    mkdirSync(empty, { recursive: true });

    const refused = await openFails(box, [], { ...env, UBERBLICK_WEB_DIST: empty });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(empty);
    expect(refused.output).toContain("index.html");
    // The way out names the variable this user can set, not a checkout's task.
    expect(refused.output).toContain("UBERBLICK_WEB_DIST");
    expect(refused.output).not.toMatch(/mise/);

    // And in a checkout, an absent bundle is one to build rather than to
    // refuse: the web package is right there and the plan says so.
    expect(bundlePlan({}).action).not.toBe("missing");
  });

  it("refuses a bundle that speaks another sync protocol, and starts nothing", async () => {
    const { box, env, bundle } = configured();
    const hubPort = await freePort();
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);

    const refused = await openFails(box, [], env);

    expect(refused.status).toBe(1);
    // Both versions, so the reader can see which side is behind, and the way
    // out named rather than implied.
    expect(refused.output).toContain(bundle);
    expect(refused.output).toContain(`speaks sync protocol ${SYNC_PROTOCOL_VERSION + 1}`);
    expect(refused.output).toContain(`this uberblick speaks ${SYNC_PROTOCOL_VERSION}`);
    expect(refused.output).toContain("mise run build-web");

    // It served nothing and started nothing: a refusal that had bound a port or
    // opened a hub database would be the unsyncable page, served anyway.
    expect(refused.output).not.toMatch(BANNER);
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
    expect(existsSync(join(box.cwd, "started-hub.sqlite"))).toBe(false);
  });

  it("treats a bundle with no readable stamp as one that cannot sync", async () => {
    const { box, env, bundle } = configured();
    stamp(bundle, null);

    // The stale bundle actually observed: built before the stamp existed.
    const unstamped = await openFails(box, [], env);
    expect(unstamped.status).toBe(1);
    expect(unstamped.output).toContain("no sync protocol stamp");

    // A stamp that is not JSON is the same refusal, not a stack trace.
    writeFileSync(join(bundle, BUILD_STAMP), "{ not json", "utf8");
    const unparseable = await openFails(box, [], env);
    expect(unparseable.status).toBe(1);
    expect(unparseable.output).toContain("no sync protocol stamp");
  });

  it("rebuilds its own stale bundle with the documented task, in the checkout", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const io = stderrIo();

    const served = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
      calm(),
    );

    expect(served).toBe("servable");
    // Said before it happens, with both versions: a command that goes quiet for
    // a Vite build looks hung.
    expect(io.text()).toContain(`speaks sync protocol ${SYNC_PROTOCOL_VERSION + 1}`);
    expect(io.text()).toContain(`this uberblick speaks ${SYNC_PROTOCOL_VERSION}`);
    // Once, the documented task, from the checkout root — not a bare pnpm.
    expect(mise.calls()).toEqual([`${REPO_ROOT} run build-web`]);
  });

  it("rebuilds the bundle it chose, never one UBERBLICK_WEB_DIST named", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, null);
    const mise = fakeMise(box);

    // Ownership is the variable, not the path: the default directory named
    // explicitly is still an artifact its caller maintains.
    const chosen = bundlePlan({});
    expect(chosen.ours).toBe(true);
    expect(bundlePlan({ UBERBLICK_WEB_DIST: chosen.dir }).ours).toBe(false);
    // And it is the checkout's own `packages/web/dist` (#512): the rebuild path
    // reports success from the stamp in this directory, so a plan that quietly
    // moved would serve the old bundle and keep a green suite.
    expect(chosen.dir).toBe(join(REPO_ROOT, "packages", "web", "dist"));

    const io = stderrIo();
    const served = await ensureBundle(
      { action: "serve", dir: bundle, ours: false, installed: false },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
      calm(),
    );

    expect(served).toBe("refused");
    expect(mise.calls()).toEqual([]);
    expect(io.text()).toContain("no sync protocol stamp");
  });

  it("refuses when the rebuild cannot run, fails, or leaves the bundle stale", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, null);
    const mise = fakeMise(box);
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;
    const noTools = join(box.cwd, "no-tools");
    mkdirSync(noTools, { recursive: true });

    const unavailable = stderrIo();
    expect(await ensureBundle(plan, { ...box.env, PATH: noTools }, unavailable, calm())).toBe(
      "refused",
    );
    expect(unavailable.text()).toContain("could not be run");

    const failed = stderrIo();
    expect(
      await ensureBundle(
        plan,
        { ...box.env, PATH: mise.path, FAKE_EXIT_CODE: "3" },
        failed,
        calm(),
      ),
    ).toBe("refused");
    expect(failed.text()).toContain("exited 3");

    const stale = stderrIo();
    expect(
      await ensureBundle(
        plan,
        {
          ...box.env,
          PATH: mise.path,
          FAKE_STAMP_DIR: bundle,
          FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION + 2),
        },
        stale,
        calm(),
      ),
    ).toBe("refused");
    expect(stale.text()).toContain(
      `the rebuilt web app speaks sync protocol ${SYNC_PROTOCOL_VERSION + 2}`,
    );

    // Every refusal names both ways out, and none of them is "read the code".
    for (const said of [unavailable.text(), failed.text(), stale.text()]) {
      expect(said).toContain("mise run build-web");
      expect(said).toContain(REPO_ROOT);
      expect(said).toContain("UBERBLICK_WEB_DIST");
    }
  });

  it("waits for another run's build, then builds only what is still missing", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const env = {
      ...box.env,
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const io = stderrIo();
    const holder = await anotherRunBuilding(bundle, SYNC_PROTOCOL_VERSION);

    const waiting = ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    // Nothing was built behind the holder's back — which is the whole point:
    // `vite build` empties this directory before it writes it.
    expect(mise.calls()).toEqual([]);

    // The holder's build ends, leaving a current bundle. The waiter re-reads it
    // and has nothing left to do.
    await holder.finish();

    expect(await waiting).toBe("servable");
    expect(mise.calls()).toEqual([]);
  });

  it("never serves the stamp of a build that is still writing its directory", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "half-written");
    mkdirSync(dir, { recursive: true });
    const mise = fakeMise(box);
    const io = stderrIo();
    const holder = await anotherRunBuilding(dir);

    // What Vite's output directory looks like partway through a build: it emits
    // the stamp from `generateBundle` with nothing ordering it last, so a
    // current stamp can be there before `index.html` is.
    stamp(dir, SYNC_PROTOCOL_VERSION);

    const waiting = ensureBundle(
      { action: "serve", dir, ours: true, installed: false },
      { ...box.env, PATH: mise.path },
      io,
      calm(),
    );
    // Waiting, not serving: announcing is what a run does when it finds the
    // lock held, and taking the stamp at its word would have returned already.
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));

    // The rest of the holder's build, and then the lock.
    writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>\n", "utf8");
    await holder.finish();

    expect(await waiting).toBe("servable");
    expect(mise.calls()).toEqual([]);
  });

  it("builds when the run it waited for left a stamp and no bundle", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "abandoned");
    mkdirSync(dir, { recursive: true });
    const mise = fakeMise(box);
    const io = stderrIo();
    // The holder's build stamps this directory and then ends without ever
    // writing `index.html` — an ordinary non-zero exit does it. The waiter is
    // woken into precisely that state, and the stamp it re-reads under the lock
    // is the same one it already refused to serve outside it: nothing ran in
    // between. Take it at its word and this run announces success and answers
    // 404 for as long as it stays in the foreground.
    const holder = await anotherRunBuilding(dir, SYNC_PROTOCOL_VERSION);

    const env = {
      ...box.env,
      PATH: mise.path,
      FAKE_STAMP_DIR: dir,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const waiting = ensureBundle(
      { action: "serve", dir, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    expect(mise.calls()).toEqual([]);

    await holder.finish();

    expect(await waiting).toBe("servable");
    // It built, rather than serving the abandoned stamp, and said which of the
    // two things wrong with a bundle this one was.
    expect(mise.calls().length).toBe(1);
    expect(io.text()).toContain("stamp with no bundle behind it");
  });

  it("builds a stamp-only directory nobody is building, rather than serving it", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "stamp-only");
    mkdirSync(dir, { recursive: true });
    // The same half-written directory as above, except that the build which left
    // it was killed: nothing holds the lock, so nothing will ever finish it. Take
    // the stamp at its word here and every `ub open` from now on announces
    // success and answers 404.
    stamp(dir, SYNC_PROTOCOL_VERSION);
    const pnpm = fakeTool(box, "pnpm");
    const io = stderrIo();

    const outcome = await ensureBundle(
      { action: "build", dir, ours: true, installed: false },
      { ...box.env, PATH: pnpm.path, FAKE_EXIT_CODE: "1" },
      io,
      calm(),
    );

    // It built — and said so when the build failed, instead of serving nothing.
    expect(pnpm.calls().length).toBe(1);
    expect(outcome).toBe("refused");
    expect(io.text()).toContain("the web build failed");
  });

  it("takes that same lock for a first build, not only for a rebuild", async () => {
    const box = sandbox();
    const bundle = join(box.cwd, "not-built-yet");
    const pnpm = fakeTool(box, "pnpm");
    const env = {
      ...box.env,
      PATH: pnpm.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const io = stderrIo();
    const holder = await anotherRunBuilding(bundle);

    const waiting = ensureBundle(
      { action: "build", dir: bundle, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    expect(pnpm.calls()).toEqual([]);

    await holder.finish();
    expect(await waiting).toBe("servable");
    // One build, in the workspace root, once the lock was free.
    expect(pnpm.calls()).toEqual([`${join(REPO_ROOT, "packages")} --filter @uberblick/web build`]);
  });

  it("stops quietly on an interrupt, whether it is waiting or building", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;

    // Waiting for somebody else's build: no build of its own, and no failure.
    const waitEnv = { ...box.env, PATH: mise.path };
    const holder = await anotherRunBuilding(bundle);
    const waitingIo = stderrIo();
    const waitingStop = stoppable();
    const waiting = ensureBundle(plan, waitEnv, waitingIo, waitingStop);
    await waitUntil("the waiter to announce itself", () =>
      waitingIo.text().includes("waiting for it"),
    );
    waitingStop.stop();

    expect(await waiting).toBe("interrupted");
    expect(mise.calls()).toEqual([]);
    expect(waitingIo.text()).not.toContain("was not rebuilt");
    await holder.finish();

    // Running one: the signal is passed on to the build, and a build that ends
    // on it is this command stopping rather than a build that failed.
    const buildingIo = stderrIo();
    const buildingStop = stoppable();
    const building = ensureBundle(
      plan,
      { ...box.env, PATH: mise.path, FAKE_SLEEP: "5" },
      buildingIo,
      buildingStop,
    );
    await waitUntil("the build to start", () => mise.calls().length === 1);
    buildingStop.stop();

    expect(await building).toBe("interrupted");
    expect(buildingIo.text()).not.toContain("was not rebuilt");
  });

  it("excludes two runs of one checkout even when their configuration differs", async () => {
    // The hazard is one output directory, so the lock has to be that
    // directory's. Two sandboxes is two `XDG_CONFIG_HOME` values — which is what
    // this repository's own rig and its parallel agents produce — over one
    // bundle.
    const one = sandbox();
    const other = sandbox();
    const bundle = join(one.cwd, "shared-dist");
    mkdirSync(bundle, { recursive: true });
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(one);
    const build = {
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      // Still stale afterwards, so the second run has real work to do rather
      // than finding the first one's bundle and stopping.
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION + 1),
      FAKE_SLEEP: "0.3",
      FAKE_BUSY_DIR: join(one.cwd, "building"),
    };
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;
    const first = stderrIo();
    const second = stderrIo();

    const outcomes = await Promise.all([
      ensureBundle(plan, { ...one.env, ...build }, first, calm()),
      ensureBundle(plan, { ...other.env, ...build }, second, calm()),
    ]);

    // Both really did build — and the sentinel proves they never overlapped.
    expect(outcomes).toEqual(["refused", "refused"]);
    expect(mise.calls()).toHaveLength(2);
    for (const said of [first.text(), second.text()]) {
      expect(said).not.toContain("exited 9");
    }
  });

  it("a build somebody else killed is a failure, not this command stopping", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const io = stderrIo();

    // No signal reached this process, so a dead build is a build that did not
    // work — exit 1 with a reason, not the quiet exit 0 of a Ctrl-C.
    const outcome = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      { ...box.env, PATH: mise.path, FAKE_KILL_SELF: "1" },
      io,
      calm(),
    );

    expect(outcome).toBe("refused");
    expect(io.text()).toContain("was killed by SIGTERM");
  });

  it("hands both builds the same environment, and neither the signing secret", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const pnpm = fakeTool(box, "pnpm");
    const env = {
      ...box.env,
      HUB_AUTH_TOKEN: SECRET,
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };

    const rebuilt = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      env,
      stderrIo(),
      calm(),
    );
    const first = join(box.cwd, "first-build");
    const built = await ensureBundle(
      { action: "build", dir: first, ours: true, installed: false },
      { ...env, FAKE_STAMP_DIR: first },
      stderrIo(),
      calm(),
    );

    expect([rebuilt, built]).toEqual(["servable", "servable"]);
    // What `mise run build-web` puts back into its own child is that task's
    // business; what this command hands a build is neither path's secret.
    expect(mise.tokens()).toEqual(["<unset>"]);
    expect(pnpm.tokens()).toEqual(["<unset>"]);
  });

  it("--no-browser prints the URL and opens nothing; --port chooses the port", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    const browser = browserRecorder(box);
    pointAt(box, "wss://hub.example.ts.net/ws");

    // No TTY either way: a spawned child's stdio are pipes, not a terminal.
    const app = await open(box, ["--no-browser", "--port", String(webPort)], {
      ...env,
      BROWSER: browser.command,
    });

    expect(app.stdout()).toContain(`http://127.0.0.1:${webPort}/`);
    await sleep(500);
    expect(existsSync(browser.opened)).toBe(false);
    expect((await get(app.url)).status).toBe(200);

    expect((await app.interrupt()).status).toBe(0);
  });

  it.each([undefined, SECRET])("serves no key when unbound (configured secret: %s)", async (signingSecret) => {
    const box = sandbox(signingSecret === undefined ? {} : { credentials: { signingSecret } });
    const hubUrl = signingSecret === undefined ? "ws://localhost:1234" : `ws://127.0.0.1:${await freePort()}`;
    if (signingSecret !== undefined) pointAt(box, hubUrl);
    const bundle = fixtureBundle(box);
    const webPort = await freePort();

    const app = await open(box, ["--port", String(webPort)], {
      UBERBLICK_WEB_DIST: bundle,
      BROWSER: "none",
      HUB_DB_PATH: join(box.cwd, "unbound-hub.sqlite"),
    });

    // No `ub init`, so no workspace and no signing secret: the app is served
    // against the built-in endpoint, the switcher is offered nothing, and the
    // reason no hub was started is said out loud rather than left to look like
    // an offline one.
    expect(await (await get(`${app.url}uberblick-config.json`)).text()).toBe(
      JSON.stringify({ hubUrl, workspaces: [], hubAuthToken: "" }),
    );
    if (signingSecret === undefined) expect(app.stdout()).toContain("no signing secret");
    expect(app.stdout()).toContain("ub init");
    expect(app.stdout() + app.stderr()).not.toContain(SECRET);
    expect(existsSync(join(configDir(box), "browser-keys"))).toBe(false);

    const refusedConfig = await getWithHost(
      `${app.url}uberblick-config.json`,
      `localhost:${webPort}`,
    );
    const refusedApi = await getWithHost(
      `${app.url}api/status`,
      `foreign.example:${webPort}`,
    );
    for (const response of [refusedConfig, refusedApi]) {
      expect(response.status).toBe(421);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toBe("misdirected request\n");
    }

    const unboundApi = await get(`${app.url}api/search?q=unchanged`);
    expect(unboundApi.status).toBe(200);
    expect(unboundApi.headers.get("cache-control")).toBe("no-cache");
    expect(await unboundApi.text()).toContain("<title>uberblick</title>");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("names a taken port and refuses a second serving replica for the store", async () => {
    const { box, env } = configured();
    const foreignPort = await freePort();
    await answeringListener(foreignPort, 200, '{"not":"the config document"}');
    pointAt(box, "wss://hub.example.ts.net/ws");

    const foreign = await openFails(box, ["--port", String(foreignPort)], env);
    expect(foreign.status).toBe(1);
    expect(foreign.output).toContain(`port ${foreignPort}`);
    expect(foreign.output).toContain("another process");

    // A holder that never answers is nobody in particular, and the refusal for
    // it must not send the user to stop what may be their own `ub open` (#600).
    const silentPort = await freePort();
    await silentListener(silentPort);
    const silent = await openFails(box, ["--port", String(silentPort)], env);
    expect(silent.status).toBe(1);
    expect(silent.output).toContain(`port ${silentPort}`);
    expect(silent.output).toContain("--port");
    expect(silent.output).not.toContain("another process");
    expect(silent.output).not.toContain("`ub open`");
    expect(silent.output).not.toMatch(/stop/);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const secondPort = await freePort();
    const second = await openFails(box, ["--port", String(secondPort)], env);
    expect(second.status).toBe(1);
    expect(second.output).toContain("`ub open`");
    expect(second.output).toContain(WORKSPACE);
    expect(second.output).toContain(".sqlite");
    expect(second.output).toContain("process");
    expect((await probePort("127.0.0.1", secondPort)).state).toBe("free");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("identifies the port's holder from what it answers, not from the deadline", async () => {
    // Three holders, three behaviours, no race: each verdict follows from what
    // the holder does, so no ceiling on the probe's budget can change one.
    const servingPort = await freePort();
    await answeringListener(servingPort, 200, '{"hubUrl":"ws://127.0.0.1:1234"}');
    expect(await whoHoldsPort(servingPort)).toBe("ub-open");

    // A complete answer that is not the configuration document is the
    // definitive stranger — including a refusal, and a body that is not JSON.
    const refusingPort = await freePort();
    await answeringListener(refusingPort, 404, "no such thing");
    expect(await whoHoldsPort(refusingPort)).toBe("foreign");
    const gibberishPort = await freePort();
    await answeringListener(gibberishPort, 200, "<html>hello</html>");
    expect(await whoHoldsPort(gibberishPort)).toBe("foreign");

    const silentPort = await freePort();
    await silentListener(silentPort);
    expect(await whoHoldsPort(silentPort)).toBe("unidentified");
  });

  it("never binds a hub off loopback, whatever the endpoint says", async () => {
    const { box, env } = configured();
    const port = await freePort();

    // 0.0.0.0 is an address to *listen* on, and a hub bound there is on every
    // interface — offering the whole network a hub whose only credential is one
    // shared signing secret.
    pointAt(box, `ws://0.0.0.0:${port}`);
    const refused = await openFails(box, ["--port", String(await freePort())], env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("binds loopback only");
    expect(refused.output).toContain("0.0.0.0");
    // Exposing a hub deliberately is the remote deployment's job, and that is
    // what the refusal points at — no contributor task stands in for it.
    expect(refused.output).toContain("REMOTE.md");
    expect(refused.output).not.toMatch(/mise/);
    // Refused means refused: nothing was left listening there.
    expect((await probePort("0.0.0.0", port)).state).toBe("free");

    // And a *name* that merely looks like loopback is not one: where
    // `127.attacker.example` resolves is somebody else's decision, so a prefix
    // test on the string would bind the shared-secret hub wherever they say.
    pointAt(box, `ws://127.attacker.example:${port}`);
    const named = await openFails(box, ["--port", String(await freePort())], env);
    expect(named.status).toBe(1);
    expect(named.output).toContain("binds loopback only");
    expect(named.output).toContain("127.attacker.example");
  });

  it("starts a hub only for an endpoint the hub it starts could answer", async () => {
    const { box, env } = configured();
    const port = await freePort();
    const webPort = await freePort();

    // A hub started here speaks plain ws on loopback. Announcing one at an
    // endpoint it does not answer would be a hub nothing can reach.
    pointAt(box, `wss://127.0.0.1:${port}`);
    const tls = await openFails(box, ["--port", String(webPort)], env);
    expect(tls.status).toBe(1);
    expect(tls.output).toContain("plain ws://");

    pointAt(box, "ws://127.0.0.1");
    const noPort = await openFails(box, ["--port", String(webPort)], env);
    expect(noPort.status).toBe(1);
    expect(noPort.output).toContain("names no port to bind");

    pointAt(box, "ws://127.0.0.1:0");
    const ephemeral = await openFails(box, ["--port", String(webPort)], env);
    expect(ephemeral.status).toBe(1);
    expect(ephemeral.output).toContain("names no port to bind");
  });

  it("an interrupt while it is still coming up stops the hub it started", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();

    // Interrupted the instant the hub has bound its socket — before the web
    // server is up, and so before there is any banner.
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const run = await interruptWhen(
      box,
      ["--port", String(webPort)],
      env,
      () => untilBound(hubPort),
    );

    // Exit 0, not death by signal: with the handlers installed only once
    // everything is up, Node's default SIGINT kills the process right here —
    // taking the hub down without the flush its durability contract is made of.
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("uberblick is at");
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
  });

  it("refuses when the hub's endpoint is held by something that is not a hub", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    await silentListener(hubPort);

    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const refused = await openFails(box, ["--port", String(await freePort())], env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("held by something else");
    expect(refused.output).toContain(`ws://127.0.0.1:${hubPort}`);
  });
});

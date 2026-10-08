/**
 * Fixtures shared by the `ub open` suites: `open.test.ts`, `open-ports.test.ts`
 * and `open-remote.test.ts`. See `open.test.ts` for why the world is real.
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
import type { Hub, TokenClaims, TokenScope } from "@uberblick/hub";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  createHub,
  importRootSecret,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/hub/protocol";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import type { Io } from "../src/io.js";
import type { Stop } from "../src/open.js";
import { ensureBundle } from "../src/open.js";
import { probeHub, probePort } from "../src/probes.js";
import type { Sandbox } from "./helpers.js";
import {
  UB_BIN,
  WAIT_TIMEOUT_MS,
  removeTempDirs,
  runUbAsync,
  sandbox,
  waitUntil,
} from "./helpers.js";

export const WORKSPACE = "b4d1f0a7-3c62-4e91-8f05-7ad2c9e61b38";
export const SECRET = "open-test-signing-secret-9d31fa";

/** What a `ub workspace join` mid-run leaves behind, for the #449 tests. */
export const REBOUND_WORKSPACE = "c7e2b105-9a48-4d6f-b3e1-5f0c8a71d264";
export const REBOUND_SECRET = "open-test-rotated-secret-4b7c21";
export const FIRST_REMOTE = "wss://first.example.ts.net/ws";
export const SECOND_REMOTE = "wss://second.example.ts.net/ws";

export const hubs: Hub[] = [];
export const listeners: { server: Server; sockets: Socket[] }[] = [];
export const children: ChildProcess[] = [];
/** {@link anotherRunBuilding} holders, so no build outlives the test that made it. */
export const holders: (() => Promise<void>)[] = [];

/**
 * Stop everything a test left running and remove its sandboxes. Every `ub
 * open` suite registers it with `afterEach`.
 */
export async function cleanUp(): Promise<void> {
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
}

// --- fixtures ----------------------------------------------------------------

/** A port nothing is listening on: bound, read back, and released. */
export async function freePort(): Promise<number> {
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
export function openStore(databasePath: string): DatabaseSync {
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
export async function silentListener(port: number): Promise<void> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  listeners.push({ server, sockets });
}

/** A process holding a port and giving one complete HTTP answer to everything. */
export async function answeringListener(
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

export async function startHub(box: Sandbox, port = 0): Promise<Hub> {
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
export const BUILD_STAMP = "uberblick-build.json";

/** Give a fixture bundle the stamp of a build — `version`, or none at all. */
export function stamp(dir: string, version: number | null): void {
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
export function fixtureBundle(box: Sandbox): string {
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
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

export interface FakeTool {
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
export function fakeTool(box: Sandbox, command: string): FakeTool {
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

export const fakeMise = (box: Sandbox): FakeTool => fakeTool(box, "mise");

/** A {@link Stop} that never fires: the paths where no signal is involved. */
export function calm(): Stop {
  return { interrupted: () => false, signalled: new Promise<void>(() => {}) };
}

/** A {@link Stop} the test decides the moment of, standing in for Ctrl-C. */
export function stoppable(): Stop & { stop: () => void } {
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
export async function anotherRunBuilding(
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
export function stderrIo(): Io & { text: () => string } {
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
export function browserRecorder(box: Sandbox): { command: string; opened: string } {
  const opened = join(box.cwd, "opened.txt");
  const command = join(box.cwd, "record-browser.sh");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${opened}\n`, "utf8");
  chmodSync(command, 0o755);
  return { command, opened };
}

/** Whether a real client can open the workspace's directory room on `hubUrl`. */
export async function hubAnswers(box: Sandbox, hubUrl: string): Promise<boolean> {
  const config = resolveMcpConfig({
    ...box.env,
    WORKSPACE_ID: WORKSPACE,
    HUB_AUTH_TOKEN: SECRET,
    UBERBLICK_DB: join(box.cwd, `probe-${Math.random().toString(36).slice(2)}.sqlite`),
  });
  return (await probeHub(config, hubUrl)) === "connected";
}

// --- the running command -----------------------------------------------------

export interface Running {
  url: string;
  stdout: () => string;
  stderr: () => string;
  /** The command's own terminal outcome, without sending it a signal. */
  wait: () => Promise<{ status: number | null; signal: string | null }>;
  /** SIGINT, then the exit status — what Ctrl-C in a terminal does. */
  interrupt: () => Promise<{ status: number | null; signal: string | null }>;
}

export const BANNER = /uberblick is at (http:\/\/\S+)/;

/**
 * Start `ub open` and resolve once it is actually serving.
 *
 * The banner is the readiness signal, and it is printed after both ports are
 * bound — so a test that has this handle can make a request without polling.
 */
export async function open(
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
export async function interruptWhen(
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
export async function untilBound(port: number): Promise<void> {
  await waitUntil(
    `the hub \`ub open\` starts to bind port ${port}`,
    async () => (await probePort("127.0.0.1", port)).state !== "free",
  );
}

/** Run `ub open` expecting it to refuse, and hand back what it said. */
export async function openFails(
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
export function configured(): {
  box: Sandbox;
  env: NodeJS.ProcessEnv;
  bundle: string;
} {
  const box = sandbox({
    projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
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

export async function get(url: string): Promise<Response> {
  return await fetch(url, { cache: "no-store" });
}

export async function getWithHost(
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
export function configDir(box: Sandbox): string {
  return join(box.configHome, "uberblick");
}

/**
 * Rebind this project, the way `ub workspace join` or `ub workspace use` leaves it:
 * a different endpoint, workspace and signing secret, across both files.
 */
export function rebind(
  box: Sandbox,
  binding: { hubUrl: string; workspace: string; signingSecret: string },
): void {
  const dir = configDir(box);
  mkdirSync(dir, { recursive: true });
  writeCredentials(box, binding.signingSecret);
  writeBinding(box, binding.hubUrl, binding.workspace);
}

export function writeCredentials(box: Sandbox, signingSecret: string): void {
  const dir = configDir(box);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    `${JSON.stringify({ signingSecret }, null, 2)}\n`,
    "utf8",
  );
  chmodSync(join(dir, "credentials.json"), 0o600);
}

export function writeBinding(box: Sandbox, hubUrl: string, workspace: string): void {
  writeFileSync(
    join(box.cwd, ".uberblick.json"),
    `${JSON.stringify({ workspaceId: workspace, hubUrl }, null, 2)}\n`,
    "utf8",
  );
}

export function servingDocumentOf(
  appUrl: string,
  remoteHubUrl: string,
  workspace: string,
  secret: string,
  rebound = false,
  otherWorkspaces: Record<string, { browserKey: string; remoteHubUrl: string | null }> = {},
): string {
  const hubUrl = appUrl.replace(/^http:/, "ws:").replace(/\/$/, "");
  return JSON.stringify({
    hubUrl,
    workspaces: [workspace, ...Object.keys(otherWorkspaces)],
    hubAuthToken: secret,
    remoteHubUrl,
    ...(rebound ? { rebound: true } : {}),
    servedWorkspaces: { [workspace]: { browserKey: secret, remoteHubUrl }, ...otherWorkspaces },
  });
}

export async function authMessage(
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

export async function forgedAuthMessage(key: string, claims: TokenClaims): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importRootSecret(key),
    new TextEncoder().encode(payload),
  );
  return wrapToken(`${payload}.${Buffer.from(signature).toString("base64url")}`);
}

export function bearer(auth: string): Record<string, string> {
  return { authorization: `Bearer ${auth}` };
}

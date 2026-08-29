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
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInitLock } from "../src/init-lock.js";
import type { Io } from "../src/io.js";
import { bundlePlan, ensureBundle } from "../src/open.js";
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

/** A process holding a port and answering nothing — the foreign-holder case. */
async function foreignListener(port: number): Promise<void> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
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

/**
 * A `mise` on PATH that records how it was called and behaves as it is told:
 * `FAKE_STAMP_VERSION` is stamped into `FAKE_STAMP_DIR`, `FAKE_EXIT_CODE` is
 * what it exits with. A real `mise run build-web` here would be a Vite build of
 * the repository's own bundle — minutes, and a checkout mutated by a test.
 */
function fakeMise(box: Sandbox): { path: string; calls: () => string[] } {
  const bin = join(box.cwd, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const record = join(box.cwd, "mise-calls.txt");
  writeFileSync(
    join(bin, "mise"),
    "#!/bin/sh\n" +
      `printf '%s %s\\n' "$PWD" "$*" >> ${record}\n` +
      'if [ -n "$FAKE_STAMP_VERSION" ]; then\n' +
      '  printf \'{"syncProtocolVersion":%s}\' "$FAKE_STAMP_VERSION" \\\n' +
      '    > "$FAKE_STAMP_DIR/uberblick-build.json"\n' +
      "fi\n" +
      'if [ -z "$FAKE_EXIT_CODE" ]; then FAKE_EXIT_CODE=0; fi\n' +
      'exit "$FAKE_EXIT_CODE"\n',
    "utf8",
  );
  chmodSync(join(bin, "mise"), 0o755);
  return {
    path: bin,
    calls: () =>
      existsSync(record)
        ? readFileSync(record, "utf8").split("\n").filter(Boolean)
        : [],
  };
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

function documentOf(hubUrl: string, workspace: string, secret: string): string {
  return `{"hubUrl":"${hubUrl}","workspaces":["${workspace}"],"hubAuthToken":"${secret}"}`;
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
    expect(await (await get(app.url)).text()).toContain("<title>uberblick</title>");
    expect(await (await get(`${app.url}assets/app.js`)).text()).toContain("marker");

    // The hub it started is one a real client can open the workspace's
    // directory room on — which is what the document list hydrates from.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
    expect(app.stdout()).toContain("started here");

    // The browser was handed the address that is actually being served.
    await sleep(500);
    expect(readFileSync(browser.opened, "utf8").trim()).toBe(app.url);

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
      hubUrl,
    });

    expect((await app.interrupt()).status).toBe(0);
    // The hub this command did not start is the hub it did not stop.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
  });

  it("serves a bundle pointed at a configured remote, and starts no hub", async () => {
    const { box, env } = configured();
    const remote = "wss://hub.example.ts.net/ws";
    pointAt(box, remote);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    // Byte-exact: the path and the shape are #91's contract, and the web
    // client's fallback is silent enough that a wrong document looks like an
    // offline hub rather than a misconfiguration. The secret is in it since
    // #426 — the bundle carries none, so a document without it would serve an
    // app that cannot authenticate.
    const document = await get(`${app.url}uberblick-config.json`);
    expect(await document.text()).toBe(
      `{"hubUrl":"${remote}","workspaces":["${WORKSPACE}"],"hubAuthToken":"${SECRET}"}`,
    );
    expect(app.stdout()).toContain("remote — nothing started here");

    expect((await app.interrupt()).status).toBe(0);
  });

  // --- #449: the served document tracks the machine, not the startup ---------

  it("serves the machine's current binding, not the one it started with", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    const before = await get(url);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.text()).toBe(documentOf(FIRST_REMOTE, WORKSPACE, SECRET));

    // `ub remote join` completes while this `ub open` keeps running.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: REBOUND_WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });

    // The next request — a reload, in a browser — sees all three new values
    // together. Restarting `ub open` used to be the only way to get here.
    expect(await (await get(url)).text()).toBe(
      documentOf(SECOND_REMOTE, REBOUND_WORKSPACE, REBOUND_SECRET),
    );

    expect((await app.interrupt()).status).toBe(0);
  });

  it("serves the last coherent document while `.init.lock` is held", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    expect(await (await get(url)).text()).toBe(
      documentOf(FIRST_REMOTE, WORKSPACE, SECRET),
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
    expect(text).toBe(documentOf(FIRST_REMOTE, WORKSPACE, SECRET));

    writeBinding(box, SECOND_REMOTE, REBOUND_WORKSPACE);
    lock.release();
    expect(await (await get(url)).text()).toBe(
      documentOf(SECOND_REMOTE, REBOUND_WORKSPACE, REBOUND_SECRET),
    );

    // Only an *active* write falls back like that. A completed removal is the
    // configuration: the client is told there is no secret rather than handed
    // one that is no longer on disk.
    rmSync(join(configDir(box), "credentials.json"), { force: true });
    expect(await (await get(url)).json()).toMatchObject({ hubAuthToken: "" });

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
      documentOf(SECOND_REMOTE, REBOUND_WORKSPACE, REBOUND_SECRET),
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
      documentOf(FIRST_REMOTE, REBOUND_WORKSPACE, SECRET),
    );

    // The files change underneath, naming a different workspace. The pin still
    // wins; the endpoint and the secret, which no pin covers, follow the files.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });
    expect(await (await get(url)).text()).toBe(
      documentOf(SECOND_REMOTE, REBOUND_WORKSPACE, REBOUND_SECRET),
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
    expect(JSON.parse(body).hubUrl).toBe("wss://hub.example.ts.net/ws");

    // The fallback is still there for deep links (#68) — which is exactly why
    // the document has to be matched before it.
    const deepLink = await get(`${app.url}${WORKSPACE}/6bd9d0b1-6d0e-4e5a-9c93-0a5c9f5a7e11`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("<title>uberblick</title>");

    expect((await app.interrupt()).status).toBe(0);
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
      { action: "serve", dir: bundle, ours: true },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
    );

    expect(served).toBe(true);
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

    const io = stderrIo();
    const served = await ensureBundle(
      { action: "serve", dir: bundle, ours: false },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
    );

    expect(served).toBe(false);
    expect(mise.calls()).toEqual([]);
    expect(io.text()).toContain("no sync protocol stamp");
  });

  it("refuses when the rebuild cannot run, fails, or leaves the bundle stale", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, null);
    const mise = fakeMise(box);
    const plan = { action: "serve", dir: bundle, ours: true } as const;
    const noTools = join(box.cwd, "no-tools");
    mkdirSync(noTools, { recursive: true });

    const unavailable = stderrIo();
    expect(await ensureBundle(plan, { ...box.env, PATH: noTools }, unavailable)).toBe(false);
    expect(unavailable.text()).toContain("could not be run");

    const failed = stderrIo();
    expect(
      await ensureBundle(plan, { ...box.env, PATH: mise.path, FAKE_EXIT_CODE: "3" }, failed),
    ).toBe(false);
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
      ),
    ).toBe(false);
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

  it("works with no configuration files at all", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    const webPort = await freePort();

    const app = await open(box, ["--port", String(webPort)], {
      UBERBLICK_WEB_DIST: bundle,
      BROWSER: "none",
    });

    // No `ub init`, so no workspace and no signing secret: the app is served
    // against the built-in endpoint, the switcher is offered nothing, and the
    // reason no hub was started is said out loud rather than left to look like
    // an offline one.
    expect(await (await get(`${app.url}uberblick-config.json`)).text()).toBe(
      '{"hubUrl":"ws://localhost:1234","workspaces":[],"hubAuthToken":""}',
    );
    expect(app.stdout()).toContain("no signing secret");
    expect(app.stdout()).toContain("ub init");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("names the web port when it is taken, and says who has it", async () => {
    const { box, env } = configured();
    const foreignPort = await freePort();
    await foreignListener(foreignPort);
    pointAt(box, "wss://hub.example.ts.net/ws");

    const foreign = await openFails(box, ["--port", String(foreignPort)], env);
    expect(foreign.status).toBe(1);
    expect(foreign.output).toContain(`port ${foreignPort}`);
    expect(foreign.output).toContain("another process");

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const second = await openFails(box, ["--port", String(webPort)], env);
    expect(second.status).toBe(1);
    expect(second.output).toContain(`port ${webPort}`);
    expect(second.output).toContain("`ub open`");

    expect((await app.interrupt()).status).toBe(0);
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
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
  });

  it("refuses when the hub's endpoint is held by something that is not a hub", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    await foreignListener(hubPort);

    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const refused = await openFails(box, ["--port", String(await freePort())], env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("held by something else");
    expect(refused.output).toContain(`ws://127.0.0.1:${hubPort}`);
  });
});

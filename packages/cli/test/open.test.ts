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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { bundlePlan } from "../src/open.js";
import { probeHub, probePort } from "../src/probes.js";
import type { Sandbox } from "./helpers.js";
import { UB_BIN, removeTempDirs, runUbAsync, sandbox } from "./helpers.js";

const WORKSPACE = "b4d1f0a7-3c62-4e91-8f05-7ad2c9e61b38";
const SECRET = "open-test-signing-secret-9d31fa";

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

/** A bundle the way `ub open` finds one: a directory with an index.html in it. */
function fixtureBundle(box: Sandbox): string {
  const dir = join(box.cwd, "bundle");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><title>uberblick</title><div id=root></div>\n",
    "utf8",
  );
  writeFileSync(join(dir, "assets", "app.js"), "export const marker = 42;\n", "utf8");
  return dir;
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

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

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

  const deadline = Date.now() + 30_000;
  for (;;) {
    const match = BANNER.exec(stdout);
    if (match?.[1] !== undefined) {
      return {
        url: match[1],
        stdout: () => stdout,
        stderr: () => stderr,
        interrupt: async () => {
          child.kill("SIGINT");
          return await exited;
        },
      };
    }
    if (over) {
      throw new Error(`ub open exited before it served:\n${stdout}${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`ub open never served:\n${stdout}${stderr}`);
    }
    await sleep(25);
  }
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
  await when();
  child.kill("SIGINT");
  return await new Promise((done) => {
    child.on("close", (status, signal) => done({ status, signal, output }));
  });
}

/** Resolve once something is listening on `port` — here, the hub `ub open` started. */
async function untilBound(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await probePort("127.0.0.1", port)).state !== "free") {
      return;
    }
    await sleep(20);
  }
  throw new Error(`nothing ever bound port ${port}`);
}

/** Run `ub open` expecting it to refuse, and hand back what it said. */
async function openFails(
  box: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; output: string }> {
  const run = await runUbAsync(["open", ...args], box, extraEnv, 30_000);
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

// --- the criteria ------------------------------------------------------------

describe("ub open", () => {
  it("starts a hub, serves the bundle, and opens the browser at the served URL", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    const browser = browserRecorder(box);

    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: hubUrl,
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
  }, 60_000);

  it("uses a hub that is already answering, and Ctrl-C leaves it running", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;
    const webPort = await freePort();

    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: hubUrl,
    });

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
  }, 60_000);

  it("after `ub remote set`, serves a bundle pointed at the remote and starts no hub", async () => {
    const { box, env } = configured();
    const remote = "wss://hub.example.ts.net/ws";
    const set = await runUbAsync(["remote", "set", remote], box);
    expect(set.status).toBe(0);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    // Byte-exact: the path and the shape are #91's contract, and the web
    // client's fallback is silent enough that a wrong document looks like an
    // offline hub rather than a misconfiguration.
    const document = await get(`${app.url}uberblick-config.json`);
    expect(await document.text()).toBe(
      `{"hubUrl":"${remote}","workspaces":["${WORKSPACE}"]}`,
    );
    expect(app.stdout()).toContain("remote — nothing started here");

    expect((await app.interrupt()).status).toBe(0);
  }, 60_000);

  it("releases both ports on Ctrl-C, so a second `ub open` succeeds at once", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;

    const first = await open(box, ["--port", String(webPort)], { ...env, HUB_URL: hubUrl });
    expect(first.stdout()).toContain("started here");
    // A request first, so a keep-alive connection is open when the signal
    // arrives: `close()` alone waits for it, and the port would still be held.
    expect((await get(first.url)).status).toBe(200);
    expect((await first.interrupt()).status).toBe(0);

    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");

    const second = await open(box, ["--port", String(webPort)], { ...env, HUB_URL: hubUrl });
    expect(second.url).toBe(`http://127.0.0.1:${webPort}/`);
    expect((await second.interrupt()).status).toBe(0);
  }, 60_000);

  it("serves the configuration document uncached, ahead of the SPA fallback", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: "wss://hub.example.ts.net/ws",
    });

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
  }, 60_000);

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
  }, 60_000);

  it("--no-browser prints the URL and opens nothing; --port chooses the port", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    const browser = browserRecorder(box);

    // No TTY either way: a spawned child's stdio are pipes, not a terminal.
    const app = await open(box, ["--no-browser", "--port", String(webPort)], {
      ...env,
      HUB_URL: "wss://hub.example.ts.net/ws",
      BROWSER: browser.command,
    });

    expect(app.stdout()).toContain(`http://127.0.0.1:${webPort}/`);
    await sleep(500);
    expect(existsSync(browser.opened)).toBe(false);
    expect((await get(app.url)).status).toBe(200);

    expect((await app.interrupt()).status).toBe(0);
  }, 60_000);

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
      '{"hubUrl":"ws://localhost:1234","workspaces":[]}',
    );
    expect(app.stdout()).toContain("no signing secret");
    expect(app.stdout()).toContain("ub init");

    expect((await app.interrupt()).status).toBe(0);
  }, 60_000);

  it("names the web port when it is taken, and says who has it", async () => {
    const { box, env } = configured();
    const foreignPort = await freePort();
    await foreignListener(foreignPort);

    const foreign = await openFails(box, ["--port", String(foreignPort)], {
      ...env,
      HUB_URL: "wss://hub.example.ts.net/ws",
    });
    expect(foreign.status).toBe(1);
    expect(foreign.output).toContain(`port ${foreignPort}`);
    expect(foreign.output).toContain("another process");

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: "wss://hub.example.ts.net/ws",
    });
    const second = await openFails(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: "wss://hub.example.ts.net/ws",
    });
    expect(second.status).toBe(1);
    expect(second.output).toContain(`port ${webPort}`);
    expect(second.output).toContain("`ub open`");

    expect((await app.interrupt()).status).toBe(0);
  }, 60_000);

  it("never binds a hub off loopback, whatever HUB_URL says", async () => {
    const { box, env } = configured();
    const port = await freePort();

    // 0.0.0.0 is an address to *listen* on, and a hub bound there is on every
    // interface — offering the whole network a hub whose only credential is one
    // shared signing secret.
    const refused = await openFails(box, ["--port", String(await freePort())], {
      ...env,
      HUB_URL: `ws://0.0.0.0:${port}`,
    });
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
    const named = await openFails(box, ["--port", String(await freePort())], {
      ...env,
      HUB_URL: `ws://127.attacker.example:${port}`,
    });
    expect(named.status).toBe(1);
    expect(named.output).toContain("binds loopback only");
    expect(named.output).toContain("127.attacker.example");
  }, 90_000);

  it("starts a hub only for an endpoint the hub it starts could answer", async () => {
    const { box, env } = configured();
    const port = await freePort();
    const webPort = await freePort();

    // A hub started here speaks plain ws on loopback. Announcing one at an
    // endpoint it does not answer would be a hub nothing can reach.
    const tls = await openFails(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: `wss://127.0.0.1:${port}`,
    });
    expect(tls.status).toBe(1);
    expect(tls.output).toContain("plain ws://");

    const noPort = await openFails(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: "ws://127.0.0.1",
    });
    expect(noPort.status).toBe(1);
    expect(noPort.output).toContain("names no port to bind");

    const ephemeral = await openFails(box, ["--port", String(webPort)], {
      ...env,
      HUB_URL: "ws://127.0.0.1:0",
    });
    expect(ephemeral.status).toBe(1);
    expect(ephemeral.output).toContain("names no port to bind");
  }, 90_000);

  it("an interrupt while it is still coming up stops the hub it started", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();

    // Interrupted the instant the hub has bound its socket — before the web
    // server is up, and so before there is any banner.
    const run = await interruptWhen(
      box,
      ["--port", String(webPort)],
      { ...env, HUB_URL: `ws://127.0.0.1:${hubPort}` },
      () => untilBound(hubPort),
    );

    // Exit 0, not death by signal: with the handlers installed only once
    // everything is up, Node's default SIGINT kills the process right here —
    // taking the hub down without the flush its durability contract is made of.
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
  }, 60_000);

  it("refuses when the hub's endpoint is held by something that is not a hub", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    await foreignListener(hubPort);

    const refused = await openFails(box, ["--port", String(await freePort())], {
      ...env,
      HUB_URL: `ws://127.0.0.1:${hubPort}`,
    });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("held by something else");
    expect(refused.output).toContain(`ws://127.0.0.1:${hubPort}`);
  }, 60_000);
});

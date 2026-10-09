#!/usr/bin/env node
/**
 * The promises a new user is made, asserted — inside the image `Dockerfile.fue`
 * builds, with no network at all.
 *
 * The install phase already happened, in the build: this script runs afterwards
 * in a container started with `--network none`, so nothing it observes can be
 * coming off our machines. That is the point. uberblick claims to be
 * local-first, and the honest way to test that claim is to take the wire away
 * and see whether a fresh install still works.
 *
 * Plain Node with no imports beyond `node:`: this file has to run before
 * anything vouches for the tree it runs in, and a dependency of its own would
 * be one more thing the install path has to have got right.
 *
 * Failure output is one line naming the first broken step, because whoever
 * reads it is looking at a wall of Docker output and needs to know where to
 * start, not what the stack looked like.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

/** Where the documented `mise run dev` puts the two servers. */
const HUB_PORT = 1234;
const WEB_PORT = 5173;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const OPEN_PORT = 13379;
const REPOSITORY_ROOT = process.cwd();
const PROJECT_ROOT = join(dirname(REPOSITORY_ROOT), "fue-workspace");
const CONFIG_ROOT = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"), "uberblick");
const DATA_ROOT = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, ".local", "share"), "uberblick");
const credentialsPath = join(CONFIG_ROOT, "credentials.json");

/** The step in progress, so a failure anywhere can name it. */
let step = "startup";

/** Every background service, so one exit path can take them all down. */
const services = [];

const startedAt = Date.now();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The first non-empty line of a process's output — a diagnostic, not a dump. */
function firstLine(text) {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line === undefined ? "(no output)" : line;
}

function elapsed() {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`;
}

async function assert(name, fn) {
  step = name;
  const value = await fn();
  process.stdout.write(`fue: ok — ${name} (${elapsed()})\n`);
  return value;
}

/** Run a command to completion, capturing both streams. Never hangs. */
function run(command, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `\`${command} ${args.join(" ")}\` did not finish within ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`\`${command}\` would not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Start a long-running service in its own process group.
 *
 * The group matters: `mise run hub` is mise, which spawns pnpm, which spawns
 * tsx. Signalling the group is what actually stops the server rather than
 * orphaning it and leaving the port bound.
 */
function background(label, command, args, { cwd, env } = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd,
    env,
  });
  const chunks = [];
  const collect = (chunk) => {
    chunks.push(String(chunk));
    // Bounded: a dev server that runs for a minute would otherwise be held in
    // memory in full, and only the tail is ever printed.
    if (chunks.length > 400) chunks.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let stopped = null;
  child.once("exit", (code, signal) => {
    stopped = signal === null ? `exited ${code}` : `was killed by ${signal}`;
  });
  child.once("error", (error) => {
    stopped = `would not start: ${error.message}`;
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, or never started. Nothing left to do either way.
    }
  };
  const service = {
    label,
    output: () => chunks.join(""),
    stopped: () => stopped,
    /** What Ctrl-C sends, to the group a terminal would send it to. */
    interrupt: () => signalGroup("SIGINT"),
    /** The safety net at exit: nothing gets to decline this one. */
    stop: () => signalGroup("SIGKILL"),
    closed,
  };
  services.push(service);
  return service;
}

async function stopServices() {
  for (const service of services) service.stop();
  await Promise.all(services.map(service => service.closed));
}

/**
 * Poll until `probe` answers truthfully, and fail with a line that says what
 * was being waited for and what the service said instead.
 */
async function waitFor(what, probe, { timeoutMs, service = null }) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    if (service !== null && service.stopped() !== null) {
      throw new Error(
        `${service.label} ${service.stopped()} before ${what} — ${firstLine(service.output())}`,
      );
    }
    try {
      const value = await probe();
      if (value !== undefined && value !== false && value !== null) return value;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() >= deadline) {
      const said =
        service === null
          ? ""
          : ` — ${service.label} said: ${firstLine(service.output())}`;
      throw new Error(
        `${what} did not happen within ${timeoutMs / 1000}s${last === "" ? "" : ` (last error: ${last})`}${said}`,
      );
    }
    await sleep(500);
  }
}

/** The opposite of {@link tcpOpen}, and never an error: refusal is the answer. */
function tcpRefused(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

function tcpOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function ubStatusJson(options = {}) {
  const result = await run("ub", ["status", "--json"], options);
  if (result.code !== 0) {
    throw new Error(
      `\`ub status --json\` exited ${result.code}: ${firstLine(result.stderr)}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `\`ub status --json\` did not print one JSON object: ${firstLine(result.stdout)}`,
    );
  }
}

/**
 * One `list_docs` call through `ub mcp serve`, spoken the way a real client
 * speaks it: newline-delimited JSON-RPC over the process's stdio.
 *
 * Hand-rolled rather than driven with the MCP SDK on purpose. The SDK is a
 * dependency of the server under test, so using it here would let one version
 * mismatch hide behind another — and a stray byte on stdout, which the server
 * must never write, shows up here as the corrupted session it is.
 */
async function listDocsOverStdio({ cwd, env } = {}) {
  const child = spawn("ub", ["mcp", "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env,
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";

  const abort = (message) => {
    const error = new Error(message);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // stdout is the transport. Anything else on it is a corrupted session,
        // and saying so beats letting the read time out.
        abort(`the server wrote non-JSON to stdout: ${line.slice(0, 120)}`);
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) continue;
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(`the server refused the call: ${message.error.message}`));
      } else {
        waiter.resolve(message.result);
      }
    }
  });
  child.once("exit", (code, signal) => {
    abort(
      `\`ub mcp serve\` ${signal === null ? `exited ${code}` : `was killed by ${signal}`}: ${firstLine(stderr)}`,
    );
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  const timeout = setTimeout(() => {
    abort(`\`ub mcp serve\` did not answer within 60s: ${firstLine(stderr)}`);
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }, 60_000);

  try {
    await request("initialize", {
      // The server negotiates: a version it does not speak is answered with the
      // one it does, never refused.
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "uberblick-fue-proof", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const result = await request("tools/call", {
      name: "list_docs",
      arguments: {},
    });
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("`list_docs` returned no text content");
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      child.kill("SIGTERM");
    } catch {
      // Gone already.
    }
    await closed;
    clearTimeout(forceStop);
  }
}

async function get(path, accept) {
  const response = await fetch(`${WEB_ORIGIN}${path}`, {
    headers: { accept },
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
}

async function main() {
  // 0. `ub` itself, before starting the development services. The documented
  //    install must put the CLI on PATH for contributors and MCP clients.
  await assert("`ub` is on PATH after the documented install", async () => {
    const found = await run("sh", ["-c", "command -v ub"]);
    if (found.code !== 0 || found.stdout.trim() === "") {
      throw new Error(
        "`ub` is not on PATH after `mise run setup`; contributor commands and MCP clients cannot start it",
      );
    }
    const version = await run("ub", ["--version"]);
    if (version.code !== 0) {
      throw new Error(
        `\`ub --version\` exited ${version.code}: ${firstLine(version.stderr)}`,
      );
    }
    process.stdout.write(`fue:   ub at ${found.stdout.trim()}\n`);
  });

  const committedBinding = readFileSync(join(REPOSITORY_ROOT, ".uberblick.json"));
  await assert("setup creates no workspace or signing secret", async () => {
    if (existsSync(CONFIG_ROOT) || existsSync(DATA_ROOT)) {
      throw new Error("`mise run setup` created private Uberblick configuration or data");
    }
  });

  // Setup preserves the committed remote binding. Exercise the independent
  // local-first journey in a fresh directory outside that checkout.
  let secret;
  await assert("`ub workspace create` seeds a fresh local workspace and secret", async () => {
    mkdirSync(PROJECT_ROOT);
    const created = await run("ub", ["workspace", "create", "First-user workspace"], { cwd: PROJECT_ROOT });
    if (created.code !== 0) {
      throw new Error(`\`ub workspace create\` exited ${created.code}: ${firstLine(created.stderr)}`);
    }
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    secret = credentials.signingSecret;
    if (typeof secret !== "string" || secret.trim() === "") {
      throw new Error("`ub workspace create` left no local signing secret");
    }
    if ((statSync(credentialsPath).mode & 0o777) !== 0o600) {
      throw new Error("`ub workspace create` did not publish credentials.json with mode 0600");
    }
    if (created.stdout.includes(secret) || created.stderr.includes(secret)) {
      throw new Error("`ub workspace create` printed its signing secret");
    }
    if (!readFileSync(join(REPOSITORY_ROOT, ".uberblick.json")).equals(committedBinding)) {
      throw new Error("creating a separate workspace changed the checkout's committed binding");
    }
  });

  const report = await assert("`ub status` names the fresh workspace", async () => {
    const human = await run("ub", ["status"], { cwd: PROJECT_ROOT });
    if (human.code !== 0) {
      throw new Error(
        `\`ub status\` exited ${human.code}: ${firstLine(human.stderr)}`,
      );
    }
    const json = await ubStatusJson({ cwd: PROJECT_ROOT });
    if (typeof json.workspace !== "string" || json.workspace === "") {
      throw new Error("`ub status` reported no workspace after `ub workspace create`");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        json.workspaceUuid ?? "",
      )
    ) {
      throw new Error(
        `\`ub status\` reported a workspace that is not a uuid: ${json.workspaceUuid}`,
      );
    }
    if (!human.stdout.includes(json.workspace)) {
      throw new Error("`ub status` did not print the workspace it reports as JSON");
    }
    if (json.credentialPresent !== true) {
      throw new Error("`ub workspace create` left this machine with no usable hub signing secret");
    }
    process.stdout.write(
      `fue:   workspace ${json.workspace}, credential from ${json.credentialSource}\n`,
    );
    return json;
  });

  // 2. What an agent gets. `ub mcp serve` is the line every MCP client is
  //    pointed at, and `list_docs` is the first thing one calls.
  await assert("`list_docs` answers through `ub mcp serve`", async () => {
    const listed = await listDocsOverStdio({ cwd: PROJECT_ROOT });
    if (!Array.isArray(listed.docs)) {
      throw new Error("`list_docs` did not return a `docs` array");
    }
    if (listed.workspace !== report.workspaceUuid) {
      throw new Error(
        `\`list_docs\` answered for workspace ${listed.workspace}, not the configured ${report.workspaceUuid}`,
      );
    }
    const titles = new Set(listed.docs.map(doc => doc.title));
    if (!titles.has("Welcome to Überblick") || !titles.has("How to Use It") || listed.docs.length !== 2) {
      throw new Error("`list_docs` did not return the two starter documents");
    }
    process.stdout.write(
      `fue:   ${listed.docs.length} document(s): ${listed.docs.map((doc) => doc.title).join(", ")}\n`,
    );
  });

  await assert("the checkout web app builds offline", async () => {
    const built = await run("mise", ["run", "build-web"], { timeoutMs: 180_000 });
    if (built.code !== 0) {
      throw new Error(`\`mise run build-web\` exited ${built.code}: ${firstLine(built.stderr)}`);
    }
  });

  const open = background("`ub open --no-browser`", "ub", ["open", "--no-browser"], { cwd: PROJECT_ROOT });
  await assert("`ub open --no-browser` starts a hub accepting the created secret", async () => {
    await waitFor("the local hub to listen", () => tcpOpen(HUB_PORT), { timeoutMs: 90_000, service: open });
    await waitFor("the local web app to listen", () => tcpOpen(OPEN_PORT), { timeoutMs: 90_000, service: open });
    await waitFor("`ub open` to report its local hub", () => open.output().includes("started here"), { timeoutMs: 90_000, service: open });
    await waitFor("the local hub to accept the stored secret", async () => {
      const status = await ubStatusJson({ cwd: PROJECT_ROOT });
      return status.hub?.status === "connected";
    }, { timeoutMs: 90_000, service: open });
    if (JSON.parse(readFileSync(credentialsPath, "utf8")).signingSecret !== secret) {
      throw new Error("`ub open` replaced the secret workspace create supplied to agents");
    }
    if (open.output().includes(secret)) {
      throw new Error("`ub open` printed its signing secret");
    }
  });
  await assert("Ctrl-C stops the hub and web app `ub open` started", async () => {
    open.interrupt();
    await waitFor("`ub open` to exit", () => open.stopped() !== null, { timeoutMs: 30_000 });
    await open.closed;
    await waitFor("the local hub port to close", () => tcpRefused(HUB_PORT), { timeoutMs: 30_000 });
    await waitFor("the local web port to close", () => tcpRefused(OPEN_PORT), { timeoutMs: 30_000 });
  });

  // 3. `mise run dev` — the command CONTRIBUTING.md gives a contributor, not
  //    the two halves it happens to be made of. Starting the hub and the web
  //    server separately here would test two tasks nobody was told to run and
  //    leave the orchestration itself unproven: `dev` fans out explicitly
  //    because `depends` serializes two long-running tasks under MISE_JOBS=1,
  //    and a regression back to `depends` is a dev loop where the web server
  //    never starts — invisible to a proof that starts it by hand.
  const localEnv = { ...process.env, UB_WORKSPACE_ID: report.workspaceUuid, UB_HUB_URL: "local" };
  const dev = background("`mise run dev`", "mise", ["run", "dev"], { env: localEnv });
  await assert("`mise run dev` starts the hub", () =>
    waitFor(
      `the hub to accept connections on ${HUB_PORT}`,
      () => tcpOpen(HUB_PORT),
      { timeoutMs: 90_000, service: dev },
    ),
  );

  // The port alone proves a process; this proves the credential. A hub that
  // rejects the secret workspace creation generated is exactly the broken first run this
  // task exists to catch, and it is invisible from outside the connection.
  await assert("the hub accepts this machine's credential", () =>
    waitFor(
      "`ub status` to report the hub connected",
      async () => {
        const json = await ubStatusJson({ env: localEnv });
        if (json.hub?.status === "auth-failed") {
          throw new Error(`the hub rejected this machine's token: ${json.hub.reason}`);
        }
        return json.hub?.status === "connected";
      },
      { timeoutMs: 90_000, service: dev },
    ),
  );

  await assert("the web client answers on / and carries the workspace", async () => {
    const root = await waitFor(
      `the web dev server to answer on ${WEB_ORIGIN}/`,
      async () => {
        const response = await get("/", "text/html");
        return response.status === 200 ? response : false;
      },
      { timeoutMs: 120_000, service: dev },
    );
    if (!root.body.includes('id="root"')) {
      throw new Error(
        "the web dev server answered / with something that is not the app shell",
      );
    }

    // Where `/` goes is decided in the browser, so the no-browser proof is that
    // the client was *served* this machine's workspace. With no workspace in
    // that document the app renders "no workspace" instead of redirecting — the
    // deployed root-route gap, in the one form a plain fetch can see.
    //
    // One carrier since #426: the dev server answers the same
    // `/uberblick-config.json` a deployment does, and that document is now the
    // whole of what configures the client. Bodies are never printed from here —
    // the signing secret is in this one.
    //
    // Parsed, and read out of `workspaces` specifically: a substring search
    // over the whole body would also be satisfied by a uuid that happened to
    // sit in `hubAuthToken`, and this assertion is about the workspace list `/`
    // redirects through. Entries may be decorated (`<slug>-<uuid>`), so an
    // entry *containing* the uuid is what counts.
    const carrier = "/uberblick-config.json";
    const document = await get(carrier, "application/json").catch(() => ({
      status: 0,
      body: "",
    }));
    let workspaces = [];
    try {
      const parsed = JSON.parse(document.body).workspaces;
      // The client reads a JSON array and one comma-separated string as the
      // same list; so does this.
      workspaces = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "string"
          ? parsed.split(",")
          : [];
    } catch {
      // Not JSON at all — the SPA fallback, or nothing served. `workspaces`
      // stays empty and the message below is the same one either way.
    }
    if (
      !workspaces.some(
        (entry) => typeof entry === "string" && entry.includes(report.workspaceUuid),
      )
    ) {
      throw new Error(
        `the served client carries no workspace (${carrier} answered HTTP ${document.status} with ${workspaces.length} workspace(s)), so / renders 'no workspace' instead of redirecting into one`,
      );
    }

    // The address that redirect lands on. A dev server without SPA fallback
    // answers it with a 404, and every link anyone shares is broken.
    const deep = await get(`/${report.workspace}`, "text/html");
    if (deep.status !== 200 || !deep.body.includes('id="root"')) {
      throw new Error(
        `the workspace address /${report.workspace} answered HTTP ${deep.status} instead of the app`,
      );
    }
  });

  // Ctrl-C, which is how everyone ends a dev session. `dev` installs
  // `trap 'kill 0'` precisely so the interrupt takes the whole group down; a
  // regression there leaves a hub bound to 1234 after the terminal is gone, and
  // the next `mise run dev` fails on a port nobody can explain.
  await assert("Ctrl-C stops everything `mise run dev` started", async () => {
    dev.interrupt();
    // No `service:` on any of these — the exit IS the expected outcome here,
    // and waitFor treats a stopped service as a failure everywhere else.
    await waitFor("`mise run dev` to exit", () => dev.stopped() !== null, {
      timeoutMs: 30_000,
    });
    await dev.closed;
    await waitFor(
      `the hub to release port ${HUB_PORT}`,
      () => tcpRefused(HUB_PORT),
      { timeoutMs: 30_000 },
    );
    await waitFor(
      `the web dev server to release port ${WEB_PORT}`,
      () => tcpRefused(WEB_PORT),
      { timeoutMs: 30_000 },
    );
    process.stdout.write(`fue:   \`mise run dev\` ${dev.stopped()}, both ports free\n`);
  });
}

try {
  await main();
  process.stdout.write(
    `\nfue: PASSED — the documented install path works, offline (${elapsed()})\n`,
  );
  await stopServices();
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nfue: FAILED at ${step} — ${firstLine(error.message)}\n`);
  await stopServices();
  process.exit(1);
}

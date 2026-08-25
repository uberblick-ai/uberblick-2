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
import { createConnection } from "node:net";

/** Where the documented `mise run dev` puts the two servers. */
const HUB_PORT = 1234;
const WEB_ORIGIN = "http://localhost:5173";

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
function run(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
function background(label, command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
  const service = {
    label,
    output: () => chunks.join(""),
    stopped: () => stopped,
    stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, or never started. Nothing left to do either way.
      }
    },
  };
  services.push(service);
  return service;
}

function stopServices() {
  for (const service of services) service.stop();
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

async function ubStatusJson() {
  const result = await run("ub", ["status", "--json"]);
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
async function listDocsOverStdio() {
  const child = spawn("ub", ["mcp", "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    try {
      child.kill("SIGTERM");
    } catch {
      // Gone already.
    }
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
  // 1. The command a new user runs first to find out whether any of this
  //    worked. It has to exit 0 and name the workspace `ub init` just made.
  const report = await assert("`ub status` names the fresh workspace", async () => {
    const human = await run("ub", ["status"]);
    if (human.code !== 0) {
      throw new Error(
        `\`ub status\` exited ${human.code}: ${firstLine(human.stderr)}`,
      );
    }
    const json = await ubStatusJson();
    if (typeof json.workspace !== "string" || json.workspace === "") {
      throw new Error("`ub status` reported no workspace after `mise run setup`");
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
    // With no age key and no fnox secret, `ub init` must have generated one:
    // this is the contributor path, and a machine that can never authenticate
    // to a hub is the failure it would otherwise hide until `mise run dev`.
    if (json.credentialPresent !== true) {
      throw new Error(
        "`ub init` left this machine with no hub signing secret — the generated development secret is missing",
      );
    }
    process.stdout.write(
      `fue:   workspace ${json.workspace}, credential from ${json.credentialSource}\n`,
    );
    return json;
  });

  // 2. What an agent gets. `ub mcp serve` is the line every MCP client is
  //    pointed at, and `list_docs` is the first thing one calls.
  await assert("`list_docs` answers through `ub mcp serve`", async () => {
    const listed = await listDocsOverStdio();
    if (!Array.isArray(listed.docs)) {
      throw new Error("`list_docs` did not return a `docs` array");
    }
    if (listed.workspace !== report.workspaceUuid) {
      throw new Error(
        `\`list_docs\` answered for workspace ${listed.workspace}, not the configured ${report.workspaceUuid}`,
      );
    }
    // Conditional on purpose: a fresh install ships starter documents once #192
    // lands, and until then an empty corpus is the correct answer. Either is a
    // pass; a server that cannot answer at all is not.
    process.stdout.write(
      listed.docs.length === 0
        ? "fue:   empty corpus, served healthily — no starter documents in this build\n"
        : `fue:   ${listed.docs.length} document(s): ${listed.docs.map((doc) => doc.title).join(", ")}\n`,
    );
  });

  // 3. `mise run dev`, one half at a time so a failure names which half.
  const hub = background("`mise run hub`", "mise", ["run", "hub"]);
  await assert("`mise run hub` binds its port", () =>
    waitFor(
      `the hub to accept connections on ${HUB_PORT}`,
      () => tcpOpen(HUB_PORT),
      { timeoutMs: 90_000, service: hub },
    ),
  );

  // The port alone proves a process; this proves the credential. A hub that
  // rejects the secret `ub init` generated is exactly the broken first run this
  // task exists to catch, and it is invisible from outside the connection.
  await assert("the hub accepts this machine's credential", () =>
    waitFor(
      "`ub status` to report the hub connected",
      async () => {
        const json = await ubStatusJson();
        if (json.hub?.status === "auth-failed") {
          throw new Error(`the hub rejected this machine's token: ${json.hub.reason}`);
        }
        return json.hub?.status === "connected";
      },
      { timeoutMs: 90_000, service: hub },
    ),
  );

  const web = background("`mise run web`", "mise", ["run", "web"]);
  await assert("the web client answers on / and carries the workspace", async () => {
    const root = await waitFor(
      `the web dev server to answer on ${WEB_ORIGIN}/`,
      async () => {
        const response = await get("/", "text/html");
        return response.status === 200 ? response : false;
      },
      { timeoutMs: 120_000, service: web },
    );
    if (!root.body.includes('id="root"')) {
      throw new Error(
        "the web dev server answered / with something that is not the app shell",
      );
    }

    // Where `/` goes is decided in the browser, so the no-browser proof is that
    // the client was *served* this machine's workspace. With an empty
    // `__WORKSPACE_ID__` the app renders "no workspace" instead of redirecting —
    // the deployed root-route gap, in the one form a plain fetch can see.
    //
    // Two candidates because Vite has moved where a dev build's `define` values
    // live: it inlines them into each transformed module in some versions and
    // assigns them as globals from `/@vite/env` in others. Either counts; both
    // missing means the workspace never reached the browser. Bodies are never
    // printed from here — the signing secret is one of those defines.
    const carriers = ["/@vite/env", "/src/config.ts"];
    const responses = await Promise.all(
      carriers.map((path) => get(path, "*/*").catch(() => ({ status: 0, body: "" }))),
    );
    if (!responses.some((response) => response.body.includes(report.workspaceUuid))) {
      throw new Error(
        `the served client carries no workspace (checked ${carriers.join(" and ")}), so / renders 'no workspace' instead of redirecting into one`,
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
}

try {
  await main();
  process.stdout.write(
    `\nfue: PASSED — the documented install path works, offline (${elapsed()})\n`,
  );
  stopServices();
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nfue: FAILED at ${step} — ${firstLine(error.message)}\n`);
  stopServices();
  process.exit(1);
}

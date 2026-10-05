/** Real CLI login with terminal state injected inside the process; no real browsers. */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AUTH_LOGIN_HELP } from "../src/auth.js";
import { removeTempDirs, sandbox, UB_BIN, waitUntil, type Run, type Sandbox } from "./helpers.js";

const URL = "https://github.com/login/device";
const WORKSPACE = "ac77a342-650e-4897-9134-0d8f69a2902e";
const REQUEST = "e8c8641d-f8de-4794-bf9a-f326cfdb6747";
const PRINCIPAL = "dc2f8c55-4a8d-4f0c-ad68-3b287ac23d74";
const login = {
  identity: { id: PRINCIPAL, githubAccountId: "1234", githubUsername: "browser-test-user" },
  credential: {
    record: { id: REQUEST, principalId: PRINCIPAL, deviceId: WORKSPACE,
      workspaces: [WORKSPACE], issuedAt: 0, revokedAt: null },
    key: Buffer.alloc(32, 8).toString("base64url"),
  },
};
const started = { status: "pending", requestId: REQUEST,
  collectionSecret: Buffer.alloc(32, 9).toString("base64url"),
  verificationUri: URL, userCode: "ABCD-EFGH", expiresIn: 30, interval: 1 };
const servers: Server[] = [];
const pidRecords: string[] = [];

afterEach(async () => {
  for (const path of pidRecords.splice(0)) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").trim().split("\n")) {
      const pid = Number(line);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid recorder PID");
      try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ }
      await waitUntil("recorder browser exits", () => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }, 5_000);
    }
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(removeTempDirs);

async function hub(start: unknown = started, unclaimed = true, pending = false, startStatus = 200) {
  const routes: string[] = [];
  let polls = 0;
  const server = createServer((request, response) => {
    routes.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/auth/claim-state") response.end(JSON.stringify({ unclaimed, canClaim: unclaimed }));
    else if (request.url === "/auth/github/start") {
      response.statusCode = startStatus;
      response.end(JSON.stringify(start));
    } else if (request.url === "/auth/github/collect") {
      polls++;
      response.end(JSON.stringify(pending && polls === 1
        ? { status: "pending", interval: 1 }
        : { status: "complete", ...login, claimedWorkspaceId: WORKSPACE }));
    } else response.end(JSON.stringify({ status: "abandoned" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return { origin: `http://127.0.0.1:${address.port}`, routes };
}

function guidance(origin: string, unclaimed = true): string {
  return `Hub: ${origin}\nThis project's hub and workspace binding is unchanged.\n` +
    (unclaimed ? "This hub is unclaimed. The first GitHub account to complete approval becomes administrator of its default workspace.\n" : "") +
    `GitHub sign-in for ${origin}\nApprove in a browser: ${URL}\nCode: ABCD-EFGH\n` +
    "GitHub's approval page shows the app's name, not the hub.\n" +
    `Approve only if you started this login for ${origin}; the app does not vouch for this hub.\nWaiting for GitHub approval…\n`;
}

function stdout(origin: string, unclaimed = true): string {
  return guidance(origin, unclaimed) +
    `This login claimed the hub. Default workspace: ${WORKSPACE}\nStored login for ${origin}.\n` +
    'GitHub username recorded at sign-in: "browser-test-user"\n' +
    `Credential covers workspaces: ${WORKSPACE}\n` +
    "Remote sync uses this stored login. Run `ub open` to edit in this computer’s browser.\n";
}

function recorder(box: Sandbox, mode = "success") {
  const command = join(box.cwd, "browser.mjs");
  const record = join(box.cwd, "opened.json");
  writeFileSync(command, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, url: process.argv[2] }));
${mode === "hang" ? "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000);" : `process.exit(${mode === "fail" ? 9 : 0});`}
`);
  chmodSync(command, 0o755);
  return { command, record };
}

function run(box: Sandbox, origin: string, browser: string, tty = true,
  extraEnv: NodeJS.ProcessEnv = {}, synchronousFailure = false, interrupt = false) {
  const shim = join(box.cwd, "terminal.mjs");
  const trace = join(box.cwd, "opener-trace.jsonl");
  const pidRecord = join(box.cwd, "opener-pid.txt");
  pidRecords.push(pidRecord);
  // A process-local seam: no shipped option or environment input for tests.
  writeFileSync(shim, `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process.stdout, 'isTTY', { value: ${tty} });
let output = ''; const write = process.stdout.write;
process.stdout.write = function(chunk, ...args) { output += chunk.toString(); return write.call(this, chunk, ...args); };
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (command === ${JSON.stringify(browser)}) {
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, output }) + '\\n');
    ${synchronousFailure ? "throw new Error('synchronous opener failure');" : ""}
  }
  const child = spawn.call(this, command, args, options);
  if (command === ${JSON.stringify(browser)} && child.pid) {
    appendFileSync(${JSON.stringify(pidRecord)}, String(child.pid) + '\\n');
    ${interrupt ? "queueMicrotask(() => process.kill(process.pid, 'SIGINT'));" : ""}
  }
  return child;
};
syncBuiltinESMExports();
`);
  const env: NodeJS.ProcessEnv = { ...box.env, BROWSER: browser };
  delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
  const result = new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", shim, UB_BIN, "auth", "login", origin], {
      cwd: box.cwd, env: { ...env, ...extraEnv }, timeout: 8_000,
    });
    let out = ""; let err = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); });
    child.stderr.on("data", chunk => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout: out, stderr: err, output: out + err }));
  });
  return { result, calls: () => existsSync(trace)
    ? readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)) as { args: string[]; output: string }[]
    : [] };
}

function expectStored(box: Sandbox, origin: string) {
  const store = JSON.parse(readFileSync(join(box.configHome, "uberblick", "credentials.json"), "utf8"));
  expect(store.hubLogins[origin]).toEqual(login);
}

describe("login browser handoff", () => {
  it.each([true, false])("opens once after guidance, with unclaimed notice=%s", async unclaimed => {
    const remote = await hub(started, unclaimed, true);
    const box = sandbox(); const browser = recorder(box);
    const cli = run(box, remote.origin, browser.command);
    const result = await cli.result;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(stdout(remote.origin, unclaimed));
    expect(result.stderr).toBe("");
    expect(cli.calls()).toEqual([{ args: [URL], output: guidance(remote.origin, unclaimed) }]);
    expect(JSON.parse(readFileSync(browser.record, "utf8")).url).toBe(URL);
    expect(remote.routes.filter(route => route.endsWith("collect"))).toHaveLength(2);
    expectStored(box, remote.origin);
  });

  it.each([
    [false, {}], [true, { SSH_CONNECTION: "remote connection" }],
    [true, { SSH_CLIENT: "remote client" }], [true, { SSH_TTY: "/dev/pts/1" }],
    [true, { SSH_TTY: "" }], [true, { BROWSER: "none" }],
  ] as const)("preserves login without opening for tty=%s and env=%j", async (tty, env) => {
    const remote = await hub(); const box = sandbox(); const browser = recorder(box);
    const cli = run(box, remote.origin, browser.command, tty, env);
    const result = await cli.result;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(stdout(remote.origin));
    expect(result.stderr).toBe("");
    expect(cli.calls()).toEqual([]);
    expect(existsSync(browser.record)).toBe(false);
    expectStored(box, remote.origin);
  });

  it.each(["missing", "fail", "hang", "synchronous"])("%s opener leaves polling and storage unchanged", async mode => {
    const remote = await hub(); const box = sandbox(); const browser = recorder(box, mode);
    const command = mode === "missing" ? join(box.cwd, "missing-browser") : browser.command;
    const cli = run(box, remote.origin, command, true, {}, mode === "synchronous");
    const result = await cli.result;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(stdout(remote.origin));
    expect(cli.calls()).toHaveLength(1);
    expect(remote.routes).not.toContain("/auth/github/cancel");
    expectStored(box, remote.origin);
    if (mode === "missing" || mode === "synchronous") expect(result.stderr).toMatch(/warning: could not open a browser/);
    else expect(result.stderr).toBe("");
    if (mode === "hang") {
      const pid = JSON.parse(readFileSync(browser.record, "utf8")).pid;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
    }
  });

  it.each([
    ["refused", { status: "busy" }, 429],
    ["wrong-url", { ...started, verificationUri: "https://attacker.invalid/" }, 200],
    ["wrong-code", { ...started, userCode: "unsafe-code" }, 200],
    ["wrong-envelope", { ...started, status: "unsupported" }, 200],
    ["wrong-authority", { ...started, collectionSecret: "invalid" }, 200],
    ["wrong-lifetime", { ...started, expiresIn: 901 }, 200],
    ["wrong-status", started, 201],
  ] as const)("never opens for a %s start even in a local terminal", async (_name, start, status) => {
    const remote = await hub(start, true, false, status); const box = sandbox(); const browser = recorder(box);
    const cli = run(box, remote.origin, browser.command);
    const result = await cli.result;
    expect(result.status).toBe(1);
    expect(cli.calls()).toEqual([]);
    expect(existsSync(browser.record)).toBe(false);
    expect(result.stdout).not.toContain("Approve in a browser:");
    expect(remote.routes).not.toContain("/auth/github/collect");
  });

  it("interrupts and cancels normally after the opener starts", async () => {
    const remote = await hub(); const box = sandbox(); const browser = recorder(box);
    const cli = run(box, remote.origin, browser.command, true, {}, false, true);
    const result = await cli.result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub sign-in interrupted");
    expect(result.stdout).toBe(guidance(remote.origin));
    expect(cli.calls()).toHaveLength(1);
    expect(remote.routes).toContain("/auth/github/cancel");
    expect(remote.routes).not.toContain("/auth/github/collect");
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(false);
  });

  it("owns browser guidance in login help without adding an option", () => {
    expect(AUTH_LOGIN_HELP).toContain("opens automatically");
    expect(AUTH_LOGIN_HELP).toContain("Over SSH or when stdout is not a terminal");
    expect(AUTH_LOGIN_HELP).toContain("BROWSER=none");
    expect(AUTH_LOGIN_HELP).not.toContain("--no-browser");
  });
});

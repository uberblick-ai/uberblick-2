/** Hostname display metadata is optional and never changes sign-in authority. */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { manageRequest } from "../src/access-management.js";
import {
  cleanUp, credentialPath, fixture, rig, savedLogin, serve,
} from "./auth-fixtures.js";
import {
  removeTempDirs, sandbox, sleep, UB_BIN, waitUntil, type Run, type Sandbox,
} from "./helpers.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

const REQUEST_ID = "9eb84a4c-1bf7-4e20-a6fd-8f97a85c2be1";
const started = {
  status: "pending", requestId: REQUEST_ID,
  collectionSecret: Buffer.alloc(32, 9).toString("base64url"),
  verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 30, interval: 1,
};

function loginWithHostname(box: Sandbox, origin: string, value: string | undefined, throws = false) {
  const shim = join(box.cwd, "hostname.mjs");
  // The built-in is replaced only inside this test process, with no shipped seam.
  writeFileSync(shim, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.hostname = () => { ${throws ? "throw new Error('hostname unavailable');" : `return ${JSON.stringify(value)};`} };
syncBuiltinESMExports();
`);
  const child = spawn(process.execPath, ["--import", shim, UB_BIN, "auth", "login", origin], {
    cwd: box.cwd, env: { ...box.env, SSH_CONNECTION: "test remote session" }, timeout: 15_000,
  });
  const result = new Promise<Run>((resolve, reject) => {
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr, output: stdout + stderr }));
  });
  return { child, result };
}

async function olderHub(refusal = { status: 400, result: { status: "invalid-request" } as Record<string, unknown> },
  refuseEmpty = false, beforeRefusal: (() => Promise<void>) | undefined = undefined) {
  const login = fixture([]);
  const starts: Record<string, unknown>[] = [];
  const cancellations: Record<string, unknown>[] = [];
  const remote = await serve((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/auth/claim-state") {
        response.end(JSON.stringify({ unclaimed: false, canClaim: false }));
      } else if (request.url === "/auth/github/start") {
        starts.push(body);
        if (Object.keys(body).length > 0 || refuseEmpty) {
          await beforeRefusal?.();
          response.statusCode = refusal.status;
          response.end(JSON.stringify(refusal.result));
        } else response.end(JSON.stringify(started));
      } else if (request.url === "/auth/github/collect") {
        response.end(JSON.stringify({ status: "complete", ...login }));
      } else if (request.url === "/auth/github/cancel") {
        cancellations.push(body);
        response.end(JSON.stringify({ status: "abandoned" }));
      } else {
        response.statusCode = 404; response.end();
      }
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  return { ...remote, login, starts, cancellations };
}

describe("CLI device hostname metadata", () => {
  it("registers the CLI machine's hostname over SSH and keeps it out of credential and auth output", async () => {
    const remote = await rig(); const box = sandbox();
    const name = "remote-agent.example.test";
    const run = await loginWithHostname(box, remote.origin, name).result;
    expect(run.status, run.stderr).toBe(0);
    expect(remote.requests.find(request => request.path.endsWith("start"))?.body).toEqual({ deviceName: name });
    const login = savedLogin(box, remote.origin);
    const devices = await manageRequest(remote.origin, { operation: "list-devices" }, login);
    expect(devices.body).toMatchObject({ status: "ok", devices: [{ deviceId: login.credential.record.deviceId, deviceName: name, current: true }] });
    expect(JSON.stringify(login)).not.toContain(name);
    expect(run.output).not.toContain(name);
  });

  it.each([
    ["unavailable", undefined, false], ["throws", undefined, true], ["empty", "", false],
    ["control", "agent\nserver", false], ["format", "agent\u202eserver", false],
    ["oversized", "a".repeat(254), false],
  ] as const)("completes sign-in unnamed when the hostname is %s", async (_label, name, throws) => {
    const remote = await rig(); const box = sandbox();
    const run = await loginWithHostname(box, remote.origin, name, throws).result;
    expect(run.status, run.stderr).toBe(0);
    expect(remote.requests.find(request => request.path.endsWith("start"))?.body).toEqual({});
    const devices = await manageRequest(remote.origin, { operation: "list-devices" }, savedLogin(box, remote.origin));
    expect(devices.status).toBe(200);
    expect(devices.body).toMatchObject({ status: "ok", devices: [expect.not.objectContaining({ deviceName: expect.anything() })] });
  });

  it("retries a pre-name hub once with an empty body and stores the delivered credential", async () => {
    const remote = await olderHub(); const box = sandbox();
    const run = await loginWithHostname(box, remote.origin, "agent-server").result;
    expect(run.status, run.stderr).toBe(0);
    expect(remote.starts).toEqual([{ deviceName: "agent-server" }, {}]);
    expect(savedLogin(box, remote.origin)).toEqual(remote.login);
    expect(remote.cancellations).toEqual([]);
  });

  it("does not keep retrying after the unnamed start is refused", async () => {
    const remote = await olderHub(undefined, true); const box = sandbox();
    const run = await loginWithHostname(box, remote.origin, "agent-server").result;
    expect(run.status).toBe(1);
    expect(remote.starts).toEqual([{ deviceName: "agent-server" }, {}]);
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it.each([
    [200, { status: "invalid-request" }], [500, { status: "invalid-request" }],
    [502, { status: "failed" }], [400, { status: "invalid-request", unexpected: true }],
    [400, { status: "invalid-request", requestId: REQUEST_ID, collectionSecret: started.collectionSecret }],
  ])("does not retry another failure or malformed refusal (%s, %j)", async (status, result) => {
    const remote = await olderHub({ status, result }); const box = sandbox();
    const run = await loginWithHostname(box, remote.origin, "agent-server").result;
    expect(run.status).toBe(1);
    expect(remote.starts).toEqual([{ deviceName: "agent-server" }]);
    expect(existsSync(credentialPath(box))).toBe(false);
    expect(remote.cancellations).toEqual("requestId" in result
      ? [{ requestId: REQUEST_ID, collectionSecret: started.collectionSecret }] : []);
  });

  it("does not start a fallback attempt after interruption while the named refusal is pending", async () => {
    let entered = false; let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const remote = await olderHub(undefined, false, async () => { entered = true; await held; });
    const box = sandbox(); const run = loginWithHostname(box, remote.origin, "agent-server");
    try {
      await waitUntil("named sign-in request reached the hub", () => entered, 5_000);
      run.child.kill("SIGINT");
      await sleep(50);
      release();
      const result = await run.result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHub sign-in interrupted");
      expect(remote.starts).toEqual([{ deviceName: "agent-server" }]);
      expect(existsSync(credentialPath(box))).toBe(false);
    } finally { release(); await run.result; }
  });
});

/** Login checks the existing credential-free version reply before starting sign-in. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { protocolSkew, SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assertPublicOnly, cleanUp, credentialPath, fixture, privateDeviceRows, rig, savedLogin, serve,
} from "./auth-fixtures.js";
import { removeTempDirs, sandbox, UB_BIN, waitUntil, type Run } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

describe("CLI sign-in checks sync protocol compatibility", () => {
  it.each([SYNC_PROTOCOL_VERSION - 1, SYNC_PROTOCOL_VERSION + 1])(
    "refuses protocol %s without starting an attempt, writing a login or claiming the hub",
    async (hubVersion) => {
      const remote = await rig([], true, true, false, hubVersion);
      const claimState = async () => (await fetch(`http://127.0.0.1:${remote.hub.port}/auth/claim-state`)).json();
      const claimBefore = await claimState();
      const rowsBefore = privateDeviceRows(remote.databasePath);
      const logsBefore = [...remote.logs];
      for (const stored of [false, true]) {
        const box = sandbox(stored ? { credentials: { hubLogins: { [remote.origin]: fixture() } } } : {});
        const before = stored ? readFileSync(credentialPath(box)) : undefined;
        const run = await runInProcess(["auth", "login", remote.origin], box);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(protocolSkew(hubVersion, SYNC_PROTOCOL_VERSION));
        expect(run.stdout).not.toMatch(/^open|^code|waiting for approval|approve only/m);
        expect(run.output).not.toContain("ABCD-EFGH");
        if (before === undefined) expect(existsSync(credentialPath(box))).toBe(false);
        else expect(readFileSync(credentialPath(box))).toEqual(before);
        assertPublicOnly(run, remote);
      }
      expect(remote.requests).toEqual(Array.from({ length: 2 }, () => ({
        path: "/auth/credential/renew", method: "POST", authorization: undefined,
        body: { protocolVersion: SYNC_PROTOCOL_VERSION, token: "" },
      })));
      expect(remote.github.calls).toEqual([]);
      expect(privateDeviceRows(remote.databasePath)).toEqual(rowsBefore);
      expect(remote.logs).toEqual(logsBefore);
      expect(await claimState()).toEqual(claimBefore);
      expect(claimBefore).toEqual({ unclaimed: true, canClaim: true });
    },
  );

  it("interrupts a held version reply before starting sign-in or creating a store", async () => {
    const routes: string[] = [];
    let probeHeld = false;
    const remote = await serve((request, response) => {
      routes.push(request.url ?? "");
      if (request.url === "/auth/credential/renew") {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.write('{"status":"protocol-mismatch","reason":"');
        probeHeld = true;
      } else {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "not-configured" }));
      }
    });
    const box = sandbox();
    const child = spawn(process.execPath, [UB_BIN, "auth", "login", remote.origin], {
      cwd: box.cwd, env: box.env, timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<Run>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
    });
    try {
      await waitUntil("version reply body is held", () => probeHeld, 5_000);
      child.kill("SIGINT");
      const run = await done;
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("GitHub sign-in interrupted");
      expect(run.stdout).not.toMatch(/^open|^code|waiting for approval|approve only/m);
      expect(existsSync(credentialPath(box))).toBe(false);
      expect(routes).toEqual(["/auth/credential/renew"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  });

  it.each([
    { name: "a mismatch body with HTTP 200", code: 200, result: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` } },
    { name: "a malformed mismatch reason", code: 409, result: { status: "protocol-mismatch", reason: `protocol-mismatch:0${SYNC_PROTOCOL_VERSION + 1}` } },
    { name: "a refusal naming this client's own version", code: 409, result: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION}` } },
    { name: "a missing renewal route", code: 404, result: { status: "not-found" } },
  ])("continues ordinary sign-in after $name", async ({ code, result: probeResult }) => {
    const remote = await rig();
    remote.controls.transform = (path, status, result) => path === "/auth/credential/renew"
      ? { status: code, result: probeResult } : { status, result };
    const box = sandbox();
    const run = await runInProcess(["auth", "login", remote.origin], box);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("code       ABCD-EFGH");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
    expect(remote.requests.find(request => request.path === "/auth/github/start")).toBeDefined();
    assertPublicOnly(run, remote);
  });
});

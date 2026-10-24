import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { cliVersion } from "../src/version.js";
import { cleanUp, credentialPath, fixture, rig, seedLogin, WORKSPACE } from "./auth-fixtures.js";
import { removeTempDirs, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanUp(); });
afterAll(removeTempDirs);

it.each([cliVersion(), "0.4.5", undefined])("reports recent devices and hub version %s without consuming them, writing the login or adding requests", async hubVersion => {
  const remote = await rig([WORKSPACE], true, false, true, undefined, hubVersion);
  // Use the real hub for both sync and device management.
  const origin = `http://127.0.0.1:${remote.hub.port}`;
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: origin.replace("http:", "ws:") } });
  const clientVersion = (await runInProcess(["--version"], box)).stdout.trim();
  const login = await seedLogin(remote, box);
  await writeHubLogin(origin, login, box.env);
  const otherId = randomUUID();
  const issued = issueCredential(remote.hub.credentials!, { principalId: login.identity.id, deviceId: otherId,
    deviceName: "Same name as my laptop", workspaces: [WORKSPACE] });
  const stranger = remote.hub.principals!.identify("98765", "another-person");
  issueCredential(remote.hub.credentials!, { principalId: stranger.id, deviceId: randomUUID(), deviceName: "other account", workspaces: [] });
  const before = readFileSync(credentialPath(box));
  const requests: string[] = [];
  remote.hub.server.httpServer.on("request", request => { requests.push(request.url ?? ""); });

  const json = await runInProcess(["status", "--json"], box);
  expect(json.status, json.stderr).toBe(0);
  const report = JSON.parse(json.stdout);
  expect(report.recentDevices).toEqual([{ id: otherId, name: "Same name as my laptop", signedInAt: new Date(issued.record.issuedAt).toISOString() }]);
  expect(report.connection.state).toBe("connected");
  expect(report.version).toEqual({ client: clientVersion, hub: hubVersion ?? null });
  expect(report.problems).toEqual([]);
  expect(json.stderr).toBe("");
  expect(requests).toEqual(["/auth/manage"]);
  requests.length = 0;
  const text = await runInProcess(["status"], box);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(`new device  Same name as my laptop (${otherId.slice(0, 8)}), signed in `);
  expect(text.stdout).toContain("user menu → Devices");
  expect(text.stdout).toContain(`ub auth logout --all-devices ${origin}`);
  expect(text.stdout).toContain("problems    none\n");
  expect(text.stdout).toContain(`hub         ${origin}\nversion     client ${clientVersion}, hub ${hubVersion ?? "unknown"}\n`);
  expect(requests).toEqual(["/auth/manage"]);
  expect(text.stdout).not.toContain(login.credential.record.deviceId.slice(0, 8));
  expect(text.stdout).not.toContain("other account");
  expect(JSON.parse((await runInProcess(["status", "--json"], box)).stdout).recentDevices).toEqual(report.recentDevices);
  expect(readFileSync(credentialPath(box)).equals(before)).toBe(true);

  remote.hub.credentials!.revokeDevice(login.identity.id, otherId);
  const empty = await runInProcess(["status", "--json"], box);
  expect(JSON.parse(empty.stdout).recentDevices).toEqual([]);
  expect((await runInProcess(["status"], box)).stdout).not.toContain("new device");
});

it("withholds the hub version when workspace access is refused even though account device management succeeds", async () => {
  const remote = await rig([], true, false, true, undefined, "0.4.5");
  const origin = `http://127.0.0.1:${remote.hub.port}`;
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: origin.replace("http:", "ws:") } });
  const login = await seedLogin(remote, box);
  await writeHubLogin(origin, login, box.env);
  const otherId = randomUUID();
  const issued = issueCredential(remote.hub.credentials!, { principalId: login.identity.id, deviceId: otherId,
    deviceName: "Other computer", workspaces: [] });
  const before = readFileSync(credentialPath(box));
  const requests: string[] = [];
  remote.hub.server.httpServer.on("request", request => { requests.push(request.url ?? ""); });

  const json = await runInProcess(["status", "--json"], box);
  expect(json.status, json.stderr).toBe(0);
  const report = JSON.parse(json.stdout);
  expect(report.connection.state).toBe("refused");
  expect(report.version).toEqual({ client: cliVersion(), hub: null });
  expect(report.recentDevices).toEqual([{ id: otherId, name: "Other computer", signedInAt: new Date(issued.record.issuedAt).toISOString() }]);
  expect(report.problems).toEqual([{ name: "no-workspace-access", fix: "ask a workspace admin to run: ub workspace member add auth-test-user" }]);
  expect(requests.sort()).toEqual(["/auth/credential/renew", "/auth/manage"]);
  requests.length = 0;
  const text = await runInProcess(["status"], box);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(`hub         ${origin}\nversion     client ${cliVersion()}, hub unknown\n`);
  expect(text.stdout).toContain("problems    no workspace access\n");
  expect(text.stdout).toContain("new device  Other computer");
  expect(requests).toEqual(["/auth/manage"]);
  expect(remote.github.calls).toEqual([]);
  expect(readFileSync(credentialPath(box)).equals(before)).toBe(true);
});

it.each(["headers", "body"])("keeps an unavailable device list silent and within the status deadline (%s)", async phase => {
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout;
  const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 100 ? deadline.signal : timeout(ms));
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  let requestSignal: AbortSignal | undefined;
  let bodyAborted = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const signal = options?.signal;
    if (signal == null) throw new Error("device request needs an abort signal");
    requestSignal = signal;
    if (phase === "headers") return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      signal.throwIfAborted();
      reached();
    });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"ok",'));
        signal.addEventListener("abort", () => {
          bodyAborted = true;
          controller.error(signal.reason);
        }, { once: true });
        signal.throwIfAborted();
      },
      pull() { reached(); },
    }, { highWaterMark: 0 }));
  });
  const origin = "http://127.0.0.1:1";
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: origin.replace("http:", "ws:") },
    credentials: { hubLogins: { [origin]: fixture() } } });
  const before = readFileSync(credentialPath(box));
  const started = performance.now();
  const running = runInProcess(["status", "--json"], box, { UB_TEST_MAX_WAIT_MS: "100.5" });
  await waiting;
  deadline.abort();
  const json = await running;
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(deadlines).toHaveBeenCalledWith(100);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/auth/manage`);
  expect(requestSignal?.aborted).toBe(true);
  if (phase === "body") expect(bodyAborted).toBe(true);
  expect(json.status, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).recentDevices).toBeNull();
  expect(JSON.parse(json.stdout).problems.map((problem: { name: string }) => problem.name)).toEqual(["hub-unreachable"]);
  expect(json.stderr).toBe("");
  expect(readFileSync(credentialPath(box)).equals(before)).toBe(true);
});

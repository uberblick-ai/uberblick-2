import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { afterAll, afterEach, expect, it } from "vitest";
import { cleanUp, credentialPath, fixture, rig, seedLogin, serve, WORKSPACE } from "./auth-fixtures.js";
import { removeTempDirs, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

it("reports recent devices in text and JSON repeatedly without consuming them or writing the login", async () => {
  const remote = await rig([WORKSPACE], true, false, true);
  // Use the real hub for both sync and device management.
  const origin = `http://127.0.0.1:${remote.hub.port}`;
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: origin.replace("http:", "ws:") } });
  const login = await seedLogin(remote, box);
  await writeHubLogin(origin, login, box.env);
  const otherId = randomUUID();
  const issued = issueCredential(remote.hub.credentials!, { principalId: login.identity.id, deviceId: otherId,
    deviceName: "Same name as my laptop", workspaces: [WORKSPACE] });
  const stranger = remote.hub.principals!.identify("98765", "another-person");
  issueCredential(remote.hub.credentials!, { principalId: stranger.id, deviceId: randomUUID(), deviceName: "other account", workspaces: [] });
  const before = readFileSync(credentialPath(box));

  const json = await runInProcess(["status", "--json"], box);
  expect(json.status, json.stderr).toBe(0);
  const report = JSON.parse(json.stdout);
  expect(report.recentDevices).toEqual([{ id: otherId, name: "Same name as my laptop", signedInAt: new Date(issued.record.issuedAt).toISOString() }]);
  expect(report.connection.state).toBe("connected");
  expect(report.problems).toEqual([]);
  expect(json.stderr).toBe("");
  const text = await runInProcess(["status"], box);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain(`new device  Same name as my laptop (${otherId.slice(0, 8)}), signed in `);
  expect(text.stdout).toContain("Settings → User → Devices");
  expect(text.stdout).toContain(`ub auth logout --all-devices ${origin}`);
  expect(text.stdout).toContain("problems    none\n");
  expect(text.stdout).not.toContain(login.credential.record.deviceId.slice(0, 8));
  expect(text.stdout).not.toContain("other account");
  expect(JSON.parse((await runInProcess(["status", "--json"], box)).stdout).recentDevices).toEqual(report.recentDevices);
  expect(readFileSync(credentialPath(box)).equals(before)).toBe(true);

  remote.hub.credentials!.revokeDevice(login.identity.id, otherId);
  const empty = await runInProcess(["status", "--json"], box);
  expect(JSON.parse(empty.stdout).recentDevices).toEqual([]);
  expect((await runInProcess(["status"], box)).stdout).not.toContain("new device");
});

it.each(["headers", "body"])("keeps an unavailable device list silent and within the status deadline (%s)", async phase => {
  let requests = 0;
  const server = await serve((request, response) => {
    if (request.url !== "/auth/manage") { response.writeHead(404); response.end(); return; }
    requests += 1;
    if (phase === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"status":"ok",'); }
  });
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: server.origin.replace("http:", "ws:") },
    credentials: { hubLogins: { [server.origin]: fixture() } } });
  const before = readFileSync(credentialPath(box));
  const started = performance.now();
  const json = await runInProcess(["status", "--json"], box, { UB_TEST_MAX_WAIT_MS: "100.5" });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(requests).toBe(1);
  expect(json.status, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).recentDevices).toBeNull();
  expect(JSON.parse(json.stdout).problems.map((problem: { name: string }) => problem.name)).toEqual(["hub-unreachable"]);
  expect(json.stderr).toBe("");
  expect(readFileSync(credentialPath(box)).equals(before)).toBe(true);
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHubConfig, resolveRemoteHubConfig, SHARED_GITHUB_CLIENT_ID } from "../src/config.js";
import { CredentialRegistry } from "../src/credentials.js";
import type { SignInCollection } from "../src/github-sign-in.js";
import type { HubLogRecord } from "../src/log.js";
import { HubDatabase } from "../src/persistence.js";
import type { Hub } from "../src/server.js";
import { importCredentialKey, mintToken } from "../src/token.js";
import { removeTempDatabases, startHub, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const CLIENT_ID = "Iv23AbCdEF0123456789";
const GITHUB_TOKEN = "ghu_never-store-or-disclose";
const REFRESH_TOKEN = "ghr_never-store-or-disclose";
const DEVICE_CODE = "private-github-device-code";
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

class GithubFake {
  time = 1000;
  account = { id: 1234, login: "first-name", email: "ignore@example.com", organizations: ["ignored"] };
  tokenResult: Record<string, unknown> = { access_token: GITHUB_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "bearer", scope: "" };
  calls: { url: string; body: URLSearchParams; headers: Headers }[] = [];
  pauseIdentity: (() => Promise<void>) | undefined;
  failedUrl: string | undefined;
  failedResponse: { url: string; status: number; body: Record<string, unknown> } | undefined;
  lifetime = 900;
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    const headers = new Headers(init?.headers);
    this.calls.push({ url, body, headers });
    if (this.failedUrl === url) throw new Error(`${GITHUB_TOKEN} ${TEST_SECRET}`);
    if (this.failedResponse?.url === url) {
      return Response.json(this.failedResponse.body, { status: this.failedResponse.status });
    }
    if (url === "https://github.com/login/device/code") {
      return Response.json({ device_code: DEVICE_CODE, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: this.lifetime, interval: 5 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      expect(body.get("device_code")).toBe(DEVICE_CODE);
      return Response.json(this.tokenResult);
    }
    expect(url).toBe("https://api.github.com/user");
    expect(headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
    await this.pauseIdentity?.();
    return Response.json(this.account);
  };
}

async function rig(databasePath = tempDatabasePath()) {
  const github = new GithubFake();
  const logs: HubLogRecord[] = [];
  const hub = await startHub({ databasePath, github: { clientId: CLIENT_ID, fetch: github.fetch, now: () => github.time }, log: (line) => logs.push(line) });
  hubs.push(hub);
  return { hub, github, logs, databasePath };
}

async function post(hub: Hub, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${hub.port}/auth/github/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

async function start(hub: Hub, body: unknown = {}) {
  const { code, result } = await post(hub, "start", body);
  expect(code).toBe(200);
  expect(result).toMatchObject({ status: "pending", verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", interval: 5 });
  expect(result).not.toHaveProperty("deviceName");
  return { requestId: result.requestId as string, collectionSecret: result.collectionSecret as string };
}

type Complete = Extract<SignInCollection, { status: "complete" }>;
async function complete(testRig: Awaited<ReturnType<typeof rig>>, body: unknown = {}) {
  const request = await start(testRig.hub, body);
  testRig.github.time += 5000;
  const { code, result } = await post(testRig.hub, "collect", request);
  expect(code).toBe(200);
  expect(result.status).toBe("complete");
  return { request, result: result as unknown as Complete };
}

function privateRows(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      principals: database.prepare("SELECT * FROM hub_principals").all(),
      credentials: database.prepare("SELECT id, principal_id, device_id, workspaces, issued_at, revoked_at FROM hub_credentials").all(),
      memberships: database.prepare("SELECT * FROM hub_memberships").all(),
      tables: database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    };
  } finally { database.close(); }
}

describe("hub-driven GitHub identity", () => {
  it("keeps each CLI hostname on its device without copying it to GitHub or credential replies", async () => {
    const testRig = await rig();
    const laptop = await start(testRig.hub, { deviceName: "laptop" });
    const server = await start(testRig.hub, { deviceName: "agent-server" });
    testRig.github.time += 5000;
    const laptopResult = (await post(testRig.hub, "collect", laptop)).result as unknown as Complete;
    const serverResult = (await post(testRig.hub, "collect", server)).result as unknown as Complete;
    expect(laptopResult.status).toBe("complete");
    expect(serverResult.status).toBe("complete");
    expect(laptopResult.credential.record).not.toHaveProperty("deviceName");
    expect(serverResult.credential.record).not.toHaveProperty("deviceName");
    expect(laptopResult.credential.record.deviceId).not.toBe(serverResult.credential.record.deviceId);
    expect(testRig.hub.credentials!.listDevices(laptopResult.identity.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: laptopResult.credential.record.deviceId, deviceName: "laptop" }),
      expect.objectContaining({ deviceId: serverResult.credential.record.deviceId, deviceName: "agent-server" }),
    ]));
    expect(JSON.stringify({ laptopResult, serverResult, logs: testRig.logs })).not.toContain("agent-server");
    expect(testRig.github.calls.every((call) => !call.body.has("deviceName"))).toBe(true);
  });

  it.each([undefined, null, 42, {}, [], "", "line\nbreak", "format\u200dcharacter", "a".repeat(254)])(
    "completes legacy or invalid-name sign-in with an unnamed device", async (deviceName) => {
      const testRig = await rig();
      const signedIn = await complete(testRig, deviceName === undefined ? {} : { deviceName });
      expect(signedIn.result.credential.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(testRig.hub.credentials!.listDevices(signedIn.result.identity.id)).toEqual([
        { deviceId: signedIn.result.credential.record.deviceId,
          signedInAt: signedIn.result.credential.record.issuedAt, workspaces: [] },
      ]);
    },
  );

  it("discovers a direct grant on first sign-in and retains it across login renames and reassignment", async () => {
    const first = await rig();
    const admin = first.hub.principals!.identify("9999", "workspace-admin");
    first.hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: admin.id, role: "admin" });
    // This identity models the hub's own GitHub lookup for a never-signed-in
    // account. Discovery must preserve the principal created for the grant.
    const granted = first.hub.principals!.identify("1234", "first-name");
    first.hub.memberships!.grantMember({
      workspaceId: WORKSPACE, actorPrincipalId: admin.id, principalId: granted.id, role: "member",
    });
    expect(privateRows(first.databasePath).credentials).toEqual([]);

    const signedIn = await complete(first);
    expect(signedIn.result.identity).toEqual(granted);
    expect(signedIn.result.credential.record.workspaces).toEqual([WORKSPACE]);
    await first.hub.stop();

    const restarted = await rig(first.databasePath);
    restarted.github.account.login = "renamed-member";
    const renamed = await complete(restarted);
    expect(renamed.result.identity).toEqual({ ...granted, githubUsername: "renamed-member" });
    expect(restarted.hub.principals!.get(granted.id)).toEqual(renamed.result.identity);
    expect(renamed.result.credential.record.workspaces).toEqual([WORKSPACE]);
    expect(restarted.hub.memberships!.roleFor(WORKSPACE, granted.id)).toBe("member");

    restarted.github.account = { ...restarted.github.account, id: 5678, login: "first-name" };
    const reassigned = await complete(restarted);
    expect(reassigned.result.identity.id).not.toBe(granted.id);
    expect(reassigned.result.credential.record.workspaces).toEqual([]);
    expect(restarted.hub.memberships!.roleFor(WORKSPACE, reassigned.result.identity.id)).toBeNull();
  });

  it("binds durable account ID across devices, renames, username reassignment and restart", async () => {
    const first = await rig();
    first.github.account.login = "first_acme";
    const a = await complete(first);
    first.github.account.login = "new_acme";
    const b = await complete(first);
    expect(b.result.identity).toEqual({ ...a.result.identity, githubUsername: "new_acme" });
    expect(b.result.credential.record.deviceId).not.toBe(a.result.credential.record.deviceId);
    expect(b.result.credential.record.id).not.toBe(a.result.credential.record.id);
    expect(b.result.credential.key).not.toBe(a.result.credential.key);
    await first.hub.stop();
    const restarted = await rig(first.databasePath);
    restarted.github.account.login = "new_acme";
    const again = await complete(restarted);
    expect(again.result.identity).toEqual(b.result.identity);
    restarted.github.account.id = 5678;
    restarted.github.account.login = "first_acme";
    const other = await complete(restarted);
    expect(other.result.identity.githubUsername).toBe(a.result.identity.githubUsername);
    expect(other.result.identity.id).not.toBe(a.result.identity.id);
    expect(privateRows(first.databasePath).principals).toHaveLength(2);
    expect(again.result.credential.record.workspaces).toEqual([]);
    expect(privateRows(first.databasePath).memberships).toEqual([]);

    // Existing private key storage, not an extra sign-in store, keeps a
    // collected credential verifiable across hub restarts.
    await restarted.hub.stop();
    const db = new HubDatabase(first.databasePath, () => {});
    db.open();
    try {
      const signed = await mintToken(await importCredentialKey(Buffer.from(a.result.credential.key, "base64url")), {
        typ: "room", sub: a.result.identity.id, workspace: WORKSPACE, scope: "read-write", kid: a.result.credential.record.id, lifetimeSeconds: 60,
      });
      expect(await new CredentialRegistry(db).verify(signed)).toMatchObject({ record: a.result.credential.record });
    } finally { db.close(); }
  });

  it("requests only public identity and discloses key material in one collection only", async () => {
    const testRig = await rig();
    const { request, result } = await complete(testRig);
    expect(result.credential.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "collected" } });
    expect(await post(testRig.hub, "cancel", request)).toMatchObject({ result: { status: "collected" } });
    expect(testRig.github.calls.map((call) => call.url)).toEqual([
      "https://github.com/login/device/code", "https://github.com/login/oauth/access_token", "https://api.github.com/user",
    ]);
    expect([...testRig.github.calls[0]!.body]).toEqual([["client_id", CLIENT_ID]]);
    expect([...testRig.github.calls[1]!.body.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
    const persisted = JSON.stringify(privateRows(testRig.databasePath));
    const disclosed = JSON.stringify({ result, logs: testRig.logs });
    for (const secret of [GITHUB_TOKEN, REFRESH_TOKEN, DEVICE_CODE, TEST_SECRET]) {
      expect(persisted).not.toContain(secret);
      expect(disclosed).not.toContain(secret);
    }
    expect(persisted).not.toContain(result.credential.key);
    expect(JSON.stringify(testRig.logs)).not.toContain(result.credential.key);
    expect(privateRows(testRig.databasePath).tables.map((row) => row.name)).not.toContain("hub_sign_ins");
  });

  it("refuses client tokens/identity and public approval codes cannot collect", async () => {
    const testRig = await rig();
    for (const input of [{ access_token: "gh_cli_token" }, { id: 1234 }, { username: "first-name" }]) {
      expect(await post(testRig.hub, "start", input)).toMatchObject({ code: 400, result: { status: "invalid-request" } });
    }
    expect(await post(testRig.hub, "start", {}, { Authorization: "Bearer gh_cli_token" })).toMatchObject({ code: 400 });
    expect(testRig.github.calls).toHaveLength(0);
    const request = await start(testRig.hub);
    for (const collectionSecret of ["ABCD-EFGH", "https://github.com/login/device", "é".repeat(43)]) {
      expect(await post(testRig.hub, "collect", { ...request, collectionSecret })).toMatchObject({ code: 404, result: { status: "unknown-request" } });
    }
    expect(await post(testRig.hub, "collect", { ...request, accountId: 1234 })).toMatchObject({ code: 400 });
    expect(await post(testRig.hub, "collect", { ...request, requestId: crypto.randomUUID() })).toMatchObject({ code: 404, result: { status: "unknown-request" } });
    expect(await post(testRig.hub, "collect?collectionSecret=ABCD-EFGH", request)).toMatchObject({ code: 404 });
    testRig.github.time += 5000;
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "complete" } });
  });
});

describe("bounded device requests", () => {
  it("obeys pending and slow_down intervals while early polling never contacts GitHub", async () => {
    const testRig = await rig();
    const request = await start(testRig.hub);
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "pending", interval: 5 } });
    expect(testRig.github.calls).toHaveLength(1);
    testRig.github.time += 5000;
    testRig.github.tokenResult = { error: "authorization_pending" };
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "pending", interval: 5 } });
    testRig.github.time += 5000;
    testRig.github.tokenResult = { error: "slow_down", interval: 12 };
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "pending", interval: 12 } });
    testRig.github.time += 11_000;
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "pending", interval: 1 } });
    expect(testRig.github.calls).toHaveLength(3);
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(0);
  });

  it.each(["denied", "expired"])("%s ends distinctly and issues nothing", async (status) => {
    const testRig = await rig();
    const request = await start(testRig.hub);
    testRig.github.time += 5000;
    if (status === "denied") testRig.github.tokenResult = { error: "access_denied" };
    if (status === "expired") testRig.github.time += 900_000;
    const first = await post(testRig.hub, "collect", request);
    expect(first).toMatchObject({ result: { status } });
    expect(await post(testRig.hub, "collect", request)).toEqual(first);
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(0);
    expect(JSON.stringify(testRig.logs)).not.toContain(GITHUB_TOKEN);
  });

  it.each(["cancel", "stop"])("%s during identity fetch fences issuance and concurrent collection", async (action) => {
    const testRig = await rig();
    const request = await start(testRig.hub);
    testRig.github.time += 5000;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    testRig.github.pauseIdentity = async () => { entered(); await resume; };
    const collecting = post(testRig.hub, "collect", request);
    // Stop may close the HTTP socket; own its rejection immediately.
    collecting.catch(() => {});
    await paused;
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "pending" } });
    if (action === "cancel") await post(testRig.hub, "cancel", request);
    if (action === "stop") await testRig.hub.stop();
    release();
    if (action === "stop") await collecting.catch(() => {});
    else expect(await collecting).toMatchObject({ result: { status: "abandoned" } });
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(0);
  });

  it("two concurrent collectors yield one credential and unknown requests after restart", async () => {
    const testRig = await rig();
    const request = await start(testRig.hub);
    testRig.github.time += 5000;
    const responses = await Promise.all([post(testRig.hub, "collect", request), post(testRig.hub, "collect", request)]);
    expect(responses.filter((response) => response.result.status === "complete")).toHaveLength(1);
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(1);
    const pending = await start(testRig.hub);
    await testRig.hub.stop();
    const restarted = await rig(testRig.databasePath);
    expect(await post(restarted.hub, "collect", pending)).toMatchObject({ code: 404, result: { status: "unknown-request" } });
  });

  it("bounds active attempts independently of retained outcomes and caps GitHub lifetimes", async () => {
    const testRig = await rig();
    testRig.github.lifetime = 86_400;
    const requests = await Promise.all(Array.from({ length: 105 }, () => post(testRig.hub, "start", {})));
    expect(requests.filter((response) => response.code === 200)).toHaveLength(100);
    expect(requests.filter((response) => response.code === 429)).toHaveLength(5);
    expect(requests[0]!.result.expiresIn).toBe(900);
    const accepted = requests.filter((response) => response.code === 200).map(({ result }) => ({
      requestId: result.requestId as string, collectionSecret: result.collectionSecret as string,
    }));
    testRig.github.time += 5000;
    expect(await post(testRig.hub, "collect", accepted[0])).toMatchObject({ result: { status: "complete" } });
    await start(testRig.hub);
    expect(await post(testRig.hub, "collect", accepted[0])).toMatchObject({ result: { status: "collected" } });
    expect(await post(testRig.hub, "start", {})).toMatchObject({ code: 429 });
    for (const request of accepted.slice(1)) await post(testRig.hub, "cancel", request);
    const next = await start(testRig.hub);
    expect(await post(testRig.hub, "cancel", next)).toMatchObject({ result: { status: "abandoned" } });
    await start(testRig.hub);
    expect(await post(testRig.hub, "collect", accepted[0])).toMatchObject({ code: 404, result: { status: "unknown-request" } });
    expect(await post(testRig.hub, "collect", next)).toMatchObject({ result: { status: "abandoned" } });
    testRig.github.time += 900_000;
    expect(await post(testRig.hub, "start", {})).toMatchObject({ code: 200 });
    expect(await post(testRig.hub, "collect", next)).toMatchObject({ result: { status: "abandoned" } });
    testRig.github.time += 900_000;
    await start(testRig.hub);
    expect(await post(testRig.hub, "collect", next)).toMatchObject({ code: 404 });
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(1);
  });

  it("GitHub start or identity failure fails that request without changing hub availability", async () => {
    const testRig = await rig();
    testRig.github.failedUrl = "https://github.com/login/device/code";
    expect(await post(testRig.hub, "start", {})).toMatchObject({ code: 502, result: { status: "failed" } });
    testRig.github.failedUrl = "https://api.github.com/user";
    const request = await start(testRig.hub);
    testRig.github.time += 5000;
    expect(await post(testRig.hub, "collect", request)).toMatchObject({ result: { status: "failed" } });
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(0);
    expect(testRig.logs.filter((line) => line.event === "hub.github.sign-in.failed")).toEqual([
      { event: "hub.github.sign-in.failed", step: "start", code: "request-failed" },
      { event: "hub.github.sign-in.failed", step: "identity", code: "request-failed" },
    ]);
    for (const secret of [GITHUB_TOKEN, REFRESH_TOKEN, DEVICE_CODE, TEST_SECRET]) {
      expect(JSON.stringify(testRig.logs)).not.toContain(secret);
    }
    testRig.github.failedUrl = undefined;
    expect((await complete(testRig)).result.status).toBe("complete");
  });

  it.each([
    { step: "start", url: "https://github.com/login/device/code", error: "device_flow_disabled", status: 200, code: "device_flow_disabled" },
    { step: "identity", url: "https://api.github.com/user", error: GITHUB_TOKEN, status: 503, code: "http-error" },
  ])("logs safe diagnostics for $step/$code and issues nothing", async ({ step, url, error, status, code }) => {
    const testRig = await rig();
    testRig.github.failedResponse = { url, status, body: { error, error_description: `${GITHUB_TOKEN} ${TEST_SECRET}` } };
    const request = step === "start" ? {} : await start(testRig.hub);
    testRig.github.time += 5000;
    const response = await post(testRig.hub, step === "start" ? "start" : "collect", request);
    expect(response.result).toEqual({ status: "failed" });
    expect(testRig.logs.filter((line) => line.event === "hub.github.sign-in.failed")).toEqual([
      { event: "hub.github.sign-in.failed", step, code, ...(status === 200 ? {} : { status }) },
    ]);
    expect(privateRows(testRig.databasePath).credentials).toHaveLength(0);
    for (const secret of [GITHUB_TOKEN, REFRESH_TOKEN, DEVICE_CODE, TEST_SECRET]) {
      expect(JSON.stringify({ response, logs: testRig.logs, rows: privateRows(testRig.databasePath) })).not.toContain(secret);
    }
  });
});

describe("optional GitHub configuration", () => {
  it("uses the shared app for remote deployments with an empty client ID", async () => {
    const github = new GithubFake();
    const config = resolveRemoteHubConfig({ HUB_AUTH_TOKEN: TEST_SECRET, HUB_GITHUB_CLIENT_ID: "" });
    expect(config.github).toEqual({ clientId: SHARED_GITHUB_CLIENT_ID });
    const hub = await startHub({ ...config, databasePath: tempDatabasePath(), port: 0,
      github: { ...config.github!, fetch: github.fetch, now: () => github.time } });
    hubs.push(hub);
    const request = await start(hub);
    expect([...github.calls[0]!.body]).toEqual([["client_id", SHARED_GITHUB_CLIENT_ID]]);
    expect(await post(hub, "cancel", request)).toMatchObject({ result: { status: "abandoned" } });
  });

  it("uses an operator app and returns to the default when the setting is removed", () => {
    const env = { HUB_AUTH_TOKEN: TEST_SECRET, HUB_GITHUB_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv;
    expect(resolveRemoteHubConfig(env).github).toEqual({ clientId: CLIENT_ID });
    delete env.HUB_GITHUB_CLIENT_ID;
    expect(resolveRemoteHubConfig(env).github).toEqual({ clientId: SHARED_GITHUB_CLIENT_ID });
  });

  it("does not configure GitHub by default and refuses every sign-in endpoint distinctly", async () => {
    const hub = await startHub();
    hubs.push(hub);
    for (const path of ["start", "collect", "cancel"]) {
      expect(await post(hub, path, {})).toMatchObject({ code: 503, result: { status: "not-configured" } });
    }
    expect(resolveHubConfig({ HUB_AUTH_TOKEN: "secret" }).github).toBeUndefined();
    expect(resolveHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_GITHUB_CLIENT_ID: "" }).github).toBeUndefined();
    expect(resolveHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_GITHUB_CLIENT_ID: CLIENT_ID }).github).toEqual({ clientId: CLIENT_ID });
    expect(resolveHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_GITHUB_CLIENT_ID: "Iv1.0123456789abcdef" }).github).toEqual({ clientId: "Iv1.0123456789abcdef" });
  });

  it("names invalid or missing client ID without echoing its value, before listening", async () => {
    for (const clientId of [" ", "OAuth-client", "Iv23.short", TEST_SECRET]) {
      await expect(startHub(resolveHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_GITHUB_CLIENT_ID: clientId }))).rejects.toThrow(/HUB_GITHUB_CLIENT_ID/);
      await expect(startHub(resolveRemoteHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_GITHUB_CLIENT_ID: clientId }))).rejects.toThrow(/HUB_GITHUB_CLIENT_ID/);
    }
    await expect(startHub({ github: {} as { clientId: string } })).rejects.toThrow(/HUB_GITHUB_CLIENT_ID/);
    try { await startHub({ github: { clientId: TEST_SECRET } }); }
    catch (error) { expect(String(error)).not.toContain(TEST_SECRET); }
  });
});

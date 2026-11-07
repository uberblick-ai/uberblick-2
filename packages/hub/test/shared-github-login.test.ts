import { credentialPrivateKey, deviceFetch as fetch } from "./device-credentials.js";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRemoteHubConfig, SHARED_GITHUB_CLIENT_ID } from "../src/team-config.js";
import { CredentialRegistry } from "../src/credentials.js";
import type { SignInCollection } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { HubDatabase } from "../src/persistence.js";
import { createTeamHub as createHub, type TeamHub as Hub } from "../src/team.js";
import { importCredentialKey, mintToken } from "@uberblick/schema/token";
import { removeTempDatabases, tempDatabasePath, WORKSPACE } from "./helpers.js";

const ACCOUNT = { id: 1234, login: "same-person" };
const hubs: Hub[] = [];
let originalDirectory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
});
afterEach(async () => {
  try {
    for (const hub of hubs.splice(0)) await hub.stop();
    removeTempDatabases();
  } finally { process.chdir(originalDirectory); }
});

class GithubFake {
  time = 1000;
  calls: { url: string; body: URLSearchParams; headers: Headers }[] = [];
  private deviceCodes = new Set<string>();

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    const headers = new Headers(init?.headers);
    this.calls.push({ url, body, headers });
    if (url === "https://github.com/login/device/code") {
      const deviceCode = `private-device-code-${this.deviceCodes.size}`;
      this.deviceCodes.add(deviceCode);
      return Response.json({ device_code: deviceCode, user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      const deviceCode = body.get("device_code")!;
      expect(this.deviceCodes.has(deviceCode)).toBe(true);
      return Response.json({ access_token: `private-user-token:${deviceCode}`, token_type: "bearer", scope: "" });
    }
    expect(url).toBe("https://api.github.com/user");
    const deviceCode = headers.get("authorization")?.slice("Bearer private-user-token:".length);
    expect(this.deviceCodes.has(deviceCode!)).toBe(true);
    return Response.json(ACCOUNT);
  };
}

async function rig(authSecret: string) {
  const github = new GithubFake();
  const databasePath = tempDatabasePath();
  const config = resolveRemoteHubConfig({ HUB_AUTH_TOKEN: authSecret, HUB_DB_PATH: databasePath, PORT: "0" });
  expect(config.github?.clientId).toBe(SHARED_GITHUB_CLIENT_ID);
  const hub = await createHub({ ...config, github: { ...config.github!, fetch: github.fetch, now: () => github.time },
    log: silentLogger }, { operatorSetup: true });
  hubs.push(hub);
  return { hub, github, databasePath };
}

type Rig = Awaited<ReturnType<typeof rig>>;
type Complete = Extract<SignInCollection, { status: "complete" }>;
type Approval = { requestId: string; collectionSecret: string };

async function post(hub: Hub, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${hub.port}/auth/github/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

async function start(testRig: Rig): Promise<Approval> {
  const response = await post(testRig.hub, "start", {});
  expect(response).toMatchObject({ code: 200, result: { status: "pending", userCode: "ABCD-EFGH" } });
  return { requestId: response.result.requestId as string, collectionSecret: response.result.collectionSecret as string };
}

async function complete(testRig: Rig, request: Approval): Promise<Complete> {
  testRig.github.time += 1000;
  const response = await post(testRig.hub, "collect", request);
  expect(response).toMatchObject({ code: 200, result: { status: "complete" } });
  return response.result as unknown as Complete;
}

async function firstAdmin(testRig: Rig) {
  const signedIn = await complete(testRig, await start(testRig));
  testRig.hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: signedIn.identity.id, role: "admin" });
  return signedIn.identity;
}

function privateRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { principals: db.prepare("SELECT * FROM hub_principals").all(),
      memberships: db.prepare("SELECT * FROM hub_memberships").all(),
      credentials: db.prepare("SELECT id, principal_id, workspaces FROM hub_credentials").all() };
  } finally { db.close(); }
}

function expectDirectGithub(github: GithubFake, flows: number) {
  expect(github.calls.filter((call) => call.url === "https://github.com/login/device/code")).toHaveLength(flows);
  expect(github.calls.filter((call) => call.url === "https://github.com/login/oauth/access_token")).toHaveLength(flows);
  expect(github.calls.filter((call) => call.url === "https://api.github.com/user")).toHaveLength(flows);
  for (const call of github.calls) {
    if (call.url === "https://github.com/login/device/code") {
      expect([...call.body]).toEqual([["client_id", SHARED_GITHUB_CLIENT_ID]]);
    } else if (call.url === "https://github.com/login/oauth/access_token") {
      expect(call.body.get("client_id")).toBe(SHARED_GITHUB_CLIENT_ID);
      expect([...call.body.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
    } else {
      expect(call.url).toBe("https://api.github.com/user");
      expect([...call.body]).toEqual([]);
    }
  }
}

describe("independent hubs sharing the public GitHub app", () => {
  it("keeps approvals, principals, admin grants, credentials and revocations hub-local", async () => {
    const a = await rig("independent-root-secret-a");
    const b = await rig("independent-root-secret-b");
    expect(a.hub.port).not.toBe(b.hub.port);
    const admin = await firstAdmin(a);
    expect(privateRows(b.databasePath)).toEqual({ principals: [], memberships: [], credentials: [] });

    const requestA = await start(a);
    const requestB = await start(b);
    for (const [target, own, other] of [[a, requestA, requestB], [b, requestB, requestA]] as const) {
      for (const request of [other, { ...own, collectionSecret: other.collectionSecret },
        { ...own, requestId: other.requestId }]) {
        expect(await post(target.hub, "collect", request)).toEqual({ code: 404, result: { status: "unknown-request" } });
        expect(await post(target.hub, "cancel", request)).toEqual({ code: 404, result: { status: "unknown-request" } });
      }
    }
    const loginA = await complete(a, requestA);
    const loginB = await complete(b, requestB);
    expect(loginA.identity).toEqual(admin);
    expect(loginA.identity.githubAccountId).toBe(String(ACCOUNT.id));
    expect(loginB.identity.githubAccountId).toBe(loginA.identity.githubAccountId);
    expect(loginB.identity.id).not.toBe(loginA.identity.id);
    expect(loginA.credential.record.workspaces).toEqual([WORKSPACE]);
    expect(loginB.credential.record.workspaces).toEqual([]);
    expect(loginB.credential.record.id).not.toBe(loginA.credential.record.id);
    expect(credentialPrivateKey(loginB.credential.record)).not.toEqual(credentialPrivateKey(loginA.credential.record));
    expect(privateRows(a.databasePath).memberships).toEqual([
      { workspace_id: WORKSPACE, principal_id: loginA.identity.id, role: "admin", added_on_host: 0 },
    ]);
    expect(privateRows(b.databasePath).memberships).toEqual([]);
    expectDirectGithub(a.github, 2);
    expectDirectGithub(b.github, 1);

    // Verification reads durable private registries, separate from unchanged
    // shared-root live admission. Stop hubs before opening their databases.
    await a.hub.stop();
    await b.hub.stop();
    const dbA = new HubDatabase(a.databasePath, () => {});
    const dbB = new HubDatabase(b.databasePath, () => {});
    dbA.open();
    dbB.open();
    try {
      const credentialsA = new CredentialRegistry(dbA);
      const credentialsB = new CredentialRegistry(dbB);
      const sign = async (login: Complete, key = credentialPrivateKey(login.credential.record)) => mintToken(
        await importCredentialKey(key), {
          typ: "room", sub: login.identity.id, workspace: WORKSPACE, scope: "read-write",
          kid: login.credential.record.id, lifetimeSeconds: 60,
        });
      const tokenA = await sign(loginA);
      const tokenB = await sign(loginB);
      expect(await credentialsA.verify(tokenA)).toMatchObject({ record: loginA.credential.record });
      expect(await credentialsB.verify(tokenB)).toMatchObject({ record: loginB.credential.record });
      expect(await credentialsB.verify(tokenA)).toEqual({ failure: "unknown-credential" });
      expect(await credentialsA.verify(tokenB)).toEqual({ failure: "unknown-credential" });
      expect(await credentialsB.verify(await sign(loginB, credentialPrivateKey(loginA.credential.record)))).toEqual({ failure: "bad-signature" });
      expect(credentialsA.revoke(loginA.credential.record.id)).toBe(true);
      expect(await credentialsA.verify(tokenA)).toEqual({ failure: "revoked-credential" });
      expect(await credentialsB.verify(tokenB)).toMatchObject({ record: loginB.credential.record });
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_SESSION_LIFETIME_MS } from "../src/browser-sessions.js";
import type { BrowserSignInCollection, SignInCollection } from "../src/github-sign-in.js";
import type { HubLogRecord } from "../src/log.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { createHub } from "../src/server.js";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { createClient, type TestClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom } from "./helpers.js";

const CLIENT_ID = "Iv1.0123456789abcdef";
const GITHUB_TOKEN = "github-private-access-token";
const hubs: { stop(): Promise<void> }[] = [];
const clients: TestClient[] = [];
type BrowserComplete = Extract<BrowserSignInCollection, { status: "complete" }>;
type CliComplete = Extract<SignInCollection, { status: "complete" }>;
type Attempt = { requestId: string; collectionSecret: string };

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

class GithubFake {
  time = 1000;
  account = { id: 1234, login: "browser-person" };
  starts = 0;
  pauseIdentity: ((accountId: number) => Promise<void>) | undefined;
  private readonly accounts = new Map<string, { id: number; login: string }>();
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/device/code") {
      const code = `private-device-code-${this.starts++}`;
      this.accounts.set(code, { ...this.account });
      return Response.json({ device_code: code, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(String(init?.body)).get("device_code");
      return Response.json({ access_token: `${GITHUB_TOKEN}:${code}`, token_type: "bearer", scope: "" });
    }
    expect(url).toBe("https://api.github.com/user");
    const token = new Headers(init?.headers).get("Authorization")!.slice(`Bearer ${GITHUB_TOKEN}:`.length);
    const account = this.accounts.get(token)!;
    await this.pauseIdentity?.(account.id);
    return Response.json(account);
  };
}

async function rig(path = tempDatabasePath(), port = 0, behindReleaseProxy = false) {
  const github = new GithubFake();
  const logs: HubLogRecord[] = [];
  const hub = await createTeamHub({ databasePath: path, address: "127.0.0.1", port, behindReleaseProxy,
    authSecret: TEST_SECRET, github: { clientId: CLIENT_ID, fetch: github.fetch, now: () => github.time },
    log: line => logs.push(line) }, { deviceCredentials: true, initializeDefaultWorkspace: true });
  hubs.push(hub);
  return { hub, github, logs, path };
}

function origin(hub: TeamHub): string { return `http://127.0.0.1:${hub.port}`; }

async function post(hub: TeamHub, route: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin(hub)}/auth/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", Origin: origin(hub), "Sec-Fetch-Site": "same-origin", ...headers },
    body: JSON.stringify(body) });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

async function start(hub: TeamHub, kind = "browser"): Promise<Attempt> {
  const response = await post(hub, `${kind}/start`);
  expect(response).toMatchObject({ code: 200, result: { status: "pending", verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH" } });
  return { requestId: response.result.requestId as string, collectionSecret: response.result.collectionSecret as string };
}

async function complete(testRig: Awaited<ReturnType<typeof rig>>): Promise<BrowserComplete> {
  const request = await start(testRig.hub);
  testRig.github.time += 1000;
  const response = await post(testRig.hub, "browser/collect", request);
  expect(response).toMatchObject({ code: 200, result: { status: "complete" } });
  return response.result as unknown as BrowserComplete;
}

function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}

function rows(path: string) {
  return inspect(path, db => Object.fromEntries(["hub_principals", "hub_memberships", "hub_admins", "hub_credentials", "hub_browser_sessions", "hub_claim_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])));
}

function sessionHeaders(token: string) { return { "X-Uberblick-Session": token }; }

describe("browser-only hub identity", () => {
  it("claims on loopback with one bounded session, no device key and no secret disclosure", async () => {
    const r = await rig();
    expect(await post(r.hub, "browser/session")).toEqual({ code: 401, result: { status: "signed-out" } });
    expect(r.github.starts).toBe(0);
    const result = await complete(r);
    expect(result.session).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), username: "browser-person", expiresAt: r.github.time + BROWSER_SESSION_LIFETIME_MS });
    expect(result.claimedWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(result).sort()).toEqual(["claimedWorkspaceId", "session", "status"]);
    const snapshot = rows(r.path);
    const principal = r.hub.principals!.getByGithubAccountId("1234")!;
    expect(snapshot.hub_credentials).toEqual([]);
    expect(r.hub.credentials!.listDevices(principal.id)).toEqual([]);
    expect(snapshot.hub_browser_sessions).toEqual([{ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), principal_id: principal.id,
      origin: origin(r.hub), expires_at: result.session.expiresAt }]);
    expect(snapshot.hub_admins).toEqual([{ principal_id: principal.id }]);
    expect(snapshot.hub_memberships).toEqual([{ workspace_id: result.claimedWorkspaceId, principal_id: principal.id, role: "admin" }]);
    expect(r.hub.hubAdmins!.pageAdmins(principal.id).admins[0]?.lastSignedInAt).toBeNull();
    for (const secret of [GITHUB_TOKEN, "private-device-code", TEST_SECRET]) {
      expect(JSON.stringify({ result, snapshot, logs: r.logs })).not.toContain(secret);
    }
    expect(JSON.stringify({ snapshot, logs: r.logs })).not.toContain(result.session.token);
    expect(await post(r.hub, "browser/session", {}, sessionHeaders(result.session.token))).toEqual({ code: 200,
      result: { status: "signed-in", username: "browser-person", expiresAt: result.session.expiresAt } });
  });

  it("later browser sign-ins add no roles and leave CLI device history unchanged", async () => {
    const r = await rig();
    const cli = await start(r.hub, "github");
    r.github.time += 1000;
    const signedCli = (await post(r.hub, "github/collect", cli)).result as unknown as CliComplete;
    const before = rows(r.path);
    const history = r.hub.hubAdmins!.pageAdmins(signedCli.identity.id);
    await complete(r);
    expect(r.hub.credentials!.listDevices(signedCli.identity.id)).toHaveLength(1);
    expect(r.hub.hubAdmins!.pageAdmins(signedCli.identity.id)).toEqual(history);
    r.github.account = { id: 5678, login: "nonmember" };
    const other = await complete(r);
    expect(other).not.toHaveProperty("claimedWorkspaceId");
    expect(other.session.username).toBe("nonmember");
    const after = rows(r.path);
    for (const table of ["hub_memberships", "hub_admins", "hub_credentials"]) expect(after[table]).toEqual(before[table]);
  });

  it("refuses browser sessions at room, management and device credential boundaries", async () => {
    const r = await rig();
    const signed = await complete(r);
    const client = createClient({ port: r.hub.port, room: testRoom(signed.claimedWorkspaceId!), token: signed.session.token, reconnectDelayMs: 60_000 });
    clients.push(client);
    await expect(client.denied).resolves.toBe("device-credential-refused");
    expect(r.hub.hocuspocus.documents.size).toBe(0);
    expect(await post(r.hub, "manage", { protocolVersion: SYNC_PROTOCOL_VERSION, operation: "own-hub-role", token: signed.session.token }))
      .toMatchObject({ code: 401, result: { status: "sign-in-required" } });
    expect(await post(r.hub, "credential/renew", { protocolVersion: SYNC_PROTOCOL_VERSION, token: signed.session.token }))
      .toMatchObject({ code: 401, result: { status: "sign-in-required" } });
  });
});

describe("browser request and flow isolation", () => {
  it("rejects other sites, forms, missing origins and credential headers before starting GitHub", async () => {
    const r = await rig();
    for (const headers of [{ Origin: "" }, { Origin: "null" }, { Origin: "https://other.example" },
      { Origin: "http://127.0.0.1:1" }, { Origin: `${origin(r.hub)}/` },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
      { Authorization: "Bearer anything" }, { "Content-Type": "text/plain" }]) {
      expect(await post(r.hub, "browser/start", {}, headers)).toMatchObject({ code: 400, result: { status: "invalid-request" } });
    }
    for (const body of [{ deviceName: "computer" }, { origin: origin(r.hub) }, null, [], "text"]) {
      expect(await post(r.hub, "browser/start", body)).toMatchObject({ code: 400 });
    }
    const preflight = await fetch(`${origin(r.hub)}/auth/browser/sign-out`, { method: "OPTIONS",
      headers: { Origin: "https://other.example", "Access-Control-Request-Headers": "X-Uberblick-Session" } });
    expect(preflight.status).toBe(400);
    expect(preflight.headers.has("access-control-allow-origin")).toBe(false);
    expect(r.github.starts).toBe(0);
  });

  it("fixes kind and origin at start so collectors and cancellers cannot change the result", async () => {
    const r = await rig();
    const browser = await start(r.hub);
    const cli = await start(r.hub, "github");
    r.github.time += 1000;
    for (const operation of ["collect", "cancel"]) {
      expect(await post(r.hub, `github/${operation}`, browser)).toMatchObject({ code: 404, result: { status: "unknown-request" } });
      expect(await post(r.hub, `browser/${operation}`, cli)).toMatchObject({ code: 404 });
      expect(await post(r.hub, `browser/${operation}`, browser, { Origin: `https://127.0.0.1:${r.hub.port}` })).toMatchObject({ code: 404 });
    }
    const signed = (await post(r.hub, "browser/collect", browser)).result as unknown as BrowserComplete;
    expect(signed.status).toBe("complete");
    expect(await post(r.hub, "browser/collect", browser)).toMatchObject({ result: { status: "collected" } });
    expect(await post(r.hub, "browser/session", {}, { ...sessionHeaders(signed.session.token), Origin: `https://127.0.0.1:${r.hub.port}` })).toMatchObject({ code: 401 });
    expect(await post(r.hub, "browser/sign-out", {}, { ...sessionHeaders(signed.session.token), Origin: "https://other.example" })).toMatchObject({ code: 400 });
    const cliResult = await post(r.hub, "github/collect", cli);
    expect(cliResult).toMatchObject({ result: { status: "complete", credential: { record: { id: expect.any(String) } } } });
    expect(cliResult.result.credential).not.toHaveProperty("key");
    expect(await post(r.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 200 });
    expect(rows(r.path).hub_browser_sessions).toHaveLength(1);
    expect(rows(r.path).hub_credentials).toHaveLength(1);
  });

  it.each(["github", "browser"])("keeps the other pool available when the %s pool fills", async (kind) => {
    const r = await rig(tempDatabasePath(), 0, true);
    for (let index = 0; index < 100; index++) {
      expect(await post(r.hub, `${kind}/start`, {}, { "X-Forwarded-For": `192.0.2.${index + 1}` })).toMatchObject({ code: 200 });
    }
    expect(await post(r.hub, `${kind}/start`)).toEqual({ code: 429, result: { status: "busy" } });
    expect(await post(r.hub, `${kind === "github" ? "browser" : "github"}/start`)).toMatchObject({ code: 200 });
    expect(r.github.starts).toBe(101);
  });

  it("bounds browser starts while session, sign-out, collection and cancellation remain available", async () => {
    const r = await rig();
    const signed = await complete(r);
    const pending = [];
    for (let index = 0; index < 6; index++) pending.push(await start(r.hub));
    expect(await post(r.hub, "browser/start")).toEqual({ code: 429, result: { status: "busy" } });
    expect(r.github.starts).toBe(7);
    expect(await post(r.hub, "browser/collect", pending[0])).toMatchObject({ code: 200, result: { status: "pending" } });
    expect(await post(r.hub, "browser/cancel", pending[0])).toMatchObject({ code: 200, result: { status: "abandoned" } });
    expect(await post(r.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 200 });
    expect(await post(r.hub, "browser/sign-out", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 200 });
  });
});

describe("browser session durability and claim atomicity", () => {
  it("keeps sessions across restart, enforces exact expiry and cleans expired rows on another sign-in", async () => {
    const first = await rig();
    const signed = await complete(first);
    const port = first.hub.port;
    await first.hub.stop();
    const restarted = await rig(first.path, port);
    restarted.github.time = signed.session.expiresAt - 1;
    expect(await post(restarted.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 200 });
    restarted.github.time++;
    expect(await post(restarted.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toEqual({ code: 401, result: { status: "signed-out" } });
    const next = await complete(restarted);
    expect(next).not.toHaveProperty("claimedWorkspaceId");
    expect(rows(first.path).hub_browser_sessions).toHaveLength(1);
    expect(await post(restarted.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 401 });
  });

  it("confirms durable sign-out only after successful revocation and rejects replay after restart", async () => {
    const r = await rig();
    const signed = await complete(r);
    inspect(r.path, db => db.exec(`CREATE TRIGGER revoke_failure BEFORE DELETE ON hub_browser_sessions
      BEGIN SELECT RAISE(ABORT, 'injected revocation failure'); END`));
    expect(await post(r.hub, "browser/sign-out", {}, sessionHeaders(signed.session.token))).toEqual({ code: 500, result: { status: "failed" } });
    expect(await post(r.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 200 });
    inspect(r.path, db => db.exec("DROP TRIGGER revoke_failure"));
    expect(await post(r.hub, "browser/sign-out", {}, sessionHeaders(signed.session.token))).toEqual({ code: 200, result: { status: "signed-out" } });
    expect(rows(r.path).hub_browser_sessions).toEqual([]);
    expect(await post(r.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 401 });
    const port = r.hub.port;
    await r.hub.stop();
    const restarted = await rig(r.path, port);
    expect(await post(restarted.hub, "browser/session", {}, sessionHeaders(signed.session.token))).toMatchObject({ code: 401 });
  });

  it("rolls back principal, grants and claim together when session insertion fails", async () => {
    const r = await rig();
    const before = rows(r.path);
    inspect(r.path, db => db.exec(`CREATE TRIGGER session_failure BEFORE INSERT ON hub_browser_sessions
      BEGIN SELECT RAISE(ABORT, 'injected issuance failure'); END`));
    const request = await start(r.hub);
    r.github.time += 1000;
    expect(await post(r.hub, "browser/collect", request)).toMatchObject({ result: { status: "failed" } });
    expect(rows(r.path)).toEqual(before);
    inspect(r.path, db => db.exec("DROP TRIGGER session_failure"));
    r.github.account = { id: 5678, login: "retry-person" };
    expect(await complete(r)).toMatchObject({ claimedWorkspaceId: expect.any(String), session: { username: "retry-person" } });
  });

  it.each(["browser", "github"])("lets the first completed %s sign-in win against the other kind", async (winnerKind) => {
    const r = await rig();
    const loserKind = winnerKind === "browser" ? "github" : "browser";
    const loser = await start(r.hub, loserKind);
    r.github.account = { id: 5678, login: "winner" };
    const winner = await start(r.hub, winnerKind);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    r.github.pauseIdentity = async accountId => { if (accountId === 1234) { enter(); await resumed; } };
    r.github.time += 1000;
    const collectingLoser = post(r.hub, `${loserKind}/collect`, loser);
    await entered;
    const won = await post(r.hub, `${winnerKind}/collect`, winner);
    resume();
    const lost = await collectingLoser;
    expect(won.result).toMatchObject({ status: "complete", claimedWorkspaceId: expect.any(String) });
    expect(lost.result).toMatchObject({ status: "complete" });
    expect(lost.result).not.toHaveProperty("claimedWorkspaceId");
    const snapshot = rows(r.path);
    const principalId = r.hub.principals!.getByGithubAccountId("5678")!.id;
    expect(snapshot.hub_admins).toEqual([{ principal_id: principalId }]);
    expect(snapshot.hub_memberships).toEqual([{ workspace_id: won.result.claimedWorkspaceId, principal_id: principalId, role: "admin" }]);
    expect(snapshot.hub_browser_sessions).toHaveLength(1);
    expect(snapshot.hub_credentials).toHaveLength(1);
  });

  it.each(["cancel", "expire"])("%s while GitHub identity is in flight prevents claiming and session issuance", async (action) => {
    const r = await rig();
    const before = rows(r.path);
    const request = await start(r.hub);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    r.github.pauseIdentity = async () => { enter(); await resumed; };
    r.github.time += 1000;
    const collecting = post(r.hub, "browser/collect", request);
    await entered;
    if (action === "cancel") expect(await post(r.hub, "browser/cancel", request)).toMatchObject({ result: { status: "abandoned" } });
    else r.github.time += 900_000;
    resume();
    expect(await collecting).toMatchObject({ result: { status: action === "cancel" ? "abandoned" : "expired" } });
    expect(rows(r.path)).toEqual(before);
  });
});

it("reports every browser route as unconfigured on core and team hubs without GitHub", async () => {
  const config = { authSecret: TEST_SECRET, address: "127.0.0.1", port: 0, databasePath: tempDatabasePath(), log: () => {} };
  const core = await createHub(config);
  hubs.push(core);
  const team = await createTeamHub({ ...config, databasePath: tempDatabasePath() });
  hubs.push(team);
  for (const hub of [core, team]) for (const route of ["start", "collect", "cancel", "session", "sign-out"]) {
    expect(await post(hub, `browser/${route}`)).toEqual({ code: 503, result: { status: "not-configured" } });
  }
});
import { deviceFetch as fetch } from "./device-credentials.js";

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript-api";
import { request, type IncomingHttpHeaders } from "node:http";
import { IncomingMessage, MessageType, OutgoingMessage } from "@hocuspocus/server";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createRevisionResponseReader, encodeOriginUpdate, encodeRevisionRequest, getMetaMap, readOriginAck,
  settingsRoom, setWorkspaceName, snapshotRevision, type RevisionRequest, type RevisionResponse } from "@uberblick/schema";
import { OAUTH_AUTHORIZATION_SERVER_METADATA_PATH, workspaceResourceUrl } from "@uberblick/schema/oauth";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { Awareness } from "y-protocols/awareness";
import { writeSyncStep1, writeSyncStep2 } from "y-protocols/sync";
import { importCredentialKey, mintToken, type RequestAction, type TokenScope } from "@uberblick/schema/token";
import { MANAGEMENT_OPERATIONS } from "../src/access-management.js";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { BrowserSessions } from "../src/browser-sessions.js";
import { silentLogger } from "../src/log.js";
import { OAuthAuthorizations } from "../src/oauth-authorizations.js";
import { HubDatabase } from "../src/persistence.js";
import type { PrincipalRecord } from "../src/principals.js";
import { createTeamHub, type TeamHub } from "../src/team.js";
import { WorkspaceNameReader } from "../src/workspace-names.js";
import { generateTestCredentialKeyPair, issueCredential, managementAction, mintDeviceRequestProof,
  renewalPublicKey, type TestCredential } from "./device-credentials.js";
import { OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath, TEST_SECRET, TEXT_KEY, waitUntil, WORKSPACE } from "./helpers.js";

const A = WORKSPACE;
const B = OTHER_WORKSPACE;
const A_ROOM = `${A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const B_ROOM = `${B}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const A_NAME = "A public test name";
const B_NAME = "B secret workspace";
const B_TEXT = "B secret document";
const B_USERNAME = "b-secret-admin";
const B_ACCOUNT = "9005000000005";
const ISSUER = "https://hub.example.com";
const CLIENT = "isolation-client";
const REDIRECT = "https://agent.example.com/callback";
const VERIFIER = "v".repeat(43);
type Action = Exclude<RequestAction, { operation: "renew-credential" }>;
type Actor = { principal: PrincipalRecord; credential: TestCredential; scope: TokenScope };
const hubs: TeamHub[] = [];
const databases: HubDatabase[] = [];
const bIdentities = new Set<string>();

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const db of databases.splice(0)) db.close();
  bIdentities.clear();
  removeTempDatabases();
});

function noB(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [B_NAME, B_TEXT, B_USERNAME, B_ACCOUNT, ...bIdentities]) expect(text).not.toContain(secret);
}

async function rig() {
  const path = tempDatabasePath();
  const socketPath = join(dirname(path), "mcp.sock");
  const clock = { time: Date.now() };
  const githubIdentity = { id: "9001", login: "a-admin" };
  const hub = await createTeamHub({ address: "0.0.0.0", port: 0, databasePath: path,
    authSecret: TEST_SECRET, publicUrl: ISSUER, mcpSocketPath: socketPath, log: silentLogger,
    github: { clientId: "Iv1.0123456789abcdef", now: () => clock.time,
      fetch: async input => {
        const url = String(input);
        if (url === "https://github.com/login/device/code") return Response.json({ device_code: randomUUID(),
          user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
        if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "test-provider-token", token_type: "bearer", scope: "" });
        expect(url).toBe("https://api.github.com/user");
        return Response.json({ id: Number(githubIdentity.id), login: githubIdentity.login });
      } },
  }, { oauthClients: async clientId => clientId === CLIENT
    ? { name: "Isolation agent", redirectUriAllowed: uri => uri === REDIRECT } : null });
  hubs.push(hub);
  const db = new HubDatabase(path, error => { throw error; }, { revisions: true });
  db.open();
  databases.push(db);
  const origin = `http://127.0.0.1:${hub.port}`;
  const grants = new AgentGrantRegistry(db, () => clock.time);
  const sessions = new BrowserSessions(db, () => clock.time);
  const oauth = new OAuthAuthorizations(db, hub.memberships!, new WorkspaceNameReader(db), hub.credentials!, () => clock.time);
  function person(id: string, username: string, memberships: [string, "admin" | "member"][]): Actor {
    const principal = hub.principals!.identify(id, username);
    for (const [workspaceId, role] of memberships) hub.memberships!.grant({ workspaceId, principalId: principal.id, role });
    return { principal, scope: "read-write", credential: issueCredential(hub.credentials!, {
      principalId: principal.id, deviceId: randomUUID(), workspaces: memberships.map(([workspace]) => workspace) }) };
  }
  function hosted(person: Actor, scope: TokenScope): Actor {
    const grant = grants.create({ principalId: person.principal.id, workspaceId: A, scope,
      clientId: CLIENT, clientName: "Isolation agent" });
    const pair = generateTestCredentialKeyPair();
    const issued = hub.credentials!.issueForGrant(grant.id, pair.publicKey);
    if (issued === null) throw new Error("fixture grant refused");
    return { principal: person.principal, scope, credential: { ...issued, keyBytes: pair.keyBytes } };
  }
  const admin = person("9001", "a-admin", [[A, "admin"]]);
  const member = person("9002", "a-member", [[A, "member"]]);
  const readOnly = hosted(person("9003", "a-reader", [[A, "member"]]), "read-only");
  const dual = person("9004", "dual-member", [[A, "member"], [B, "member"]]);
  const bAdmin = person(B_ACCOUNT, B_USERNAME, [[B, "admin"]]);
  bIdentities.add(bAdmin.principal.id);
  const actors = { admin, member, readOnly, hosted: hosted(dual, "read-write") };
  for (const [workspace, name, room, text] of [[A, A_NAME, A_ROOM, "A document"], [B, B_NAME, B_ROOM, B_TEXT]]) {
    const settings = new Y.Doc();
    const doc = new Y.Doc();
    try {
      setWorkspaceName(settings, name!);
      getMetaMap(doc).set("title", text!);
      doc.getText(TEXT_KEY).insert(0, text!);
      db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(settingsRoom(workspace!), Y.encodeStateAsUpdate(settings));
      db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(room!, Y.encodeStateAsUpdate(doc));
    } finally { settings.destroy(); doc.destroy(); }
  }
  return { hub, db, clock, origin, socketPath, actors, dual, bAdmin, grants, oauth, sessions, githubIdentity };
}

type IsolationRig = Awaited<ReturnType<typeof rig>>;

function http(r: IsolationRig, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown; text?: string;
} = {}) {
  return new Promise<{ code: number; headers: IncomingHttpHeaders; text: string; result: Record<string, unknown> }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: r.hub.port, path, method: options.method ?? "GET",
      headers: { Connection: "close", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let result: Record<string, unknown> = {};
        try { result = JSON.parse(text) as Record<string, unknown>; } catch { /* Redirects have no JSON body. */ }
        resolve({ code: response.statusCode!, headers: response.headers, text, result });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(options.text ?? (options.body === undefined ? undefined : JSON.stringify(options.body)));
  });
}

function session(r: IsolationRig, actor: Actor): string {
  return r.sessions.issue(actor.principal.id, actor.principal.githubUsername, r.origin).token;
}

async function manage(r: IsolationRig, credential: TestCredential, action: Action) {
  const token = await mintDeviceRequestProof(await importCredentialKey(credential.keyBytes), {
    kid: credential.record.id, ...action, lifetimeSeconds: 60 });
  return http(r, "/auth/manage", { method: "POST", body: { protocolVersion: SYNC_PROTOCOL_VERSION, token, ...action } });
}

function authority(r: IsolationRig) {
  return Object.fromEntries(["hub_admins", "hub_workspace_suspensions", "hub_workspace_promotions",
    "hub_agent_grants", "hub_oauth_authorization_codes", "hub_credentials", "hub_oauth_access_tokens",
    "hub_oauth_refresh_tokens", "hub_oauth_refresh_access_tokens"].map(table => [table, r.db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function mcp(r: IsolationRig, message: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(r.socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("MCP isolation response timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { input += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(input) as Record<string, unknown>); } catch (error) { reject(error); }
    });
  });
}

describe("workspace isolation through access management", () => {
  it.each(["admin", "member", "readOnly", "hosted"] as const)("keeps every management operation inside the %s actor's authority", async actorName => {
    const r = await rig();
    const actor = r.actors[actorName];
    const before = { authority: authority(r), memberships: r.db.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
      documents: r.db.connection.prepare("SELECT * FROM documents ORDER BY name").all() };
    for (const operation of MANAGEMENT_CASE_OPERATIONS) {
      const action = managementAction(operation, { workspaceId: B, attemptId: randomUUID(), principalId: r.bAdmin.principal.id,
        deviceId: r.bAdmin.credential.record.deviceId, githubUsername: B_USERNAME, githubAccountId: B_ACCOUNT });
      const response = await manage(r, actor.credential, action);
      const ownReply = operation === "list-devices" || operation === "revoke-browser-sessions";
      expect(response.code, operation).toBe(actor.credential.record.ceiling !== undefined ? 403
        : ownReply ? 200 : operation === "revoke-device" ? 404 : 403);
      noB(response);
    }
    expect({ authority: authority(r), memberships: r.db.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
      documents: r.db.connection.prepare("SELECT * FROM documents ORDER BY name").all() }).toEqual(before);
    expect(await manage(r, r.actors.admin.credential, { operation: "own-role", workspaceId: A }))
      .toMatchObject({ code: 200, result: { status: "ok", role: "admin" } });
  });

  it("bounds the hub administrator's workspace inventory exception", async () => {
    const r = await rig();
    r.hub.hubAdmins!.grant(r.actors.admin.principal.id);
    const response = await manage(r, r.actors.admin.credential, { operation: "list-hub-workspaces" });
    expect(response.code).toBe(200);
    expect(response.result).toEqual({ status: "ok", nextCursor: null, workspaces: [
      { workspaceId: A, name: A_NAME, members: 4, admins: ["a-admin"], status: "active" },
      { workspaceId: B, name: B_NAME, members: 2, admins: [B_USERNAME], status: "active" },
    ] });
    expect(response.text).not.toContain(B_TEXT);
    expect(response.text).not.toContain(B_ACCOUNT);
    expect(response.text).not.toContain(r.bAdmin.principal.id);
    for (const operation of ["list-members", "list-member-usernames"] as const) {
      const refused = await manage(r, r.actors.admin.credential, { operation, workspaceId: B });
      expect(refused).toMatchObject({ code: 403, result: { status: "forbidden" } });
      noB(refused);
    }
  });

  it("keeps only the former member's own hosted B grant and its live display name in the device list", async () => {
    const r = await rig();
    const ownGrant = r.grants.create({ principalId: r.dual.principal.id, workspaceId: B, scope: "read-only",
      clientId: CLIENT, clientName: "Own B agent" });
    const foreignGrant = r.grants.create({ principalId: r.bAdmin.principal.id, workspaceId: B, scope: "read-write",
      clientId: CLIENT, clientName: "Secret B agent" });
    r.hub.memberships!.remove({ workspaceId: B, principalId: r.dual.principal.id });
    const read = () => manage(r, r.dual.credential, { operation: "list-devices" });
    const beforeRename = await read();
    expect(beforeRename.code).toBe(200);
    const ownRows = (beforeRename.result.devices as Record<string, unknown>[]).filter(row => row.deviceId === ownGrant.deviceId);
    expect(ownRows).toEqual([{ deviceId: ownGrant.deviceId, hosted: true, workspaces: [B],
      deviceName: "Own B agent", workspaceId: B, workspaceName: B_NAME, scope: "read-only", signedInAt: ownGrant.createdAt, current: false }]);
    const aGrant = r.grants.get(r.actors.hosted.credential.record.ceiling!.grantId)!;
    const expectedDevices = (workspaceName: string) => ([
      { deviceId: r.dual.credential.record.deviceId, signedInAt: r.dual.credential.record.issuedAt, workspaces: [A, B], current: true },
      { deviceId: aGrant.deviceId, signedInAt: aGrant.createdAt, workspaces: [A], hosted: true,
        workspaceId: A, workspaceName: A_NAME, scope: "read-write", deviceName: "Isolation agent", current: false },
      { ...ownRows[0], workspaceName },
    ] as Record<string, unknown>[]).sort((left, right) => String(left.deviceId).localeCompare(String(right.deviceId)));
    expect(beforeRename.result).toEqual({ status: "ok", devices: expectedDevices(B_NAME) });
    expect(beforeRename.text).not.toContain(foreignGrant.id);
    expect(beforeRename.text).not.toContain(foreignGrant.deviceId);
    expect(beforeRename.text).not.toContain("Secret B agent");
    expect(beforeRename.text).not.toContain(B_TEXT);
    expect(beforeRename.text).not.toContain(B_USERNAME);
    const renamed = new Y.Doc();
    try {
      const row = r.db.connection.prepare("SELECT data FROM documents WHERE name = ?").get(settingsRoom(B));
      Y.applyUpdate(renamed, row!.data as Uint8Array);
      setWorkspaceName(renamed, "B renamed after departure");
      r.db.connection.prepare("UPDATE documents SET data = ? WHERE name = ?").run(Y.encodeStateAsUpdate(renamed), settingsRoom(B));
    } finally { renamed.destroy(); }
    const afterRename = await read();
    expect(afterRename.result).toEqual({ status: "ok", devices: expectedDevices("B renamed after departure") });
    expect((afterRename.result.devices as Record<string, unknown>[]).find(row => row.deviceId === ownGrant.deviceId))
      .toEqual({ ...ownRows[0], workspaceName: "B renamed after departure" });
    expect(r.grants.get(ownGrant.id)?.revokedAt).toBeNull();
    expect(r.grants.isLive(ownGrant.id)).toBe(false);
    for (const operation of ["own-role", "list-members", "list-member-usernames"] as const) {
      const refused = await manage(r, r.dual.credential, { operation, workspaceId: B });
      expect(refused.code).toBe(403);
      noB(refused);
    }
  });
});

async function renewOverHttp(r: IsolationRig, actor: Actor) {
  const token = await mintDeviceRequestProof(await importCredentialKey(actor.credential.keyBytes), {
    kid: actor.credential.record.id, operation: "renew-credential", lifetimeSeconds: 60 });
  return http(r, "/auth/credential/renew", { method: "POST", body: {
    protocolVersion: SYNC_PROTOCOL_VERSION, token, publicKey: renewalPublicKey(token) } });
}

async function signInOverHttp(r: IsolationRig, actor: Actor) {
  r.githubIdentity.id = actor.principal.githubAccountId;
  r.githubIdentity.login = actor.principal.githubUsername;
  const publicKey = Buffer.from(generateTestCredentialKeyPair().publicKey).toString("base64url");
  const started = await http(r, "/auth/github/start", { method: "POST", body: { publicKey } });
  expect(started).toMatchObject({ code: 200, result: { status: "pending" } });
  noB(started);
  r.clock.time += 5000;
  return http(r, "/auth/github/collect", { method: "POST", body: {
    requestId: started.result.requestId, collectionSecret: started.result.collectionSecret, publicKey } });
}

describe("workspace names at identity and credential boundaries", () => {
  it("signs in A-only members with names from their memberships, including sign-in after B removal", async () => {
    const r = await rig();
    r.hub.memberships!.remove({ workspaceId: B, principalId: r.dual.principal.id });
    for (const actor of [r.actors.admin, r.actors.member, r.dual]) {
      const response = await signInOverHttp(r, actor);
      expect(response).toMatchObject({ code: 200, result: { status: "complete", credential: {
        record: { principalId: actor.principal.id, workspaces: [A] }, workspaceNames: { [A]: A_NAME } } } });
      noB(response);
    }
  });

  it("renews after B removal and holds the dual member's hosted credential to its A ceiling", async () => {
    const r = await rig();
    const hosted = await renewOverHttp(r, r.actors.hosted);
    expect(hosted).toMatchObject({ code: 200, result: { status: "renewed", credential: {
      record: { workspaces: [A], ceiling: { workspaceId: A } }, workspaceNames: { [A]: A_NAME } } } });
    noB(hosted);
    r.hub.memberships!.remove({ workspaceId: B, principalId: r.dual.principal.id });
    for (const actor of [r.actors.admin, r.actors.member, r.actors.readOnly, r.dual]) {
      const response = await renewOverHttp(r, actor);
      expect(response).toMatchObject({ code: 200, result: { status: "renewed", credential: {
        record: { workspaces: [A] }, workspaceNames: { [A]: A_NAME } } } });
      noB(response);
    }
  });
});

it("keeps all private MCP channel actions bound to their A token or grant subject", async () => {
  const r = await rig();
  for (const actor of Object.values(r.actors)) {
    const roomToken = await oauthActorToken(actor);
    const invalidToken = await mcp(r, { action: "introspect", token: roomToken });
    expect(invalidToken).toEqual({ status: "negative" });
    const code = await oauthApprovedCode(r, actor);
    const exchanged = await oauthExchange(r, { grant_type: "authorization_code", code, code_verifier: VERIFIER,
      client_id: CLIENT, redirect_uri: REDIRECT, resource: workspaceResourceUrl(ISSUER, A) });
    expectOAuthTokenForA(r, exchanged, actor.scope === "read-only" ? "docs:read" : "docs:read docs:write");
    const accessToken = exchanged.result.access_token as string;
    const token = r.oauth.getAccessToken(accessToken)!;
    const grantId = actor.credential.record.ceiling?.grantId ?? token.grantId;
    const pair = generateTestCredentialKeyPair();
    const publicKey = Buffer.from(pair.publicKey).toString("base64url");
    const messages = {
      introspect: { action: "introspect", token: accessToken },
      "inspect-grant": { action: "inspect-grant", grantId },
      "issue-credential": { action: "issue-credential", grantId, publicKey },
    };
    for (const action of MCP_CASE_ACTIONS) {
      const message = messages[action];
      const before = authority(r);
      for (const target of [{ workspace: B }, { workspaceId: B }, { resource: workspaceResourceUrl(ISSUER, B) }]) {
        const refused = await mcp(r, { ...message, ...target });
        expect(refused).toEqual({ status: "invalid-request" });
        noB(refused);
      }
      expect(authority(r)).toEqual(before);
      const response = await mcp(r, message);
      noB(response);
      if (action === "introspect") expect(response).toEqual({ status: "positive", grantId: token.grantId,
        principal: actor.principal.id, workspace: A, scope: token.scope, expiresAt: token.expiresAt });
      else if (action === "inspect-grant") expect(response).toMatchObject({ status: "active", identity: actor.principal });
      else expect(response).toMatchObject({ status: "issued", credential: {
        principalId: actor.principal.id, workspaces: [A], ceiling: { grantId, workspaceId: A,
          scope: r.grants.get(grantId)!.scope } } });
    }
  }
});

it("keeps the public metadata, registration, claim and sign-in routes free of B data", async () => {
  const r = await rig();
  for (const actor of Object.values(r.actors)) {
    const token = await oauthActorToken(actor);
    const before = authority(r);
    const headers = { "X-Uberblick-Session": token, Origin: r.origin };
    const metadata = await http(r, OAUTH_AUTHORIZATION_SERVER_METADATA_PATH, { headers });
    expect(metadata).toMatchObject({ code: 200, result: { issuer: ISSUER } });
    const claim = await http(r, "/auth/claim-state", { headers });
    expect(claim).toMatchObject({ code: 200, result: { unclaimed: false, canClaim: false } });
    const registered = await http(r, "/oauth/register", { method: "POST", headers, body: {
      client_name: "Isolation client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } });
    expect(registered).toMatchObject({ code: 201, result: { client_id: expect.any(String) } });
    expect(registered.result).not.toHaveProperty("access_token");
    for (const response of [metadata, claim, registered]) noB(response);
    for (const route of ["/auth/browser/session", "/auth/browser/sign-out"] as const) {
      const response = await http(r, route, { method: "POST", headers, body: {} });
      expect(response).toMatchObject({ code: 401, result: { status: "signed-out" } });
      noB(response);
    }
    const publicKey = Buffer.from(generateTestCredentialKeyPair().publicKey).toString("base64url");
    const device = await http(r, "/auth/github/start", { method: "POST", headers, body: { publicKey } });
    expect(device).toMatchObject({ code: 200, result: { status: "pending" } });
    const cancelled = await http(r, "/auth/github/cancel", { method: "POST", headers, body: {
      requestId: device.result.requestId, collectionSecret: device.result.collectionSecret, publicKey } });
    expect(cancelled).toMatchObject({ code: 200, result: { status: "abandoned" } });
    const collected = await http(r, "/auth/github/collect", { method: "POST", headers, body: {
      requestId: device.result.requestId, collectionSecret: device.result.collectionSecret, publicKey } });
    expect(collected).toMatchObject({ code: 200, result: { status: "abandoned" } });
    for (const response of [device, cancelled, collected]) noB(response);
    for (const finish of ["collect", "cancel"] as const) {
      const started = await http(r, "/auth/browser/start", { method: "POST", headers, body: {} });
      expect(started).toMatchObject({ code: 200, result: { status: "pending" } });
      noB(started);
      r.githubIdentity.id = actor.principal.githubAccountId;
      r.githubIdentity.login = actor.principal.githubUsername;
      r.clock.time += 5000;
      const finished = await http(r, `/auth/browser/${finish}`, { method: "POST", headers, body: {
        requestId: started.result.requestId, collectionSecret: started.result.collectionSecret } });
      expect(finished).toMatchObject({ code: 200, result: { status: finish === "collect" ? "complete" : "abandoned" } });
      noB(finished);
      if (finish === "collect") {
        const browser = finished.result.session as { token: string };
        const browserHeaders = { ...headers, "X-Uberblick-Session": browser.token };
        const signedIn = await http(r, "/auth/browser/session", { method: "POST", headers: browserHeaders, body: {} });
        expect(signedIn).toMatchObject({ code: 200, result: { status: "signed-in", username: actor.principal.githubUsername } });
        noB(signedIn);
        const signedOut = await http(r, "/auth/browser/sign-out", { method: "POST", headers: browserHeaders, body: {} });
        expect(signedOut).toMatchObject({ code: 200, result: { status: "signed-out" } });
        noB(signedOut);
      }
    }
    expect(authority(r)).toEqual(before);
  }
});
async function oauthPending(r: IsolationRig, workspaceId = A, headers: Record<string, string> = {}) {
  const parameters = new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256",
    resource: workspaceResourceUrl(ISSUER, workspaceId), scope: "docs:read docs:write" });
  const before = authority(r);
  const response = await http(r, `/oauth/authorize?${parameters}`, { headers });
  expect(response.code).toBe(302);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.text).toBe("");
  const redirect = new URL(response.headers.location!);
  expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/connect`);
  expect([...redirect.searchParams.keys()]).toEqual(["request"]);
  const requestId = redirect.searchParams.get("request")!;
  expect(requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  noB(response);
  expect(authority(r)).toEqual(before);
  return requestId;
}

function oauthConsent(r: IsolationRig, route: "read" | "submit", requestId: string, token: string, accessLevel: TokenScope = "read-write") {
  return http(r, `/oauth/consent/${route}`, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: r.origin, "Sec-Fetch-Site": "same-origin", "X-Uberblick-Session": token,
  }, body: route === "read" ? { requestId } : { requestId, decision: "approve", accessLevel } });
}

async function oauthActorToken(actor: Actor) {
  return mintToken(await importCredentialKey(actor.credential.keyBytes), { typ: "room", sub: actor.principal.id,
    workspace: A, scope: actor.scope, kid: actor.credential.record.id, lifetimeSeconds: 60 });
}

async function oauthApprovedCode(r: IsolationRig, actor: Actor, workspaceId = A) {
  const requestId = await oauthPending(r, workspaceId);
  const submitted = await oauthConsent(r, "submit", requestId, session(r, actor), actor.scope);
  expect(submitted.code).toBe(200);
  expect(submitted.result.status).toBe("approved");
  if (workspaceId === A) noB(submitted);
  const redirect = new URL(submitted.result.redirectUrl as string);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect([...redirect.searchParams.keys()]).toEqual(["code"]);
  expect(redirect.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return redirect.searchParams.get("code")!;
}

async function oauthExchange(r: IsolationRig, parameters: Record<string, string>) {
  const response = await http(r, "/oauth/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, text: new URLSearchParams(parameters).toString() });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.pragma).toBe("no-cache");
  noB(response);
  return response;
}

function expectOAuthTokenForA(r: IsolationRig, response: Awaited<ReturnType<typeof oauthExchange>>, scope = "docs:read docs:write") {
  expect(response.code).toBe(200);
  expect(response.result).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), token_type: "Bearer",
    expires_in: 3600, scope, refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  const token = r.oauth.getAccessToken(response.result.access_token as string);
  expect(token).toMatchObject({ resource: workspaceResourceUrl(ISSUER, A), scope });
  expect(r.grants.get(token!.grantId)).toMatchObject({ workspaceId: A });
}

describe("workspace isolation through OAuth", () => {
  it("bounds unauthenticated B authorization and separates browser membership refusals from credential misuse", async () => {
    const r = await rig();
    for (const actor of Object.values(r.actors)) {
      const token = await oauthActorToken(actor);
      await oauthPending(r, B, { "X-Uberblick-Session": token });
      for (const route of ["read", "submit"] as const) {
        const requestId = await oauthPending(r, B);
        const before = authority(r);
        const response = await oauthConsent(r, route, requestId, token);
        expect(response.code).toBe(401);
        expect(response.result).toEqual({ status: "signed-out" });
        noB(response);
        expect(authority(r)).toEqual(before);
      }
    }
    for (const actor of [r.actors.admin, r.actors.member]) {
      const browserToken = session(r, actor);
      const ownRequest = await oauthPending(r, A);
      const ownRead = await oauthConsent(r, "read", ownRequest, browserToken);
      expect(ownRead.code).toBe(200);
      expect(ownRead.result).toMatchObject({ status: "pending", workspaceId: A, workspaceName: A_NAME });
      noB(ownRead);
      for (const route of ["read", "submit"] as const) {
        const requestId = await oauthPending(r, B);
        const before = authority(r);
        const response = await oauthConsent(r, route, requestId, browserToken);
        expect(response.code).toBe(403);
        expect(response.result).toEqual({ status: "not-a-member" });
        noB(response);
        expect(authority(r)).toEqual(before);
      }
    }
    const code = await oauthApprovedCode(r, r.actors.hosted);
    const issued = await oauthExchange(r, { grant_type: "authorization_code", code, code_verifier: VERIFIER,
      client_id: CLIENT, redirect_uri: REDIRECT, resource: workspaceResourceUrl(ISSUER, A) });
    expectOAuthTokenForA(r, issued);
    for (const route of ["read", "submit"] as const) {
      const requestId = await oauthPending(r, B);
      const before = authority(r);
      const response = await oauthConsent(r, route, requestId, issued.result.access_token as string);
      expect(response).toMatchObject({ code: 401, result: { status: "signed-out" } });
      noB(response);
      expect(authority(r)).toEqual(before);
    }
  });

  it("keeps authorization-code and refresh exchanges bound to A when the real B resource is requested", async () => {
    const r = await rig();
    const code = await oauthApprovedCode(r, r.actors.member);
    const parameters = { grant_type: "authorization_code", code, code_verifier: VERIFIER,
      client_id: CLIENT, redirect_uri: REDIRECT, resource: workspaceResourceUrl(ISSUER, A) };
    const beforeCodeRefusal = authority(r);
    const refusedCode = await oauthExchange(r, { ...parameters, resource: workspaceResourceUrl(ISSUER, B) });
    expect(refusedCode.code).toBe(400);
    expect(refusedCode.result).toEqual({ error: "invalid_target" });
    expect(authority(r)).toEqual(beforeCodeRefusal);
    const issued = await oauthExchange(r, parameters);
    expectOAuthTokenForA(r, issued);

    const refresh = { grant_type: "refresh_token", refresh_token: issued.result.refresh_token as string,
      client_id: CLIENT, resource: workspaceResourceUrl(ISSUER, A) };
    const beforeRefreshRefusal = authority(r);
    const refusedRefresh = await oauthExchange(r, { ...refresh, resource: workspaceResourceUrl(ISSUER, B) });
    expect(refusedRefresh.code).toBe(400);
    expect(refusedRefresh.result).toEqual({ error: "invalid_target" });
    expect(authority(r)).toEqual(beforeRefreshRefusal);
    const renewed = await oauthExchange(r, refresh);
    expectOAuthTokenForA(r, renewed);
    expect(renewed.result.access_token).not.toBe(issued.result.access_token);
    expect(renewed.result.refresh_token).not.toBe(issued.result.refresh_token);
  });

  it("allows the dual member's independent browser consent for B despite their hosted A grant ceiling", async () => {
    const r = await rig();
    expect(r.actors.hosted.credential.record.principalId).toBe(r.dual.principal.id);
    expect(r.actors.hosted.credential.record.ceiling).toMatchObject({ workspaceId: A });
    const requestId = await oauthPending(r, B);
    const browserToken = session(r, r.dual);
    const consent = await oauthConsent(r, "read", requestId, browserToken);
    expect(consent.code).toBe(200);
    expect(consent.result).toMatchObject({ status: "pending", workspaceId: B, workspaceName: B_NAME,
      accessLevels: ["read-only", "read-write"] });
    const credentialsBefore = r.db.connection.prepare("SELECT * FROM hub_credentials ORDER BY id").all();
    const submitted = await oauthConsent(r, "submit", requestId, browserToken);
    expect(submitted.code).toBe(200);
    expect(submitted.result.status).toBe("approved");
    const code = new URL(submitted.result.redirectUrl as string).searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = r.db.connection.prepare(`SELECT codes.resource, grants.workspace_id, grants.principal_id
      FROM hub_oauth_authorization_codes AS codes JOIN hub_agent_grants AS grants ON grants.id = codes.grant_id
      WHERE codes.code_hash = ?`).get(createHash("sha256").update(code).digest("hex"));
    expect(stored).toMatchObject({ resource: workspaceResourceUrl(ISSUER, B), workspace_id: B, principal_id: r.dual.principal.id });
    expect(r.db.connection.prepare("SELECT * FROM hub_credentials ORDER BY id").all()).toEqual(credentialsBefore);
  });
});

interface IsolationFrame {
  room: string;
  type: number;
  data: Uint8Array;
}

interface IsolationSocket {
  socket: WebSocket;
  frames: IsolationFrame[];
}

function isolationMessage(frame: IsolationFrame): IncomingMessage {
  const message = new IncomingMessage(frame.data);
  message.readVarString();
  message.readVarUint();
  return message;
}

async function isolationSocket(hub: TeamHub, sockets: IsolationSocket[]): Promise<IsolationSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}`);
  socket.binaryType = "arraybuffer";
  const client: IsolationSocket = { socket, frames: [] };
  sockets.push(client);
  socket.addEventListener("message", event => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    if (data.length === 1) return;
    const message = new IncomingMessage(data);
    client.frames.push({ room: message.readVarString(), type: message.readVarUint(), data });
  });
  await waitUntil("the isolation socket to open", () => socket.readyState === WebSocket.OPEN);
  return client;
}

async function closeIsolationSockets(sockets: IsolationSocket[]): Promise<void> {
  for (const { socket } of sockets) {
    if (socket.readyState === WebSocket.CLOSED) continue;
    socket.close();
    await waitUntil("the isolation socket to close", () => socket.readyState === WebSocket.CLOSED);
  }
}

async function isolationAuthenticate(client: IsolationSocket, actor: Actor, room: string, workspace: string): Promise<string> {
  const start = client.frames.length;
  const token = await mintToken(await importCredentialKey(actor.credential.keyBytes), {
    typ: "room", sub: actor.principal.id, workspace, scope: actor.scope,
    kid: actor.credential.record.id, lifetimeSeconds: 60,
  });
  const message = new IncomingMessage(new Uint8Array());
  message.writeVarString(room);
  message.writeVarUint(MessageType.Auth);
  message.writeVarUint(0);
  message.writeVarString(wrapToken(token, SYNC_PROTOCOL_VERSION));
  client.socket.send(message.toUint8Array());
  let answer: string | undefined;
  await waitUntil("room authentication to finish", () => {
    const frame = client.frames.slice(start).find(frame => frame.room === room && frame.type === MessageType.Auth);
    if (frame === undefined) return false;
    const response = isolationMessage(frame);
    response.readVarUint();
    answer = response.readVarString();
    return true;
  });
  return answer!;
}

async function isolationRevision(client: IsolationSocket, room: string,
  value: Omit<RevisionRequest, "requestId">): Promise<RevisionResponse> {
  const requestId = randomUUID();
  const read = createRevisionResponseReader(requestId);
  let consumed = client.frames.length;
  let response: RevisionResponse | null = null;
  client.socket.send(new OutgoingMessage(room).writeStateless(encodeRevisionRequest({ requestId, ...value })).toUint8Array());
  await waitUntil("the addressed isolation revision reply", () => {
    for (const frame of client.frames.slice(consumed)) {
      if (frame.room === room && frame.type === MessageType.Stateless) {
        response = read(isolationMessage(frame).readVarString()) ?? response;
      }
    }
    consumed = client.frames.length;
    return response !== null;
  });
  return response!;
}

async function isolationOrigin(client: IsolationSocket, actor: Actor, room: string, document: Y.Doc): Promise<void> {
  const updateId = randomUUID();
  const start = client.frames.length;
  client.socket.send(new OutgoingMessage(room).writeStateless(encodeOriginUpdate(updateId,
    Y.encodeStateAsUpdate(document), {
      updateId, credentialId: actor.credential.record.id, surface: { kind: "test", name: "isolation" },
    })).toUint8Array());
  await waitUntil("the valid workspace update to be applied", () => client.frames.slice(start).some(frame => {
    if (frame.room !== room || frame.type !== MessageType.Stateless) return false;
    const ack = readOriginAck(isolationMessage(frame).readVarString());
    return ack?.updateId === updateId && ack.applied;
  }));
}

function isolationChecksum(document: Y.Doc): string {
  return createHash("sha256").update(snapshotRevision(document).checksum).digest("hex");
}

// Each request is valid for the target B room, including mutation preconditions.
// The explicit keys are also the revision-operation coverage inventory.
function isolationRevisionCases(revisionId: string, checksum: string) {
  const surface = { kind: "test", name: "isolation" };
  return {
    list: { operation: "list", includeNames: true, includeTitles: true },
    get: { operation: "get", revisionId },
    name: { operation: "name", checksum, name: "foreign name", surface },
    rename: { operation: "rename", revisionId, name: "foreign rename", surface },
    "remove-name": { operation: "remove-name", revisionId },
    restore: { operation: "restore", revisionId, checksum, surface },
  } satisfies Record<RevisionRequest["operation"], Omit<RevisionRequest, "requestId">>;
}

function sendForeignIsolationFrames(client: IsolationSocket, actor: Actor, room: string,
  revisionId: string, checksum: string): void {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  try {
    document.getText("body").insert(0, "unauthorized cross-workspace write");
    awareness.setLocalState({ name: "unauthorized cross-workspace awareness" });
    const first = new OutgoingMessage(room).createSyncMessage();
    writeSyncStep1(first.encoder, document);
    client.socket.send(first.toUint8Array());
    const second = new OutgoingMessage(room).createSyncMessage();
    writeSyncStep2(second.encoder, document);
    client.socket.send(second.toUint8Array());
    client.socket.send(new OutgoingMessage(room).createSyncMessage()
      .writeUpdate(Y.encodeStateAsUpdate(document)).toUint8Array());
    client.socket.send(new OutgoingMessage(room).createAwarenessUpdateMessage(awareness).toUint8Array());
    client.socket.send(new OutgoingMessage(room).writeQueryAwareness().toUint8Array());
    const updateId = randomUUID();
    client.socket.send(new OutgoingMessage(room).writeStateless(encodeOriginUpdate(updateId,
      Y.encodeStateAsUpdate(document), {
        updateId, credentialId: actor.credential.record.id, surface: { kind: "test", name: "isolation" },
      })).toUint8Array());
    for (const request of Object.values(isolationRevisionCases(revisionId, checksum))) {
      client.socket.send(new OutgoingMessage(room).writeStateless(encodeRevisionRequest({
        requestId: randomUUID(), ...request,
      })).toUint8Array());
    }
  } finally {
    awareness.destroy();
    document.destroy();
  }
}

async function isolationDrain(hub: TeamHub): Promise<void> {
  await Promise.all([...hub.hocuspocus.documents.values()].flatMap(document =>
    document.getConnections().map(connection => connection.waitForPendingMessages())));
}

function isolationNoBFrames(frames: IsolationFrame[]): void {
  for (const frame of frames) {
    noB(new TextDecoder().decode(frame.data));
    if (frame.type !== MessageType.Stateless) continue;
    const payload = isolationMessage(frame).readVarString();
    noB(payload);
    const value: unknown = JSON.parse(payload);
    if (value !== null && typeof value === "object" && "state" in value && typeof value.state === "string") {
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, Uint8Array.from(atob(value.state), character => character.charCodeAt(0)));
        noB(document.getText("body").toString());
        noB(getMetaMap(document).toJSON());
      } finally { document.destroy(); }
    }
  }
}

async function seedIsolationRevision(context: Awaited<ReturnType<typeof rig>>, sockets: IsolationSocket[]) {
  const owner = await isolationSocket(context.hub, sockets);
  expect(await isolationAuthenticate(owner, context.bAdmin, B_ROOM, B)).toBe("read-write");
  await waitUntil("the valid B room to load", () => context.hub.hocuspocus.documents.has(B_ROOM));
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Y.encodeStateAsUpdate(context.hub.hocuspocus.documents.get(B_ROOM)!));
    getMetaMap(document).set("title", `${B_TEXT} revision`);
    await isolationOrigin(owner, context.bAdmin, B_ROOM, document);
    const checksum = isolationChecksum(context.hub.hocuspocus.documents.get(B_ROOM)!);
    const named = await isolationRevision(owner, B_ROOM, {
      operation: "name", checksum, name: "B private revision name", surface: { kind: "test", name: "isolation" },
    });
    expect(named).toMatchObject({ ok: true, revision: {
      author: { githubUsername: B_USERNAME },
      name: { text: "B private revision name", namer: { githubUsername: B_USERNAME } },
    } });
    if (!("revision" in named)) throw new Error("the B fixture revision was not named");
    const read = await isolationRevision(owner, B_ROOM, { operation: "get", revisionId: named.revision.id });
    expect(read).toHaveProperty("state");
    return { id: named.revision.id, checksum };
  } finally { document.destroy(); }
}

function isolationBState(context: Awaited<ReturnType<typeof rig>>) {
  const document = context.hub.hocuspocus.documents.get(B_ROOM)!;
  return {
    content: Y.encodeStateAsUpdate(document),
    awareness: [...document.awareness.getStates()],
    revisions: context.db.revisions.list(B_ROOM),
    names: context.db.revisions.names(B_ROOM),
  };
}

it.each(["admin", "member", "readOnly", "hosted", "hubAdmin"] as const)(
  "%s cannot enter B or address it through an admitted A socket", async actorName => {
    const context = await rig();
    const sockets: IsolationSocket[] = [];
    try {
      const foreign = await seedIsolationRevision(context, sockets);
      const actor = context.actors[actorName === "hubAdmin" ? "admin" : actorName];
      if (actorName === "hubAdmin") context.hub.hubAdmins!.grant(actor.principal.id);
      const client = await isolationSocket(context.hub, sockets);
      expect(await isolationAuthenticate(client, actor, A_ROOM, A))
        .toBe(actor.scope === "read-only" ? "readonly" : "read-write");
      expect(await isolationAuthenticate(client, actor, B_ROOM, A)).toBe("device-credential-refused");
      expect(await isolationAuthenticate(client, actor, B_ROOM, B)).toBe("device-credential-refused");
      isolationNoBFrames(client.frames);
      const before = isolationBState(context);
      const start = client.frames.length;
      sendForeignIsolationFrames(client, actor, B_ROOM, foreign.id, foreign.checksum);
      expect(await isolationRevision(client, A_ROOM, { operation: "list", includeNames: true, includeTitles: true }))
        .toMatchObject({ ok: true });
      await isolationDrain(context.hub);
      expect(client.frames.slice(start).filter(frame => frame.room === B_ROOM)).toEqual([]);
      expect(isolationBState(context)).toEqual(before);
      const checksum = isolationChecksum(context.hub.hocuspocus.documents.get(A_ROOM)!);
      const cases = isolationRevisionCases(foreign.id, checksum);
      for (const request of [cases.get, cases.rename, cases["remove-name"], cases.restore]) {
        const reply = await isolationRevision(client, A_ROOM, request);
        expect(reply).toMatchObject({ ok: false });
        noB(reply);
      }
      isolationNoBFrames(client.frames);
      expect(isolationBState(context)).toEqual(before);
    } finally { await closeIsolationSockets(sockets); }
  },
);

it("removing B membership closes its rooms and fences later B traffic while A keeps working", async () => {
  const context = await rig();
  const sockets: IsolationSocket[] = [];
  try {
    const foreign = await seedIsolationRevision(context, sockets);
    const client = await isolationSocket(context.hub, sockets);
    expect(await isolationAuthenticate(client, context.dual, A_ROOM, A)).toBe("read-write");
    expect(await isolationAuthenticate(client, context.dual, B_ROOM, B)).toBe("read-write");
    expect(await isolationAuthenticate(client, context.dual, settingsRoom(B), B)).toBe("readonly");
    await isolationRevision(client, B_ROOM, { operation: "list" });
    const start = client.frames.length;
    expect(context.hub.memberships!.remove({ workspaceId: B, principalId: context.dual.principal.id })).toBe(true);
    await waitUntil("both removed B rooms to close", () => [B_ROOM, settingsRoom(B)].every(room =>
      client.frames.slice(start).some(frame => frame.room === room && frame.type === MessageType.CLOSE)));
    const before = isolationBState(context);
    sendForeignIsolationFrames(client, context.dual, B_ROOM, foreign.id, foreign.checksum);
    expect(await isolationRevision(client, A_ROOM, { operation: "list" })).toMatchObject({ ok: true });
    await isolationDrain(context.hub);
    expect(isolationBState(context)).toEqual(before);
    expect(client.frames.slice(start).filter(frame => frame.room === B_ROOM && frame.type !== MessageType.CLOSE)).toEqual([]);
    expect(await isolationAuthenticate(client, context.dual, B_ROOM, B)).toBe("device-credential-refused");
    expect(context.hub.hocuspocus.documents.get(B_ROOM)!.getConnections()
      .some(connection => "principalId" in connection.context && connection.context.principalId === context.dual.principal.id)).toBe(false);
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(context.hub.hocuspocus.documents.get(A_ROOM)!));
      document.getText("body").insert(document.getText("body").length, " A survives B removal");
      await isolationOrigin(client, context.dual, A_ROOM, document);
      expect(context.hub.hocuspocus.documents.get(A_ROOM)!.getText("body").toString()).toContain("A survives B removal");
    } finally { document.destroy(); }
    isolationNoBFrames(client.frames.slice(start));
  } finally { await closeIsolationSockets(sockets); }
});
const HTTP_CASE_PATHS = [
  "/.well-known/oauth-authorization-server", "/auth/claim-state", "/auth/credential/renew", "/auth/manage",
  "/auth/github/start", "/auth/github/collect", "/auth/github/cancel", "/auth/browser/start", "/auth/browser/collect",
  "/auth/browser/cancel", "/auth/browser/session", "/auth/browser/sign-out", "/oauth/authorize", "/oauth/consent/read",
  "/oauth/consent/submit", "/oauth/token", "/oauth/register",
] as const;
const MANAGEMENT_CASE_OPERATIONS = [
  "list-devices", "revoke-device", "revoke-browser-sessions", "own-hub-role", "list-hub-admins", "list-hub-workspaces",
  "remove-hub-admin", "suspend-workspace", "restore-workspace", "promote-workspace", "own-role", "list-member-usernames",
  "list-members", "resolve-account", "grant-member", "change-role", "remove-member",
] as const;
const REVISION_CASE_OPERATIONS = ["list", "get", "name", "rename", "remove-name", "restore"] as const;
const MCP_CASE_ACTIONS = ["introspect", "inspect-grant", "issue-credential"] as const;
const STATELESS_CASE_KINDS = {
  "revision-reads.ts": ["uberblick:revision-request"],
  "update-attribution.ts": ["uberblick:origin-update"],
} as const;

function descendants(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => { found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}

/** Read syntax with the installed compiler, including aliases used by wire discriminants. */
function discriminatorValues(root: ts.Node, key: string): string[] {
  const source = root.getSourceFile();
  const declarations = descendants(source).filter(ts.isVariableDeclaration);
  const values = (node: ts.Expression, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) throw new Error("Cyclic wire discriminator");
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return values(node.expression, next);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => values(element, next));
    if (ts.isIdentifier(node)) {
      const declaration = declarations.find(entry => ts.isIdentifier(entry.name) && entry.name.text === node.text);
      if (declaration?.initializer !== undefined) return values(declaration.initializer, next);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = values(node.left, next), right = values(node.right, next);
      return left.flatMap(prefix => right.map(suffix => prefix + suffix));
    }
    throw new Error(`Inventory needs a case for computed ${key} discriminator in ${source.fileName}`);
  };
  const aliases = new Set<string>();
  const property = (node: ts.Node): boolean =>
    ts.isIdentifier(node) && aliases.has(node.text) ||
    ts.isPropertyAccessExpression(node) && node.name.text === key ||
    ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === key ||
    (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) && property(node.expression);
  for (const node of descendants(source)) {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) &&
      (node.propertyName ?? node.name).getText(source) === key) aliases.add(node.name.text);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined &&
        property(declaration.initializer) && !aliases.has(declaration.name.text)) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  const result: string[] = [];
  for (const node of descendants(root)) {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      if (property(node.left)) result.push(...values(node.right));
      else if (property(node.right)) result.push(...values(node.left));
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" && node.arguments[0] !== undefined && property(node.arguments[0])) {
      result.push(...values(node.expression.expression));
    } else if (ts.isSwitchStatement(node) && property(node.expression)) {
      for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) result.push(...values(clause.expression));
    }
  }
  return [...new Set(result)].sort();
}

it("requires an isolation case for every HTTP route, operation, stateless kind and MCP action", () => {
  const hubDirectory = new URL("../src/", import.meta.url);
  const sources = readdirSync(hubDirectory, { recursive: true }).filter((name): name is string =>
    typeof name === "string" && name.endsWith(".ts")).map(name => ts.createSourceFile(name,
    readFileSync(new URL(name, hubDirectory), "utf8"), ts.ScriptTarget.Latest, true));
  const schema = ["origin.ts", "revision-protocol.ts"].map(name => ts.createSourceFile(name,
    readFileSync(new URL(`../../schema/src/${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true));
  const allSources = [...sources, ...schema];
  const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
  // These strings match existing route families or suffixes; they do not add an endpoint.
  const matchFragments = ["/auth/", "/auth/browser/", "/oauth/", "/start", "/collect", "/cancel", "/sign-out"];
  const nonHttpPaths: Record<string, readonly string[]> = {
    "operator-command.ts": ["/release/release.json"], "release-identity.ts": ["/release/release.json"],
    "operator-doctor.ts": ["/"], "oauth-metadata-fetch.ts": ["/"], "admissible-room.ts": ["/_feedback"],
  };
  const pathLiterals = sources.flatMap(source => descendants(source).flatMap(node => {
    if (ts.isTemplateExpression(node) && node.head.text.startsWith("/")) throw new Error(`Computed path in ${source.fileName} needs an isolation case`);
    return ts.isStringLiteralLike(node) && node.text.startsWith("/") && !nonHttpPaths[source.fileName]?.includes(node.text) ? [node.text] : [];
  }));

  for (const source of sources) {
    const aliases = new Set<string>();
    const routeValue = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node)) return aliases.has(node.text);
      if (ts.isPropertyAccessExpression(node)) return node.name.text === "url" && !ts.isMetaProperty(node.expression) || node.name.text === "pathname" && routeValue(node.expression);
      if (ts.isElementAccessExpression(node)) return routeValue(node.expression);
      if (ts.isParenthesizedExpression(node)) return routeValue(node.expression);
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) return routeValue(node.left) || routeValue(node.right);
      if (ts.isNewExpression(node) && node.expression.getText(source) === "URL") return node.arguments?.some(routeValue) ?? false;
      return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        !["startsWith", "endsWith", "includes", "match", "test"].includes(node.expression.name.text) && routeValue(node.expression.expression);
    };
    const nodes = descendants(source);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
        !aliases.has(node.name.text) && routeValue(node.initializer)) { aliases.add(node.name.text); changed = true; }
    }
    const literalGuard = (node: ts.Node): boolean => ts.isStringLiteralLike(node) ||
      ts.isIdentifier(node) && node.text === "OAUTH_AUTHORIZATION_SERVER_METADATA_PATH" ||
      ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteralLike) ||
      ts.isIdentifier(node) && ["GITHUB_SIGN_IN_ROUTES", "BROWSER_SIGN_IN_ROUTES", "SIGN_IN_ROUTES"].includes(node.text);
    const refuse = (): never => { throw new Error(`Unrecognized HTTP dispatch in ${source.fileName}; add its isolation case and inventory form`); };
    for (const node of nodes) {
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
        if (routeValue(node.left) && !literalGuard(node.right) || routeValue(node.right) && !literalGuard(node.left)) refuse();
      } else if (ts.isCallExpression(node)) {
        const member = ts.isPropertyAccessExpression(node.expression) ? node.expression : undefined;
        if (member !== undefined && routeValue(member.expression)) {
          if (!["startsWith", "endsWith", "includes", "split"].includes(member.name.text) || !node.arguments.every(literalGuard)) refuse();
        } else if (node.arguments.some(routeValue) && (member?.name.text !== "includes" || !literalGuard(member.expression))) refuse();
      } else if (ts.isElementAccessExpression(node) && routeValue(node.argumentExpression)) refuse();
      else if (ts.isSwitchStatement(node) && routeValue(node.expression)) {
        for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && !literalGuard(clause.expression)) refuse();
      }
    }
  }
  const dispatch = sources.flatMap(descendants).find(node => ts.isMethodDeclaration(node) && node.name.getText() === "handleRequest" && node.body !== undefined);
  expect(dispatch).toBeDefined();
  expect(descendants(dispatch!).filter(ts.isCallExpression).map(call => call.expression.getText())).toEqual([
    "handleAuthorizationServerMetadata", "handleOAuthRegistration", "handleOAuthAuthorization", "handleOAuthToken", "handleHubClaimState",
    "handleCredentialRenewal", "handleAccessManagement", "handleBrowserSignIn", "handleGithubSignIn",
  ]);
  expect(sorted([...pathLiterals, OAUTH_AUTHORIZATION_SERVER_METADATA_PATH])).toEqual(sorted([
    ...HTTP_CASE_PATHS, ...matchFragments,
  ]));
  expect(sorted(Object.keys(MANAGEMENT_OPERATIONS))).toEqual(sorted(MANAGEMENT_CASE_OPERATIONS));
  const revisionParser = schema.flatMap(descendants).find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readRevisionRequest");
  expect(revisionParser).toBeDefined();
  expect(discriminatorValues(revisionParser as ts.Node, "operation")).toEqual(sorted(REVISION_CASE_OPERATIONS));
  const mcpSource = sources.find(source => source.fileName === "mcp-channel.ts");
  expect(mcpSource).toBeDefined();
  expect(discriminatorValues(mcpSource as ts.Node, "action")).toEqual(sorted(MCP_CASE_ACTIONS));

  const hooks = sources.flatMap(source => descendants(source).filter(node =>
    (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
    ts.isIdentifier(node.name) && node.name.text === "onStateless").map(node => ({ source, node })));
  expect(hooks.map(hook => hook.source.fileName).sort()).toEqual(Object.keys(STATELESS_CASE_KINDS).sort());
  for (const { source, node } of hooks) {
    const hook = ts.isMethodDeclaration(node) ? node :
      ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) ? node.initializer : undefined;
    if (hook === undefined || !ts.isFunctionLike(hook)) throw new Error("Unrecognized stateless handler");
    const parameter = hook.parameters[0]?.name;
    if (parameter === undefined || !ts.isObjectBindingPattern(parameter)) throw new Error("Unrecognized stateless payload binding");
    const binding = parameter.elements.find(element => (element.propertyName ?? element.name).getText(source) === "payload");
    if (binding === undefined || !ts.isIdentifier(binding.name)) throw new Error("Unrecognized stateless payload binding");
    const payloadName = binding.name.text;
    const directKinds = discriminatorValues(hook, "type");
    const parsers = descendants(hook).filter(ts.isCallExpression).filter(call =>
      call.arguments.some(argument => ts.isIdentifier(argument) && argument.text === payloadName));
    const kinds = [...directKinds];
    for (const parser of parsers) {
      if (parser.expression.getText(source) === "JSON.parse") continue;
      if (!ts.isIdentifier(parser.expression)) throw new Error("Unrecognized stateless payload reader");
      const name = parser.expression.text;
      const declaration = allSources.flatMap(descendants).find(candidate =>
        ts.isFunctionDeclaration(candidate) && candidate.name?.text === name);
      if (declaration === undefined) throw new Error(`Inventory cannot resolve stateless reader ${name}`);
      const parserKinds = discriminatorValues(declaration, "type");
      expect(parserKinds.length, `Stateless reader ${name} needs an inventoried wire kind`).toBeGreaterThan(0);
      kinds.push(...parserKinds);
    }
    expect(sorted(kinds)).toEqual(sorted(STATELESS_CASE_KINDS[source.fileName as keyof typeof STATELESS_CASE_KINDS]));
  }
});

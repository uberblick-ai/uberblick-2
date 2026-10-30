import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { resolveCoreHubConfig } from "../src/config.js";
import { CredentialRegistry } from "../src/credentials.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { introspectMcpToken, MCP_SOCKET_TIMEOUT_MS, requestMcpCredential, startMcpChannel } from "../src/mcp-channel.js";
import { MembershipRegistry } from "../src/memberships.js";
import { OAuthAuthorizations, type OAuthCodeExchange } from "../src/oauth-authorizations.js";
import { HubDatabase } from "../src/persistence.js";
import { createTeamHub } from "../src/team.js";
import { WorkspaceNameReader } from "../src/workspace-names.js";
import { generateTestCredentialKeyPair } from "./device-credentials.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "consenting-person";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PATH = "private/mcp.sock";
const stops: Array<() => Promise<void>> = [];
const databases: HubDatabase[] = [];
const sockets = new Set<Socket>();
let originalDirectory: string;
let directory: string;

beforeEach(() => {
  originalDirectory = process.cwd();
  directory = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `mcp-channel-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  process.chdir(directory);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const database of databases.splice(0)) database.close();
  process.chdir(originalDirectory);
  rmSync(directory, { recursive: true, force: true });
});

function state() {
  const clock = { now: 1000 };
  const database = new HubDatabase(":memory:", error => { throw error; });
  database.open();
  databases.push(database);
  const memberships = new MembershipRegistry(database);
  memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
  const admins = new HubAdminRegistry(database);
  const credentials = new CredentialRegistry(database, admins, undefined, () => clock.now);
  const grants = new AgentGrantRegistry(database, () => clock.now);
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), credentials, () => clock.now);
  return { database, memberships, admins, credentials, grants, authorizations, clock };
}

function issue(context: ReturnType<typeof state>) {
  const request = { clientId: "registered-agent", clientName: "Hosted Client", redirectUri: "https://client.example/callback", state: null,
    codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"), resource: `https://hub.example/mcp/${WORKSPACE}`,
    workspaceId: WORKSPACE, writeRequested: true };
  const result = context.authorizations.submit({ requestId: context.authorizations.create(request)!, decision: "approve", accessLevel: "read-write" }, PRINCIPAL);
  if (result.status !== "approved") throw new Error("approval failed");
  const exchange: OAuthCodeExchange = { code: new URL(result.redirectUrl).searchParams.get("code")!, codeVerifier: VERIFIER,
    clientId: request.clientId, redirectUri: request.redirectUri };
  const issued = context.authorizations.exchange(exchange);
  if (issued.status !== "issued") throw new Error("exchange failed");
  return { ...issued, exchange, grantId: context.authorizations.getAccessToken(issued.accessToken)!.grantId };
}

async function rig() {
  const context = state();
  const control = await startMcpChannel({ path: PATH, ...context });
  stops.push(() => control.stop());
  return { ...context, control };
}

function raw(path: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    sockets.add(socket);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline >= 0) { resolve(JSON.parse(input.slice(0, newline))); socket.destroy(); }
    });
  });
}

async function fakeHub(handle: (socket: Socket) => void): Promise<Server> {
  mkdirSync("private", { recursive: true, mode: 0o700 });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    handle(socket);
  });
  server.listen(PATH);
  await once(server, "listening");
  stops.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return server;
}

describe("private MCP hub channel", () => {
  it("reads each token's current state and scope, including a narrowed refresh-issued token, without issuing credentials", async () => {
    const context = await rig();
    const token = issue(context);
    const positive = { status: "positive", grantId: token.grantId, principal: PRINCIPAL, workspace: WORKSPACE,
      scope: "docs:read docs:write", expiresAt: context.clock.now + 3_600_000 };
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual(positive);
    const refreshed = context.authorizations.refresh({ refreshToken: token.refreshToken, clientId: "registered-agent", scope: "docs:read" });
    if (refreshed.status !== "issued") throw new Error("refresh failed");
    expect(await introspectMcpToken(PATH, refreshed.accessToken)).toEqual({ ...positive, scope: "docs:read" });
    expect(context.database.connection.prepare("SELECT COUNT(*) AS count FROM hub_credentials").get()?.count).toBe(0);
    context.grants.revoke(token.grantId);
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual({ status: "negative" });
    expect(await introspectMcpToken(PATH, refreshed.accessToken)).toEqual({ status: "negative" });
  });

  it("restores the same unexpired token after membership or suspension changes without mutating token or grant state", async () => {
    const context = await rig();
    const token = issue(context);
    const snapshot = () => ({ tokens: context.database.connection.prepare("SELECT * FROM hub_oauth_access_tokens").all(),
      grants: context.database.connection.prepare("SELECT * FROM hub_agent_grants").all() });
    const before = snapshot();
    context.memberships.remove({ principalId: PRINCIPAL, workspaceId: WORKSPACE });
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual({ status: "negative" });
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    expect(await introspectMcpToken(PATH, token.accessToken)).toHaveProperty("status", "positive");
    context.admins.setWorkspaceStatus(WORKSPACE, "suspended");
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual({ status: "negative" });
    context.admins.setWorkspaceStatus(WORKSPACE, "active");
    expect(await introspectMcpToken(PATH, token.accessToken)).toHaveProperty("status", "positive");
    expect(snapshot()).toEqual(before);
  });

  it("gives the same negative answer for unknown, malformed, expired and revoked access tokens", async () => {
    const context = await rig();
    const token = issue(context);
    const negative = { status: "negative" };
    expect(await introspectMcpToken(PATH, "unknown-token")).toEqual(negative);
    expect(await introspectMcpToken(PATH, "\nmalformed-presented-token\0")).toEqual(negative);
    context.clock.now += 3_600_000;
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual(negative);
    context.clock.now = 1000;
    context.authorizations.exchange(token.exchange);
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual(negative);
  });

  it("issues exactly the existing grant credential, refusing unknown, revoked and removed-member grants", async () => {
    const context = await rig();
    const token = issue(context);
    const pair = generateTestCredentialKeyPair();
    const issueForGrant = vi.spyOn(context.credentials, "issueForGrant");
    const record = await requestMcpCredential(PATH, token.grantId, pair.publicKey);
    expect(issueForGrant).toHaveBeenCalledExactlyOnceWith(token.grantId, Buffer.from(pair.publicKey));
    expect(record).toEqual(issueForGrant.mock.results[0]!.value.record);
    expect(record?.ceiling).toEqual({ grantId: token.grantId, workspaceId: WORKSPACE, scope: "read-write" });
    const before = context.database.connection.prepare("SELECT * FROM hub_credentials").all();
    expect(await requestMcpCredential(PATH, crypto.randomUUID(), pair.publicKey)).toBeNull();
    context.memberships.remove({ principalId: PRINCIPAL, workspaceId: WORKSPACE });
    expect(await requestMcpCredential(PATH, token.grantId, pair.publicKey)).toBeNull();
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    context.grants.revoke(token.grantId);
    expect(await requestMcpCredential(PATH, token.grantId, pair.publicKey)).toBeNull();
    expect(context.database.connection.prepare("SELECT * FROM hub_credentials").all()).toEqual(before);
  });

  it("refuses every extra issuance field and invalid public key without invoking issuance", async () => {
    const context = await rig();
    const token = issue(context);
    const issueForGrant = vi.spyOn(context.credentials, "issueForGrant");
    const request = { action: "issue-credential", grantId: token.grantId, publicKey: Buffer.from(generateTestCredentialKeyPair().publicKey).toString("base64url") };
    for (const field of ["token", "principal", "workspace", "scope", "unexpected"]) {
      const response = await raw(PATH, { ...request, [field]: token.accessToken });
      expect(response).toEqual({ status: "invalid-request" });
      expect(JSON.stringify(response)).not.toContain(token.accessToken);
    }
    for (const publicKey of ["", "a".repeat(42), "a".repeat(44), "a".repeat(43), [1, 2, 3]]) {
      expect(await raw(PATH, { ...request, publicKey })).not.toHaveProperty("status", "issued");
    }
    expect(issueForGrant).not.toHaveBeenCalled();
    expect(context.database.connection.prepare("SELECT COUNT(*) AS count FROM hub_credentials").get()?.count).toBe(0);
  });

  it("requires a private owned directory and a non-symlink socket path, and bounds the socket name", async () => {
    const context = state();
    mkdirSync("private", { mode: 0o750 });
    await expect(startMcpChannel({ path: PATH, ...context })).rejects.toThrow("no group or other access");
    chmodSync("private", 0o700);
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(startMcpChannel({ path: PATH, ...context })).rejects.toThrow("owned by the hub user");
    getuid.mockRestore();
    writeFileSync(PATH, "keep me");
    await expect(startMcpChannel({ path: PATH, ...context })).rejects.toThrow("not a socket");
    rmSync(PATH);
    symlinkSync("target.sock", PATH);
    await expect(startMcpChannel({ path: PATH, ...context })).rejects.toThrow("not a socket");
    rmSync(PATH);
    symlinkSync("private", "alias");
    await expect(startMcpChannel({ path: "alias/mcp.sock", ...context })).rejects.toThrow("socket directory");
    await expect(startMcpChannel({ path: `private/${"x".repeat(104)}`, ...context })).rejects.toThrow("103 bytes");
    const channel = await startMcpChannel({ path: PATH, ...context });
    stops.push(() => channel.stop());
    expect(lstatSync("private").mode & 0o077).toBe(0);
    expect(lstatSync(PATH).mode & 0o777).toBe(0o600);
  });

  it("preserves another live hub's socket and fences idle requests when stopped", async () => {
    const context = await rig();
    const token = issue(context);
    const inode = lstatSync(PATH).ino;
    await expect(startMcpChannel({ path: PATH, ...context })).rejects.toThrow("another hub owns");
    expect(lstatSync(PATH).ino).toBe(inode);
    expect(await introspectMcpToken(PATH, token.accessToken)).toHaveProperty("status", "positive");
    const socket = createConnection(PATH);
    sockets.add(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write('{"action":"issue-credential"');
    const issuance = vi.spyOn(context.credentials, "issueForGrant");
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await context.control.stop();
    await closed;
    expect(issuance).not.toHaveBeenCalled();
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual({ status: "unavailable" });
  });

  it("recovers a stale socket left by a process that exited without closing its listener", async () => {
    mkdirSync("private", { mode: 0o700 });
    const child = spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen('private/mcp.sock', () => process.exit(0))"], { timeout: 5000 });
    expect(child.status).toBe(0);
    expect(lstatSync(PATH).isSocket()).toBe(true);
    const context = state();
    const channel = await startMcpChannel({ path: PATH, ...context });
    stops.push(() => channel.stop());
    expect(await introspectMcpToken(PATH, "unknown-token")).toEqual({ status: "negative" });
  });

  it("keeps presented tokens out of error replies when a registry fails", async () => {
    const context = await rig();
    const token = issue(context);
    vi.spyOn(context.authorizations, "getAccessToken").mockImplementation(() => { throw new Error(token.accessToken); });
    expect(await raw(PATH, { action: "introspect", token: token.accessToken })).toEqual({ status: "failed" });
    expect(await introspectMcpToken(PATH, token.accessToken)).toEqual({ status: "unavailable" });
  });

  it("returns unavailable on missing, refused or dropped connections", async () => {
    expect(await introspectMcpToken(PATH, "private-token")).toEqual({ status: "unavailable" });
    mkdirSync("private", { mode: 0o700 });
    writeFileSync(PATH, "not a listener");
    expect(await introspectMcpToken(PATH, "private-token")).toEqual({ status: "unavailable" });
    rmSync(PATH);
    await fakeHub(socket => socket.destroy());
    expect(await introspectMcpToken(PATH, "private-token")).toEqual({ status: "unavailable" });
  });

  it.each(["{private-token}\n", "{}\n", '{"status":"negative","token":"private-token"}\n',
    '{"status":"positive","grantId":"g","principal":"p","workspace":"wrong","scope":"docs:read","expiresAt":42}\n',
    `${"x".repeat(65_537)}\n`])("rejects malformed or oversized replies without exposing request data", async reply => {
    await fakeHub(socket => socket.once("data", () => socket.end(reply)));
    expect(await introspectMcpToken(PATH, "private-token")).toEqual({ status: "unavailable" });
    await expect(requestMcpCredential(PATH, "private-token", new Uint8Array(32))).rejects.toThrow(/^hub MCP channel unavailable$/);
  });

  it("enforces an absolute round-trip deadline even while reply bytes arrive", async () => {
    let peer: Socket | undefined;
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    await fakeHub(socket => { peer = socket; socket.once("data", received); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = introspectMcpToken(PATH, "private-token");
    await ready;
    await vi.advanceTimersByTimeAsync(MCP_SOCKET_TIMEOUT_MS - 1);
    peer!.write("{");
    await vi.advanceTimersByTimeAsync(1);
    expect(await response).toEqual({ status: "unavailable" });
  });

  it("wires only the configured private socket into a team hub and exposes no TCP operation", async () => {
    const config = resolveCoreHubConfig({ HUB_HOST: "127.0.0.1", HUB_AUTH_TOKEN: "local-secret", HUB_MCP_SOCKET: PATH }, ":memory:");
    expect(config.mcpSocketPath).toBe(PATH);
    expect(resolveCoreHubConfig({ HUB_HOST: "127.0.0.1", HUB_AUTH_TOKEN: "local-secret" }, ":memory:")).not.toHaveProperty("mcpSocketPath");
    const hub = await createTeamHub({ ...config, port: 0, publicUrl: "https://hub.example", github: { clientId: "Iv23AbCdEF0123456789" }, log: () => {} });
    stops.push(() => hub.stop());
    expect(await introspectMcpToken(PATH, "unknown-token")).toEqual({ status: "negative" });
    const baseline = await fetch(`http://127.0.0.1:${hub.port}/unrelated-route`, { method: "POST" });
    const baselineText = await baseline.text();
    for (const path of ["/introspect", "/issue-credential", "/mcp/introspect", "/mcp/issue-credential"]) {
      const reply = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
        method: "POST", body: JSON.stringify({ action: "introspect", token: "private-token" }), headers: { "content-type": "application/json" },
      });
      expect(reply.status).toBe(baseline.status);
      expect(await reply.text()).toBe(baselineText);
    }
    await hub.stop();
    expect(await introspectMcpToken(PATH, "unknown-token")).toEqual({ status: "unavailable" });
  });
});

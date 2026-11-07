import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { AgentGrantRegistry } from "../../hub/src/agent-grants.js";
import { CredentialRegistry } from "../../hub/src/credentials.js";
import { HubAdminRegistry } from "../../hub/src/hub-admins.js";
import { startMcpChannel } from "../../hub/src/mcp-channel.js";
import { MembershipRegistry } from "../../hub/src/memberships.js";
import { OAuthAuthorizations } from "../../hub/src/oauth-authorizations.js";
import { HubDatabase } from "../../hub/src/persistence.js";
import { PrincipalRegistry } from "../../hub/src/principals.js";
import { createTeamHub } from "../../hub/src/team.js";
import { WorkspaceNameReader } from "../../hub/src/workspace-names.js";
import { HOST_GRANT_CHECK_INTERVAL_MS } from "../src/host-grants.js";
import { createMcpHost } from "../src/http-host.js";
import * as runtimeServer from "../src/server.js";
import { MirrorStore, readStoredSyncStatus } from "../src/store.js";
import { cleanupTestResources, tempDir, waitUntil, WORKSPACE } from "./shared.js";

const hosts: ReturnType<typeof createMcpHost>[] = [];
const channels: Awaited<ReturnType<typeof startMcpChannel>>[] = [];
const databases: HubDatabase[] = [];
const teamHubs: Awaited<ReturnType<typeof createTeamHub>>[] = [];
const clients: Client[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  try {
    await cleanupTestResources({
      clients: clients.splice(0).map(client => () => client.close()),
      peers: hosts.splice(0).map(host => () => host.close()),
      hubs: [...channels.splice(0).map(channel => () => channel.stop()), ...teamHubs.splice(0).map(hub => () => hub.stop())],
      after: [...databases.splice(0).map(database => () => database.close()), async () => { await Promise.allSettled(pending.splice(0)); }],
    });
  } finally { vi.restoreAllMocks(); }
});

async function fixture(sync = false) {
  const directory = tempDir();
  const databasePath = sync ? join(tempDir(), "hub.sqlite") : ":memory:";
  const database = new HubDatabase(databasePath, error => { throw error; });
  database.open();
  databases.push(database);
  const principals = new PrincipalRegistry(database);
  const person = principals.identify("1234", "hosted-person");
  const administrator = principals.identify("5678", "workspace-admin");
  const memberships = new MembershipRegistry(database);
  memberships.grant({ workspaceId: WORKSPACE, principalId: administrator.id, role: "admin" });
  memberships.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "member" });
  const admins = new HubAdminRegistry(database);
  const credentials = new CredentialRegistry(database, admins);
  const grants = new AgentGrantRegistry(database);
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), credentials);
  const socket = join(tempDir(), "private", "mcp.sock");
  const team = sync ? await createTeamHub({ databasePath, port: 0, address: "127.0.0.1", authSecret: "test-local-secret",
    mcpSocketPath: socket, publicUrl: "https://hub.example", github: { clientId: "Iv23AbCdEF0123456789" },
    debounce: 10, maxDebounce: 50, log: () => {} }, { deviceCredentials: true }) : undefined;
  if (team !== undefined) teamHubs.push(team);
  else channels.push(await startMcpChannel({ path: socket, principals, admins, credentials, grants, authorizations }));

  function grant(workspace = WORKSPACE) {
    return grants.create({ clientId: "hosted-client", clientName: "Hosted client", principalId: person.id,
      workspaceId: workspace, scope: "read-write" });
  }

  function files(grantId: string, workspace = WORKSPACE) {
    const hash = createHash("sha256").update(grantId).digest("hex");
    const mirrorDirectory = join(directory, hash);
    return { mirrorDirectory, mirror: join(mirrorDirectory, `${workspace}.sqlite`),
      key: join(directory, "keys", `${hash}.json`), manifest: join(directory, "grants", `${hash}.json`) };
  }

  function seed(grantId: string, options: { pending?: boolean; workspace?: string } = {}) {
    const workspace = options.workspace ?? WORKSPACE;
    const paths = files(grantId, workspace);
    mkdirSync(join(directory, "keys"), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "grants"), { recursive: true, mode: 0o700 });
    const metadata = JSON.stringify({ grantId, workspace });
    writeFileSync(paths.key, metadata, { mode: 0o600 });
    writeFileSync(paths.manifest, metadata, { mode: 0o600 });
    const store = new MirrorStore(paths.mirror, workspace);
    const doc = new Y.Doc();
    try {
      doc.getText("content").insert(0, "kept until acknowledged");
      store.appendUpdate(`${workspace}/pending-document`, Y.encodeStateAsUpdate(doc), options.pending ? "local" : "remote");
    } finally {
      doc.destroy();
      store.close();
    }
    return paths;
  }

  function start() {
    const host = createMcpHost({ issuer: undefined, allowedOrigins: [], hubUrl: `ws://127.0.0.1:${team?.port ?? 1}`,
      databaseDirectory: directory, hubMcpSocket: socket });
    hosts.push(host);
    return host;
  }

  function token() {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const request = { clientId: "hosted-client", clientName: "Hosted client", redirectUri: "https://client.example/callback",
      state: null, codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      resource: `https://hub.example/mcp/${WORKSPACE}`, workspaceId: WORKSPACE, writeRequested: true };
    const approved = authorizations.submit({ requestId: authorizations.create(request)!, decision: "approve",
      accessLevel: "read-write" }, person.id);
    if (approved.status !== "approved") throw new Error("Grant approval failed");
    const issued = authorizations.exchange({ code: new URL(approved.redirectUrl).searchParams.get("code")!,
      codeVerifier: verifier, clientId: request.clientId, redirectUri: request.redirectUri });
    if (issued.status !== "issued") throw new Error("Grant token exchange failed");
    return { value: issued.accessToken, grantId: authorizations.getAccessToken(issued.accessToken)!.grantId };
  }

  return { directory, database, person, memberships, admins, credentials, grants, grant, files, seed, start, token };
}

function expectKept(paths: { key: string; mirror: string; manifest: string }) {
  expect(existsSync(paths.key)).toBe(true);
  expect(existsSync(paths.mirror)).toBe(true);
  expect(existsSync(paths.manifest)).toBe(true);
}

function expectRemoved(paths: { key: string; mirrorDirectory: string; manifest: string }) {
  expect(existsSync(paths.key)).toBe(false);
  expect(existsSync(paths.mirrorDirectory)).toBe(false);
  expect(existsSync(paths.manifest)).toBe(false);
}

async function connect(host: ReturnType<typeof createMcpHost>, token: string) {
  await host.ready;
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Host has no TCP listener");
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${WORKSPACE}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "host-grant-client", version: "1" });
  clients.push(client);
  await client.connect(transport as Transport);
  return client;
}

it("serves a real approved grant through production credentials and keeps its key across a host restart", async () => {
  const rig = await fixture(true);
  const token = rig.token();
  const paths = rig.files(token.grantId);
  const firstHost = rig.start();
  const first = await connect(firstHost, token.value);
  const created = await first.callTool({ name: "create_doc", arguments: {
    title: "Persistent hosted connection", description: "The production host retains its grant's credential.",
    blocks: [{ type: "paragraph", text: "received by the hub" }],
  } });
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  await waitUntil("the production grant's authenticated update to reach the hub", async () => {
    const status = await first.callTool({ name: "sync_status", arguments: {} });
    return (status.structuredContent as { unsyncedChanges?: number }).unsyncedChanges === 0;
  });
  expectKept(paths);
  const before = readFileSync(paths.key, "utf8");
  const publicRows = rig.database.connection.prepare("SELECT id, replaced_at, revoked_at FROM hub_credentials").all();
  expect(publicRows).toHaveLength(1);
  await first.close();
  await firstHost.close();

  const secondHost = rig.start();
  const restarted = await connect(secondHost, token.value);
  const uuid = (created.structuredContent as { uuid: string }).uuid;
  const read = await restarted.callTool({ name: "get_doc", arguments: { uuid } });
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent).toMatchObject({ title: "Persistent hosted connection" });
  expect(readFileSync(paths.key, "utf8")).toBe(before);
  expect(rig.database.connection.prepare("SELECT id, replaced_at, revoked_at FROM hub_credentials").all()).toEqual(publicRows);
  await waitUntil("the restarted grant's mirror to hold only acknowledged changes", () =>
    readStoredSyncStatus(paths.mirror, WORKSPACE).pendingRooms.length === 0);
  const grant = rig.grants.get(token.grantId)!;
  expect(rig.credentials.revokeDevice(grant.principalId, grant.deviceId)).toBe(true);
  await secondHost.sweepGrants();
  expectRemoved(paths);
  await expect(restarted.listTools()).rejects.toThrow();
});

it("drains an admitted mutation before deciding whether a revoked grant's mirror can be deleted", async () => {
  const rig = await fixture(true);
  const token = rig.token();
  const paths = rig.files(token.grantId);
  let runtime!: runtimeServer.UberblickMcpRuntime;
  let sessionClosed!: { mock: { calls: unknown[] } };
  const createRuntime = runtimeServer.createMcpRuntime;
  vi.spyOn(runtimeServer, "createMcpRuntime").mockImplementation((config, options) => {
    runtime = createRuntime(config, options);
    const open = runtime.openSession;
    vi.spyOn(runtime, "openSession").mockImplementation(() => {
      const session = open();
      sessionClosed = vi.spyOn(session, "close");
      return session;
    });
    return runtime;
  });
  const host = rig.start();
  const client = await connect(host, token.value);
  const created = await client.callTool({ name: "create_doc", arguments: {
    title: "Before revocation", description: "An admitted call may finish while cleanup drains it.",
  } });
  expect(created.isError).not.toBe(true);
  await waitUntil("the initial mutation to reach the hub", () => runtime.store.pendingRooms().length === 0);
  const uuid = (created.structuredContent as { uuid: string }).uuid;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async () => { enter(); await held; });
  const mutation = client.callTool({ name: "set_metadata", arguments: { uuid, title: "Finished after revocation" } })
    .catch((error: unknown) => error);
  pending.push(mutation);
  await entered;
  const storeClosed = vi.spyOn(runtime.store, "close");
  const grant = rig.grants.get(token.grantId)!;
  rig.credentials.revokeDevice(grant.principalId, grant.deviceId);
  const sweeping = host.sweepGrants();
  pending.push(sweeping);
  await waitUntil("cleanup to begin draining the admitted session", () => sessionClosed.mock.calls.length > 0);
  expect(storeClosed).not.toHaveBeenCalled();
  expect(runtime.store.pendingRooms()).toEqual([]);
  release();
  await sweeping;
  await client.close();
  await mutation;
  expect(storeClosed).toHaveBeenCalledTimes(1);
  expectKept(paths);
  expect(readStoredSyncStatus(paths.mirror, WORKSPACE).pendingRooms.length).toBeGreaterThan(0);
});

it("removes ended grants at startup without opening sessions, retaining inaccessible grants", async () => {
  const rig = await fixture();
  const revoked = rig.grant();
  const revokedFiles = rig.seed(revoked.id);
  rig.grants.revoke(revoked.id);
  const unknownFiles = rig.seed(randomUUID());
  const removedMember = rig.grant();
  const memberFiles = rig.seed(removedMember.id);
  rig.memberships.remove({ workspaceId: WORKSPACE, principalId: rig.person.id });
  const suspendedWorkspace = randomUUID();
  rig.memberships.grant({ workspaceId: suspendedWorkspace, principalId: rig.person.id, role: "member" });
  const suspended = rig.grant(suspendedWorkspace);
  const suspendedFiles = rig.seed(suspended.id, { workspace: suspendedWorkspace });
  rig.admins.setWorkspaceStatus(suspendedWorkspace, "suspended");

  const host = rig.start();
  await host.ready;
  expectRemoved(revokedFiles);
  expectRemoved(unknownFiles);
  expectKept(memberFiles);
  expectKept(suspendedFiles);

  rig.memberships.grant({ workspaceId: WORKSPACE, principalId: rig.person.id, role: "member" });
  rig.admins.setWorkspaceStatus(suspendedWorkspace, "active");
  await host.sweepGrants();
  expectKept(memberFiles);
  expectKept(suspendedFiles);
  expect(rig.grants.isLive(removedMember.id)).toBe(true);
  expect(rig.grants.isLive(suspended.id)).toBe(true);
});

it("keeps every ended-grant file while a closed mirror has unacknowledged changes", async () => {
  const rig = await fixture();
  const grant = rig.grant();
  const paths = rig.seed(grant.id, { pending: true });
  rig.grants.revoke(grant.id);
  const host = rig.start();
  await host.ready;
  expectKept(paths);
  expect(readStoredSyncStatus(paths.mirror, WORKSPACE).pendingRooms).toHaveLength(1);

  const store = new MirrorStore(paths.mirror, WORKSPACE);
  try {
    for (const pending of store.pendingRooms()) store.clearPending(pending.room, pending.seq);
  } finally { store.close(); }
  await host.sweepGrants();
  expectRemoved(paths);
});

it("finds a revoked mirror after the whole key directory is lost", async () => {
  const rig = await fixture();
  const grant = rig.grant();
  const paths = rig.seed(grant.id);
  rmSync(join(rig.directory, "keys"), { recursive: true });
  rig.grants.revoke(grant.id);
  const host = rig.start();
  await host.ready;
  expectRemoved(paths);
});

it("checks for revocation on a fixed interval even when no session is open", async () => {
  const rig = await fixture();
  const grant = rig.grant();
  const paths = rig.seed(grant.id);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const host = rig.start();
  await host.ready;
  expectKept(paths);
  rig.grants.revoke(grant.id);
  await vi.advanceTimersByTimeAsync(HOST_GRANT_CHECK_INTERVAL_MS);
  await waitUntil("the scheduled grant check to remove its ended mirror", () => !existsSync(paths.mirrorDirectory));
  expectRemoved(paths);
});

it("preserves an ended mirror when its durable pending state cannot be read", async () => {
  const rig = await fixture();
  const grant = rig.grant();
  const paths = rig.seed(grant.id);
  writeFileSync(paths.mirror, "unreadable mirror database");
  rig.grants.revoke(grant.id);
  const host = rig.start();
  await host.ready;
  expectKept(paths);
});

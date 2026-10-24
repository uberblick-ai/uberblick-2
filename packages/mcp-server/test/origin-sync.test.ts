/** Device-authenticated delivery preserves authorship independently of the relay. */
import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { encodeOriginUpdate, readOriginUpdate, roomForDoc, type UpdateOriginMetadata } from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { writeHubLogin, type StoredHubLogin } from "@uberblick/mcp-server/auth-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HubConnection } from "../src/hub-connection.js";
import { renewDeviceCredential } from "../src/device-login.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { MirrorStore } from "../src/store.js";
import { resolveMcpConfig, type McpConfig } from "../src/config.js";
import { cleanupTestResources, LIVE_HUB_SETTLE, startServer, tempDatabasePath, tempDir, testConfig, waitUntil, WORKSPACE } from "./helpers.js";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const clients: Array<() => unknown> = [];
const proxies: Array<() => Promise<void>> = [];
const hubs: DeviceHub[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: clients.splice(0),
    peers: proxies.splice(0),
    hubs: hubs.splice(0).map(hub => () => hub.close()),
  });
});

async function delayedHub(fixture: DeviceHub): Promise<{ url: string; origin: string }> {
  const sockets = new Set<Socket>();
  const delays = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  const server = createServer(downstream => {
    const upstream = connect(fixture.port, "127.0.0.1");
    for (const [source, destination] of [[downstream, upstream], [upstream, downstream]] as const) {
      sockets.add(source);
      source.setNoDelay();
      source.on("error", () => destination.destroy());
      source.on("close", () => { sockets.delete(source); destination.destroy(); });
      source.on("data", chunk => {
        if (closed) return;
        const delay = setTimeout(() => {
          delays.delete(delay);
          if (!destination.destroyed) destination.write(chunk);
        }, 20);
        delays.add(delay);
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  proxies.push(async () => {
    closed = true;
    for (const delay of delays) clearTimeout(delay);
    delays.clear();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("delayed hub did not listen on TCP");
  return { url: `ws://127.0.0.1:${address.port}`, origin: `http://127.0.0.1:${address.port}` };
}

async function hub(): Promise<DeviceHub> {
  const fixture = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(fixture);
  fixture.grant(WORKSPACE);
  return fixture;
}

async function wireClient(fixture: DeviceHub, room: string, login: StoredHubLogin, protocolVersion = SYNC_PROTOCOL_VERSION) {
  const key = await importCredentialKey(Buffer.from(login.credential.key, "base64url"));
  const token = wrapToken(await mintToken(key, {
    typ: "room", sub: `session-${randomUUID()}`, workspace: WORKSPACE, scope: "read-write",
    kid: login.credential.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  }), protocolVersion);
  const connection = new HubConnection(1_500);
  const doc = new Y.Doc();
  const refusals: string[] = [];
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({ url: fixture.url, WebSocketPolyfill: connection.websocket() }),
    name: room, token, document: doc,
    onAuthenticationFailed({ reason }) { refusals.push(reason); },
  });
  let synced = false;
  provider.on("synced", () => { synced = true; });
  provider.attach();
  clients.push(async () => {
    await connection.close(() => { provider.destroy(); provider.configuration.websocketProvider.destroy(); });
    doc.destroy();
  });
  return { provider, refusals, synced: () => synced };
}

function origin(login: StoredHubLogin, name: string): UpdateOriginMetadata {
  return { updateId: randomUUID(), credentialId: login.credential.record.id, surface: { kind: "mcp", name } };
}

function remoteConfig(fixture: DeviceHub, env: NodeJS.ProcessEnv, databasePath = tempDatabasePath()): McpConfig {
  return { ...testConfig({ ...LIVE_HUB_SETTLE, hubUrl: fixture.url, databasePath }), deviceLogin: { env } };
}

function workspace(config: McpConfig, surface: { kind: string; name: string }) {
  const workspace = openWorkspaceReplicas(config, { publishOwnPresence: false });
  workspace.replicas.setWriteSurface(surface);
  clients.push(() => workspace.close());
  return workspace;
}

describe("per-update origin on the authenticated wire", () => {
  it("delivers a fresh short-lived writer within the default budget after 200 acknowledged rows at 40 ms RTT", async () => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(fixture.origin, login, env);
    const initial = workspace(remoteConfig(fixture, env), { kind: "mcp", name: "Claude Code" });
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    const replica = initial.replicas.replica(uuid);
    for (let index = 0; index < 200; index += 1) replica.doc.getMap("values").set(`acknowledged-${index}`, index);
    expect(await initial.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(initial.store.pendingRooms()).toEqual([]);
    expect(initial.store.updateCount(room)).toBe(200);
    const databasePath = initial.store.databasePath;
    const acknowledgedIds = new Set(initial.store.updatesAfter(room, 0).map(row => row.metadata?.updateId));
    await initial.close();

    const proxy = await delayedHub(fixture);
    await writeHubLogin(proxy.origin, login, env);
    const config = {
      ...resolveMcpConfig({ ...env, WORKSPACE_ID: WORKSPACE, HUB_URL: proxy.url, UBERBLICK_DB: databasePath }),
      deviceLogin: { env },
    };
    const send = vi.spyOn(HocuspocusProvider.prototype, "sendStateless");
    try {
      const writer = workspace(config, { kind: "cli", name: "ub data" });
      await writer.replicas.settle();
      writer.replicas.replica(uuid).doc.getMap("values").set("new", "short-lived writer");
      expect(await writer.replicas.waitForSettled({ rooms: [room] })).toMatchObject({ caughtUp: true });
      expect(fixture.readRoom(room, doc => doc.getMap("values").get("new"))).toBe("short-lived writer");
      const sentIds = send.mock.calls.map(([payload]) => readOriginUpdate(payload)?.updateId);
      expect(sentIds.some(id => acknowledgedIds.has(id))).toBe(false);
      expect(writer.store.pendingRooms()).toEqual([]);
      await writer.close();
    } finally { send.mockRestore(); }
  });

  it("delivers a burst of exact authored rows within the default budget at 40 ms RTT", async () => {
    const fixture = await hub();
    const proxy = await delayedHub(fixture);
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(proxy.origin, login, env);
    const config = {
      ...resolveMcpConfig({ ...env, WORKSPACE_ID: WORKSPACE, HUB_URL: proxy.url, UBERBLICK_DB: tempDatabasePath() }),
      deviceLogin: { env },
    };
    const writer = workspace(config, { kind: "browser", name: "browser" });
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    const replica = writer.replicas.replica(uuid);
    expect(await writer.replicas.waitForSettled({ rooms: [room] })).toMatchObject({ caughtUp: true });
    for (let index = 0; index < 200; index += 1) replica.doc.getMap("values").set(`burst-${index}`, index);
    const rows = writer.store.updatesAfter(room, 0);
    expect(rows).toHaveLength(200);
    expect(await writer.replicas.waitForSettled({ rooms: [room] })).toMatchObject({ caughtUp: true });
    expect(fixture.readRoom(room, doc => doc.getMap("values").size)).toBe(200);
    expect(fixture.changes.filter(change => change.room === room).map(change => change.attribution?.updateId))
      .toEqual(rows.map(row => row.metadata?.updateId));
    expect(fixture.changes.filter(change => change.room === room).every(change =>
      change.attribution?.author?.principalId === login.identity.id &&
      change.attribution.author.surface.kind === "browser")).toBe(true);
  });

  it("repairs a missing acknowledged prefix and cached remote tail before replaying pending authored rows", async () => {
    const firstHub = await hub();
    const firstLogin = firstHub.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(firstHub.origin, firstLogin, env);
    const initial = workspace(remoteConfig(firstHub, env), { kind: "mcp", name: "Claude Code" });
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    initial.replicas.replica(uuid).doc.getText("text").insert(0, "acknowledged");
    expect(await initial.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const databasePath = initial.store.databasePath;
    await initial.close();

    const cached = new MirrorStore(databasePath, WORKSPACE);
    const remote = new Y.Doc();
    try {
      remote.getMap("values").set("downloaded", "cached remote tail");
      cached.appendUpdate(room, Y.encodeStateAsUpdate(remote), "remote");
    } finally { cached.close(); remote.destroy(); }

    const replacementHub = await hub();
    replacementHub.grant(WORKSPACE, firstLogin.identity.id);
    const replacementLogin = replacementHub.issue({ workspaces: [WORKSPACE], principalId: firstLogin.identity.id });
    await writeHubLogin(replacementHub.origin, replacementLogin, env);
    const writer = workspace(remoteConfig(replacementHub, env, databasePath), { kind: "cli", name: "ub data" });
    writer.replicas.replica(uuid).doc.getText("text").insert(12, " then pending");
    const pendingId = writer.store.updatesAfter(room, 0).at(-1)?.metadata?.updateId;
    expect(pendingId).toBeDefined();
    expect(await writer.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(replacementHub.readRoom(room, doc => doc.getText("text").toString())).toBe("acknowledged then pending");
    expect(replacementHub.readRoom(room, doc => doc.getMap("values").get("downloaded"))).toBe("cached remote tail");
    const changes = replacementHub.changes.filter(change => change.room === room);
    expect(changes[0]?.attribution?.author).toBeNull();
    expect(changes.find(change => change.attribution?.updateId === pendingId)?.attribution?.author).toEqual({
      principalId: replacementLogin.identity.id, surface: { kind: "cli", name: "ub data" },
    });
  });

  it.each(["revocation", "membership removal"] as const)("refuses a queued stateless update when %s ends current access", async kind => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const room = roomForDoc(WORKSPACE, randomUUID());
    const peer = await wireClient(fixture, room, login);
    await waitUntil("the admitted sender to sync", peer.synced);
    const source = new Y.Doc();
    const gate = fixture.holdNextMessage(room);
    try {
      const metadata = origin(login, "Claude Code");
      source.getMap("values").set("refused", "must stay local");
      peer.provider.sendStateless(encodeOriginUpdate(metadata.updateId, Y.encodeStateAsUpdate(source), metadata));
      await gate.entered;
      if (kind === "revocation") fixture.revoke(login.credential.record.id);
      else fixture.removeMembership(WORKSPACE);
      gate.release();
      await waitUntil("the queued stateless update to recheck current authority", () => fixture.logs.some(record =>
        record.event === "hub.auth.rejected" && record.cause === (kind === "revocation" ? "revoked-credential" : "missing-membership")));
      expect(fixture.changes.some(change => change.attribution?.updateId === metadata.updateId)).toBe(false);
      expect(fixture.readRoom(room, doc => doc.getMap("values").get("refused"))).toBeUndefined();
    } finally {
      gate.release();
      source.destroy();
    }
  });

  it.each([
    { name: "claude-code", title: "Claude Code", expected: "Claude Code" },
    { name: "name-only-client", expected: "name-only-client" },
  ])("keeps MCP surface $expected as the same author across new sessions", async clientInfo => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(fixture.origin, login, env);
    const config = remoteConfig(fixture, env);
    const declared = { name: clientInfo.name, ...(clientInfo.title === undefined ? {} : { title: clientInfo.title }), version: "1" };
    const first = await startServer(config, undefined, declared);
    clients.push(() => first.close());
    const created = await first.ok("create_doc", { title: "Same author", description: "Session identity does not determine authorship." });
    expect(await first.instance.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    await first.close();
    const second = await startServer({ ...config, sessionId: `new-session-${randomUUID()}` }, undefined, declared);
    clients.push(() => second.close());
    await second.ok("set_metadata", { uuid: created.uuid, tldr: "Written in a later MCP session." });
    expect(await second.instance.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    const changes = fixture.changes.filter(change => change.room === roomForDoc(WORKSPACE, created.uuid));
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.every(change =>
      change.attribution?.author?.principalId === login.identity.id &&
      change.attribution.author.surface.kind === "mcp" && change.attribution.author.surface.name === clientInfo.expected)).toBe(true);
  });

  it.each(["account", "device"] as const)("leaves pending edits unknown after signing in with a new %s", async kind => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(fixture.origin, login, env);
    const config = remoteConfig(fixture, env);
    await fixture.pause();
    const writer = workspace(config, { kind: "browser", name: "browser" });
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    writer.replicas.replica(uuid).doc.getMap("values").set("pending", "from the previous sign-in");
    const metadata = writer.store.updatesAfter(room, 0)[0]?.metadata;
    expect(metadata?.credentialId).toBe(login.credential.record.id);
    await writer.close();
    const principalId = kind === "account" ? randomUUID() : login.identity.id;
    fixture.grant(WORKSPACE, principalId);
    const replacement = fixture.issue({ workspaces: [WORKSPACE], principalId });
    await writeHubLogin(fixture.origin, replacement, env);
    await fixture.resume();
    const relay = workspace({ ...config, sessionId: `after-sign-in-${randomUUID()}` }, { kind: "mcp", name: "Claude Code" });
    expect(await relay.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    expect(fixture.changes.find(change => change.attribution?.updateId === metadata?.updateId)?.attribution).toEqual({
      updateId: metadata?.updateId, author: null,
      deliveredBy: {
        principalId, credentialId: replacement.credential.record.id, deviceId: replacement.credential.record.deviceId,
      },
    });
  });

  it.each(["browser", "mcp"] as const)("relays browser and MCP offline edits through a %s process after compaction and credential renewal", async relayKind => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    await writeHubLogin(fixture.origin, login, env);
    const config = remoteConfig(fixture, env);
    const browser = workspace(config, { kind: "browser", name: "browser" });
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    const browserReplica = browser.replicas.replica(uuid);
    browserReplica.doc.getMap("values").set("baseline", "already acknowledged");
    expect(await browser.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    expect(browser.store.compact(room, Y.encodeStateAsUpdate(browserReplica.doc), browserReplica.lastSeq)).toBe(true);
    expect(browser.store.updateCount(room)).toBe(0);
    await fixture.pause();
    browserReplica.doc.getMap("values").set("browser", "written offline");
    const mcp = workspace({ ...config, sessionId: `mcp-peer-${randomUUID()}` }, { kind: "mcp", name: "Claude Code" });
    const mcpReplica = mcp.replicas.replica(uuid);
    expect(mcpReplica.doc.getMap("values").get("browser")).toBe("written offline");
    mcpReplica.doc.getMap("values").set("mcp", "peer append just before renewal");
    browser.replicas.refresh();
    const rows = browser.store.updatesAfter(room, 0);
    expect(rows.map(row => row.metadata?.surface)).toEqual([
      { kind: "browser", name: "browser" }, { kind: "mcp", name: "Claude Code" },
    ]);
    expect(browser.store.compact(room, Y.encodeStateAsUpdate(browserReplica.doc), browserReplica.lastSeq)).toBe(false);
    expect(browser.store.updatesAfter(room, 0)).toEqual(rows);
    await browser.close();
    await mcp.close();
    await fixture.resume();
    const renewal = await renewDeviceCredential(fixture.origin, login, false);
    expect(renewal).toHaveProperty("credential");
    if (typeof renewal !== "object" || !("credential" in renewal)) throw new Error("fixture renewal did not issue a credential");
    await writeHubLogin(fixture.origin, renewal, env);
    const relay = workspace({ ...config, sessionId: `relay-${randomUUID()}` }, {
      kind: relayKind, name: relayKind === "browser" ? "browser" : "Claude Code",
    });
    expect(await relay.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    expect(fixture.readRoom(room, doc => Object.fromEntries(doc.getMap("values")))).toEqual({
      baseline: "already acknowledged", browser: "written offline", mcp: "peer append just before renewal",
    });
    for (const row of rows) {
      expect(fixture.changes.find(change => change.attribution?.updateId === row.metadata?.updateId)?.attribution).toEqual({
        updateId: row.metadata?.updateId,
        author: { principalId: login.identity.id, surface: row.metadata?.surface },
        deliveredBy: {
          principalId: login.identity.id, credentialId: renewal.credential.record.id, deviceId: login.credential.record.deviceId,
        },
      });
    }
    expect(relay.store.pendingRooms()).toEqual([]);
    const relayReplica = relay.replicas.replica(uuid);
    expect(relay.store.compact(room, Y.encodeStateAsUpdate(relayReplica.doc), relayReplica.lastSeq)).toBe(true);
    const replaced = await wireClient(fixture, room, login);
    await waitUntil("the replaced key to be refused for room delivery", () => replaced.refusals.length > 0);
    expect(replaced.synced()).toBe(false);
  });

  it("downgrades missing, unknown, revoked, foreign-account and foreign-device origins while retaining the verified delivery account", async () => {
    const fixture = await hub();
    const delivering = fixture.issue({ workspaces: [WORKSPACE] });
    const deviceId = delivering.credential.record.deviceId;
    const revoked = fixture.issue({ workspaces: [WORKSPACE], deviceId });
    fixture.revoke(revoked.credential.record.id);
    const foreignAccount = fixture.issue({ workspaces: [WORKSPACE], principalId: randomUUID(), deviceId });
    const foreignDevice = fixture.issue({ workspaces: [WORKSPACE] });
    const room = roomForDoc(WORKSPACE, randomUUID());
    const peer = await wireClient(fixture, room, delivering);
    await waitUntil("the device-authenticated wire to sync", peer.synced);
    const source = new Y.Doc();
    try {
      const cases = [
        { label: "missing", metadata: null },
        { label: "unknown", metadata: { ...origin(delivering, "Claude Code"), credentialId: randomUUID() } },
        { label: "revoked", metadata: origin(revoked, "Claude Code") },
        { label: "foreign account", metadata: origin(foreignAccount, "Claude Code") },
        { label: "foreign device", metadata: origin(foreignDevice, "Claude Code") },
      ];
      for (const entry of cases) {
        const updateId = entry.metadata?.updateId ?? randomUUID();
        source.getMap("values").set("case", entry.label);
        peer.provider.sendStateless(encodeOriginUpdate(updateId, Y.encodeStateAsUpdate(source), entry.metadata));
        await waitUntil(`the hub to apply the ${entry.label} update`, () =>
          fixture.readRoom(room, doc => doc.getMap("values").get("case")) === entry.label);
        expect(fixture.changes.find(change => change.attribution?.updateId === updateId)?.attribution).toEqual({
          updateId, author: null,
          deliveredBy: {
            principalId: delivering.identity.id, credentialId: delivering.credential.record.id, deviceId,
          },
        });
      }
    } finally { source.destroy(); }
  });

  it("keeps the first applied attribution when an acknowledgement is lost and the exact update is replayed", async () => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const room = roomForDoc(WORKSPACE, randomUUID());
    const peer = await wireClient(fixture, room, login);
    await waitUntil("the replay sender to sync", peer.synced);
    const source = new Y.Doc();
    try {
      source.getArray("values").push(["one edit"]);
      const update = Y.encodeStateAsUpdate(source);
      const metadata = origin(login, "Claude Code");
      // Deliberately ignore the first acknowledgement, as a disconnected sender would.
      peer.provider.sendStateless(encodeOriginUpdate(metadata.updateId, update, metadata));
      await waitUntil("the original update to apply", () => fixture.changes.some(change => change.attribution?.updateId === metadata.updateId));
      const acknowledgements: string[] = [];
      peer.provider.on("stateless", ({ payload }: { payload: string }) => { acknowledgements.push(payload); });
      peer.provider.sendStateless(encodeOriginUpdate(metadata.updateId, update, {
        ...metadata, surface: { kind: "browser", name: "browser" },
      }));
      await waitUntil("the replay acknowledgement", () => acknowledgements.some(payload => payload.includes(metadata.updateId)));
      const applied = fixture.changes.filter(change => change.attribution?.updateId === metadata.updateId);
      expect(applied).toHaveLength(1);
      expect(applied[0]?.attribution?.author).toEqual({ principalId: login.identity.id, surface: metadata.surface });
      expect(fixture.readRoom(room, doc => doc.getArray("values").toArray())).toEqual(["one edit"]);
    } finally { source.destroy(); }
  });

  it("refuses protocol 6 and later syncs its legacy pending edits with unknown original author", async () => {
    const fixture = await hub();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    const room = roomForDoc(WORKSPACE, randomUUID());
    const peer = await wireClient(fixture, room, login, 6);
    await waitUntil("the old protocol refusal", () => peer.refusals.length > 0);
    expect(peer.refusals).toEqual([`protocol-mismatch:${SYNC_PROTOCOL_VERSION}`]);
    expect(peer.synced()).toBe(false);
    expect(fixture.changes.filter(change => change.room === room)).toEqual([]);
    const config = remoteConfig(fixture, { XDG_CONFIG_HOME: tempDir() });
    await writeHubLogin(fixture.origin, login, config.deviceLogin!.env);
    const legacy = new MirrorStore(config.databasePath, WORKSPACE);
    const source = new Y.Doc();
    try {
      source.getMap("values").set("legacy", "pending before upgrade");
      legacy.appendUpdate(room, Y.encodeStateAsUpdate(source), "local");
    } finally {
      legacy.close();
      source.destroy();
    }
    const upgraded = workspace(config, { kind: "mcp", name: "Updated MCP client" });
    expect(await upgraded.replicas.waitForSettled({ deadline: performance.now() + 20_000 })).toMatchObject({ caughtUp: true });
    expect(fixture.readRoom(room, doc => doc.getMap("values").get("legacy"))).toBe("pending before upgrade");
    expect(fixture.changes.filter(change => change.room === room).map(change => change.attribution)).toEqual([{
      updateId: expect.any(String), author: null,
      deliveredBy: {
        principalId: login.identity.id, credentialId: login.credential.record.id, deviceId: login.credential.record.deviceId,
      },
    }]);
  });
});

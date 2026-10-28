import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { getMeta, isDirectoryEntryArchived, roomForDoc } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { writeHubLogin } from "../src/auth-store.js";
import { createMcpEngine } from "../src/engine.js";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";
import { tryAcquireHistoryRefresherRole } from "../src/history-refresher-role.js";
import { acquireInitLock } from "../src/init-lock.js";
import { getDocumentRevision, listDocumentRevisions, mutateDocumentRevision } from "../src/revision-client.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startServer, tempDir, testConfig, waitUntil, WORKSPACE } from "./helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new Error(`History cache returned ${result.status}.`);
  return result.value;
}

function snapshotTitle(state: Uint8Array): string {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, state); return getMeta(doc).title; }
  finally { doc.destroy(); }
}

async function historyWorkspace() {
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: ":memory:",
    github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("Unexpected GitHub request."); }) },
    log() {},
  }, { deviceCredentials: true });
  hubs.push(() => hub.stop());
  if (hub.credentials === undefined || hub.memberships === undefined || hub.principals === undefined) {
    throw new Error("The team hub requires device authority.");
  }
  const principal = hub.principals.identify("12345", "history-author");
  hub.memberships.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
  const issued = issueCredential(hub.credentials, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  const root = tempDir();
  const env = { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, HOME: root };
  const endpoint = hubUrl(hub.port);
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: endpoint }], env, WORKSPACE); }
  finally { lock.release(); }
  const { replacedAt: _replacedAt, ...record } = issued.record;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: principal,
    credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
  }, env);
  const config = () => ({ ...testConfig({ hubUrl: endpoint, ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
  return { hub, credentials: hub.credentials, principals: hub.principals, memberships: hub.memberships,
    principal, issued, env, endpoint, config };
}

it("mirrors from an idle MCP server, hands cached history to a browser contender and retains it through device refusal", async () => {
  const { hub, credentials, issued, env, endpoint, config } = await historyWorkspace();
  const author = await startServer(config());
  clients.push(() => author.close());
  const live = await author.ok("create_doc", { title: "Never opened here", description: "History must arrive before a reader asks.",
    blocks: [{ type: "paragraph", text: "Earlier content" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: live.uuid, name: "Earlier" })).revision;
  const survivor = await author.ok("create_doc", { title: "Retained offline", description: "A second live page is mirrored too.",
    blocks: [{ type: "paragraph", text: "Keep this downloaded history" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const survivorRevision = (await author.ok("name_revision", { uuid: survivor.uuid, name: "Retained" })).revision;
  const archived = await author.ok("create_doc", { title: "Archived before bootstrap", description: "Do not attach this room in the background.",
    blocks: [{ type: "paragraph", text: "Already archived" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  await author.ok("name_revision", { uuid: archived.uuid, name: "Archived" });
  await author.ok("archive_doc", { uuid: archived.uuid });
  const decision = await author.ok("create_doc", { title: "Which history is mirrored?", description: "Decision records use their topic timeline.",
    kind: "decision", status: "decided", blocks: [{ type: "paragraph", text: "Mirror regular pages." }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const servingConfig = config();
  const reader = await startServer(servingConfig);
  clients.push(() => reader.close());
  const engine = reader.instance;
  const requested = vi.spyOn(engine.replicas.sync, "requestRevisions");
  const cache = new HistoryCache(servingConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const token = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  const catalog = (uuid: string) => ready(cache.readCatalog(token, uuid));
  const snapshot = (uuid: string, revision: string) => ready(cache.readSnapshot(token, uuid, revision));
  await waitUntil("all live pages' closed snapshots to arrive without reader calls", () =>
    snapshot(live.uuid, earlier.id) !== null && snapshot(survivor.uuid, survivorRevision.id) !== null);
  expect(catalog(live.uuid)).toMatchObject({ complete: true, failed: false,
    revisions: [{ id: earlier.id, final: true, name: { text: "Earlier" } }] });
  expect(snapshotTitle(snapshot(live.uuid, earlier.id)!.state)).toBe("Never opened here");
  expect(catalog(archived.uuid)).toBeNull();
  expect(catalog(decision.uuid)).toBeNull();
  expect(engine.replicas.hydrated(archived.uuid)).toBe(false);
  expect(requested.mock.calls.every(([room]) => room !== roomForDoc(WORKSPACE, archived.uuid) && room !== roomForDoc(WORKSPACE, decision.uuid))).toBe(true);

  const browser = await createMcpEngine(servingConfig, { serving: true });
  clients.push(() => browser.close());
  const browserRequests = vi.spyOn(browser.replicas.sync, "requestRevisions");
  const agent = await startServer({ ...config(), databasePath: servingConfig.databasePath });
  clients.push(() => agent.close());
  const agentRequests = vi.spyOn(agent.instance.replicas.sync, "requestRevisions");
  await author.ok("set_metadata", { uuid: live.uuid, title: "Changed after bootstrap" });
  await waitUntil("the mirrored content change to expose an undownloaded open head", () => {
    const head = catalog(live.uuid)?.revisions[0];
    return head?.title === "Changed after bootstrap" && head.final === false;
  });
  const open = catalog(live.uuid)!.revisions[0]!;
  expect(snapshot(live.uuid, open.id)).toBeNull();
  expect(snapshotTitle(snapshot(live.uuid, earlier.id)!.state)).toBe("Never opened here");
  const latest = (await author.ok("name_revision", { uuid: live.uuid, name: "Latest" })).revision;
  await waitUntil("a name notice to close and download the current head", () => snapshot(live.uuid, latest.id) !== null);
  expect(snapshotTitle(snapshot(live.uuid, latest.id)!.state)).toBe("Changed after bootstrap");
  await mutateDocumentRevision(author.instance.replicas, live.uuid, { operation: "rename", revisionId: latest.id, name: "Renamed" });
  await waitUntil("a name-only notice to replace the cached catalog", () => catalog(live.uuid)?.revisions[0]?.name?.text === "Renamed");
  expect(await agent.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  expect(agentRequests).not.toHaveBeenCalled();
  expect(browserRequests).not.toHaveBeenCalled();

  const discovered = await author.ok("create_doc", { title: "Discovered while idle", description: "The MCP refresher attaches newly announced pages.",
    blocks: [{ type: "paragraph", text: "A directory update wakes background discovery" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const discoveredRevision = (await author.ok("name_revision", { uuid: discovered.uuid, name: "Discovered" })).revision;
  await waitUntil("the idle MCP refresher to discover and download a new page", () => snapshot(discovered.uuid, discoveredRevision.id) !== null);
  await mutateDocumentRevision(author.instance.replicas, discovered.uuid, { operation: "remove-name", revisionId: discoveredRevision.id });
  await waitUntil("the name removal to reach the MCP refresher", () => catalog(discovered.uuid)?.revisions[0]?.name === null);
  await author.ok("set_metadata", { uuid: discovered.uuid, title: "An unnamed comparison step" });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const comparison = (await author.ok("name_revision", { uuid: discovered.uuid, name: "Comparison" })).revision;
  await mutateDocumentRevision(author.instance.replicas, discovered.uuid, { operation: "remove-name", revisionId: comparison.id });
  await author.ok("set_metadata", { uuid: discovered.uuid, title: "The newest downloaded state" });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const newest = (await author.ok("name_revision", { uuid: discovered.uuid, name: "Newest" })).revision;
  await waitUntil("all three downloaded revisions to precede the retention change", () =>
    snapshot(discovered.uuid, newest.id) !== null && snapshot(discovered.uuid, comparison.id) !== null &&
    catalog(discovered.uuid)?.revisions.find(revision => revision.id === comparison.id)?.name === null);
  expect(snapshot(discovered.uuid, discoveredRevision.id)).not.toBeNull();
  browser.store.setHistoryRetention({ mode: "named" });
  await waitUntil("retention written by the browser contender to evict unnamed downloaded history", () => snapshot(discovered.uuid, discoveredRevision.id) === null);

  const previousCatalog = catalog(survivor.uuid)!;
  const reconnectStart = requested.mock.calls.length;
  hub.hocuspocus.closeConnections();
  await waitUntil("the idle MCP refresher to conditionally revalidate after reconnect", () =>
    requested.mock.calls.slice(reconnectStart).some(([room, request]) => room === roomForDoc(WORKSPACE, survivor.uuid) &&
      request.operation === "list" && request.ifVersion === previousCatalog.version));

  await author.ok("archive_doc", { uuid: live.uuid });
  await waitUntil("archive state and history revalidation to reach the serving engine", () =>
    isDirectoryEntryArchived(engine.replicas.directory().doc, live.uuid) && catalog(live.uuid)?.revisions[0]?.name?.canManage === false);
  expect(snapshot(live.uuid, earlier.id)).not.toBeNull();
  expect(snapshot(live.uuid, latest.id)).not.toBeNull();
  expect(requested.mock.calls.filter(([room, request]) => room === roomForDoc(WORKSPACE, live.uuid) &&
    request.operation === "get" && request.revisionId === earlier.id)).toHaveLength(1);
  expect(requested.mock.calls.filter(([room, request]) => room === roomForDoc(WORKSPACE, live.uuid) &&
    request.operation === "get" && request.revisionId === latest.id)).toHaveLength(1);
  await author.ok("delete_doc", { uuid: live.uuid });
  await waitUntil("permanent deletion to purge mirrored history", () => engine.replicas.isDeleted(live.uuid) && catalog(live.uuid) === null);
  expect(snapshot(live.uuid, earlier.id)).toBeNull();
  expect(snapshot(live.uuid, latest.id)).toBeNull();

  const takeoverCatalog = catalog(survivor.uuid)!;
  await agent.close();
  await reader.close();
  await waitUntil("the browser contender to reuse the previous refresher's catalog", () =>
    browserRequests.mock.calls.some(([room, request]) => room === roomForDoc(WORKSPACE, survivor.uuid) &&
      request.operation === "list" && request.ifVersion === takeoverCatalog.version));
  expect(browserRequests.mock.calls.filter(([, request]) => request.operation === "get")).toHaveLength(0);

  credentials.revoke(issued.record.id);
  hub.hocuspocus.closeConnections();
  await waitUntil("the revoked device to require sign-in", () => browser.replicas.sync.state().authRecovery === "sign-in-required");
  expect(catalog(survivor.uuid)?.complete).toBe(true);
  const retained = snapshot(survivor.uuid, survivorRevision.id);
  expect(retained).not.toBeNull();
  await browser.close();
  const reopened = await startServer(servingConfig);
  clients.push(() => reopened.close());
  expect(reopened.instance.replicas.sync.state().authRecovery).toBe("sign-in-required");
  expect(snapshot(survivor.uuid, survivorRevision.id)).toEqual(retained);
  expect(catalog(live.uuid)).toBeNull();
  expect(catalog(archived.uuid)).toBeNull();
  expect(ready(cache.resume())?.generation).toBe(token.generation);
});

it("keeps foreground revision reads independent of a stalled mirror and fences a removed workspace copy", async () => {
  const { env, endpoint, config } = await historyWorkspace();
  const author = await startServer(config());
  clients.push(() => author.close());
  const live = await author.ok("create_doc", { title: "Before the held download", description: "A stalled background download does not own readers.",
    blocks: [{ type: "paragraph", text: "Earlier content" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: live.uuid, name: "Earlier" })).revision;
  const readerConfig = config();
  const reader = await startServer(readerConfig);
  clients.push(() => reader.close());
  const cache = new HistoryCache(readerConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const token = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  await waitUntil("the original MCP refresher to finish its first download", () => ready(cache.readSnapshot(token, live.uuid, earlier.id)) !== null);
  const follower = await startServer(readerConfig);
  clients.push(() => follower.close());

  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const request = reader.instance.replicas.sync.requestRevisions.bind(reader.instance.replicas.sync);
  vi.spyOn(reader.instance.replicas.sync, "requestRevisions").mockImplementation(async (...args) => {
    const response = await request(...args);
    if (args[1].operation === "get" && args[3]?.background === true) {
      held = true;
      await gate;
    }
    return response;
  });
  try {
    await author.ok("set_metadata", { uuid: live.uuid, title: "Foreground reads this state" });
    expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const latest = (await author.ok("name_revision", { uuid: live.uuid, name: "Latest" })).revision;
    await waitUntil("the background snapshot reply to be held before cache publication", () => held);
    expect(ready(cache.readSnapshot(token, live.uuid, latest.id))).toBeNull();

    for (const rig of [reader, follower]) {
      const revisions = await listDocumentRevisions(rig.instance.replicas, live.uuid, { timeoutMs: 2_000 });
      expect(revisions.some(revision => revision.id === latest.id)).toBe(true);
      const selected = await getDocumentRevision(rig.instance.replicas, live.uuid, latest.id, { timeoutMs: 2_000 });
      try { expect(getMeta(selected).title).toBe("Foreground reads this state"); }
      finally { selected.destroy(); }
    }
    expect(ready(cache.readSnapshot(token, live.uuid, latest.id))).toBeNull();

    for (const suffix of ["", "-wal", "-shm", ".history-refresher-lock"]) {
      rmSync(readerConfig.databasePath + suffix, { force: true });
    }
    const fresh = await startServer(readerConfig);
    clients.push(() => fresh.close());
    const freshCache = new HistoryCache(readerConfig.databasePath, WORKSPACE, env);
    clients.push(() => freshCache.close());
    const freshToken = ready(freshCache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
    await waitUntil("the replacement copy to mirror while the old response is still held", () =>
      ready(freshCache.readSnapshot(freshToken, live.uuid, latest.id)) !== null);
    expect(cache.readSnapshot(token, live.uuid, earlier.id)).toEqual({ status: "unavailable" });
    release();
    await reader.close();
    await follower.close();
    expect(ready(freshCache.resume())?.generation).toBe(freshToken.generation);
    expect(snapshotTitle(ready(freshCache.readSnapshot(freshToken, live.uuid, latest.id))!.state)).toBe("Foreground reads this state");
  } finally { release(); }
});

it("keeps mirroring after a page is deleted during a background download without reconnecting", async () => {
  const { env, endpoint, config } = await historyWorkspace();
  const author = await startServer(config());
  clients.push(() => author.close());
  const live = await author.ok("create_doc", { title: "Deleted during download", description: "Deleting one room must not refuse history for the workspace.",
    blocks: [{ type: "paragraph", text: "Earlier content" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: live.uuid, name: "Earlier" })).revision;
  const readerConfig = config();
  const reader = await startServer(readerConfig);
  clients.push(() => reader.close());
  const cache = new HistoryCache(readerConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const token = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  await waitUntil("the initial snapshot to arrive before the deletion race", () => ready(cache.readSnapshot(token, live.uuid, earlier.id)) !== null);

  const sync = reader.instance.replicas.sync;
  const room = roomForDoc(WORKSPACE, live.uuid);
  const connectionStates: string[] = [];
  const unsubscribe = sync.onStateChange(() => connectionStates.push(sync.state().status));
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const request = sync.requestRevisions.bind(sync);
  vi.spyOn(sync, "requestRevisions").mockImplementation(async (...args) => {
    const response = await request(...args);
    if (!held && args[0] === room && args[1].operation === "get" && args[3]?.background === true) {
      held = true;
      await gate;
    }
    return response;
  });
  try {
    await author.ok("set_metadata", { uuid: live.uuid, title: "Held snapshot" });
    expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const latest = (await author.ok("name_revision", { uuid: live.uuid, name: "Held" })).revision;
    await waitUntil("the real hub's background snapshot reply to be held", () => held);
    await author.ok("archive_doc", { uuid: live.uuid });
    await author.ok("delete_doc", { uuid: live.uuid });
    await waitUntil("deletion to purge history and release the room's admission", () =>
      reader.instance.replicas.isDeleted(live.uuid) && sync.historyAccount(room) === null &&
      ready(cache.readCatalog(token, live.uuid)) === null);
    release();

    const later = await author.ok("create_doc", { title: "Mirrored after deletion", description: "Background history still progresses on the same connection.",
      blocks: [{ type: "paragraph", text: "Later content" }] });
    expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const laterRevision = (await author.ok("name_revision", { uuid: later.uuid, name: "Later" })).revision;
    await waitUntil("a later page's snapshot to arrive without reconnecting", () => ready(cache.readSnapshot(token, later.uuid, laterRevision.id)) !== null);
    expect(sync.state().status).toBe("connected");
    expect(connectionStates.every(state => state === "connected")).toBe(true);
    expect(ready(cache.readCatalog(token, live.uuid))).toBeNull();
    expect(ready(cache.readSnapshot(token, live.uuid, earlier.id))).toBeNull();
    expect(ready(cache.readSnapshot(token, live.uuid, latest.id))).toBeNull();
  } finally { release(); unsubscribe(); }
});

it("yields the former account's admitted role after login changes so a new account session can mirror", async () => {
  const { hub, credentials, principals, memberships, principal, issued, endpoint, config } = await historyWorkspace();
  const author = await startServer(config());
  clients.push(() => author.close());
  const live = await author.ok("create_doc", { title: "Account A's admitted room", description: "Changing the stored login cannot relabel an existing room's authority.",
    blocks: [{ type: "paragraph", text: "Account A downloaded this state" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: live.uuid, name: "Earlier" })).revision;

  const root = tempDir();
  const env = { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, HOME: root };
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: endpoint }], env, WORKSPACE); }
  finally { lock.release(); }
  const { replacedAt: _replacedAt, ...record } = issued.record;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: principal,
    credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
  }, env);
  const readerConfig = { ...config(), deviceLogin: { env } };
  const reader = await startServer(readerConfig);
  clients.push(() => reader.close());
  const cache = new HistoryCache(readerConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const former = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  await waitUntil("account A's history to finish downloading", () => ready(cache.readSnapshot(former, live.uuid, earlier.id)) !== null);

  const nextPrincipal = principals.identify("67890", "history-reader-b");
  memberships.grant({ workspaceId: WORKSPACE, principalId: nextPrincipal.id, role: "admin" });
  const next = issueCredential(credentials, { principalId: nextPrincipal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  const { replacedAt: _nextReplacedAt, ...nextRecord } = next.record;
  const requested = vi.spyOn(reader.instance.replicas.sync, "requestRevisions");
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: nextPrincipal,
    credential: { record: nextRecord, key: Buffer.from(next.keyBytes).toString("base64url") },
  }, env);
  await author.ok("set_metadata", { uuid: live.uuid, title: "Changed after the stored account switched" });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const latest = (await author.ok("name_revision", { uuid: live.uuid, name: "After account switch" })).revision;
  await waitUntil("the former account's session to release the history role", () => {
    const role = tryAcquireHistoryRefresherRole(readerConfig.databasePath);
    if (role === null) return false;
    role.close();
    return true;
  });
  expect(reader.instance.replicas.sync.state().status).toBe("connected");
  expect(requested.mock.calls.filter(([, , , options]) => options?.background === true)).toHaveLength(0);

  const nextReader = await startServer(readerConfig);
  clients.push(() => nextReader.close());
  await waitUntil("account B to mirror through its own newly admitted connection", () => {
    const resumed = cache.resume();
    if (resumed.status !== "ready") return false;
    const token = resumed.value;
    return token?.account === "67890" && ready(cache.readSnapshot(token, live.uuid, latest.id)) !== null;
  });
  const current = ready(cache.resume())!;
  expect(current.generation).not.toBe(former.generation);
  expect(requested.mock.calls.filter(([, , , options]) => options?.background === true)).toHaveLength(0);
  expect(snapshotTitle(ready(cache.readSnapshot(current, live.uuid, latest.id))!.state)).toBe("Changed after the stored account switched");
});

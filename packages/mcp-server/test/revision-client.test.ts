import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  appendBlock, compareRevisions, deleteDirectoryEntry, encodeRevisionCatalogChanged, encodeRevisionResponseFrames, getMeta, getMetaMap, initDoc,
  readRevisionRequest, roomForDoc, setTitle, tombstoneDirectoryEntry, upsertDirectoryEntry, type RevisionRequest, type RevisionResponse,
} from "@uberblick/schema";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { writeHubLogin } from "../src/auth-store.js";
import { acquireInitLock } from "../src/init-lock.js";
import { documentRevisionChecksum, mutateDocumentRevision, readDocumentHistory, readDocumentRevision, restoreDocumentRevision } from "../src/revision-client.js";
import { HubSync } from "../src/sync.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, tempDir, testConfig, TEST_SECRET, waitUntil, WORKSPACE } from "./helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

function workspace(config = testConfig()): WorkspaceReplicaSet {
  const opened = openWorkspaceReplicas(config, { publishOwnPresence: false });
  clients.push(() => opened.close());
  return opened;
}

async function admitted() {
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: ":memory:",
    github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("Unexpected GitHub request."); }) },
    log() {},
  }, { deviceCredentials: true });
  hubs.push(() => hub.stop());
  if (hub.credentials === undefined || hub.memberships === undefined || hub.principals === undefined) {
    throw new Error("The history fixture requires device authority.");
  }
  const principal = hub.principals.identify("12345", "history-reader");
  hub.memberships.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
  const issued = issueCredential(hub.credentials, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  const directory = tempDir();
  const env = { XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, HOME: directory };
  const endpoint = hubUrl(hub.port);
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: endpoint }], env, WORKSPACE); }
  finally { lock.release(); }
  const { replacedAt: _replacedAt, ...record } = issued.record;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: principal, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
  }, env);
  const opened = workspace({ ...testConfig({ hubUrl: endpoint, ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
  const uuid = randomUUID();
  const replica = opened.replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Current document" });
  expect(await opened.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const room = roomForDoc(opened.replicas.config.workspaceId, uuid);
  const connection = hub.hocuspocus.documents.get(room)?.getConnections()[0];
  if (connection === undefined) throw new Error("The document did not retain its admitted connection.");
  return {
    opened, uuid, replica, hub,
    reply(handler: (request: RevisionRequest, send: (response: RevisionResponse) => void) => void) {
      const original = connection.callbacks.statelessCallback;
      connection.onStatelessCallback(async payload => {
        const request = readRevisionRequest(payload.payload);
        if (request === null) { await original(payload); return; }
        handler(request, response => {
          for (const frame of encodeRevisionResponseFrames(response).reverse()) connection.sendStateless(frame);
        });
      });
    },
  };
}

it("correlates concurrent list and snapshot reads and returns a detached Y.Doc accepted by comparison", async () => {
  const fixture = await admitted();
  const snapshot = new Y.Doc();
  clients.push(() => snapshot.destroy());
  initDoc(snapshot, { uuid: fixture.uuid, title: "Earlier title" });
  appendBlock(snapshot, { type: "paragraph", text: "Snapshot content ".repeat(40_000) });
  snapshot.getMap("data").set('["schema","values"]', { version: 1, schema: { type: "object", properties: { count: { type: "number" } } } });
  snapshot.getMap("data").set('["record","values","first"]', { count: 4 });
  const checksum = documentRevisionChecksum(snapshot);
  const entries = [{ id: "revision-1", author: { githubUsername: "current-handle", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 100, endedAt: null, checksum }];
  fixture.reply((request, send) => {
    send({ requestId: "some-other-request", ok: true, revisions: [] });
    send(request.operation === "list"
      ? { requestId: request.requestId, ok: true, revisions: entries }
      : { requestId: request.requestId, ok: true, state: Y.encodeStateAsUpdate(snapshot), revisionId: "revision-1", checksum });
  });

  const room = roomForDoc(WORKSPACE, fixture.uuid);
  const [transportList, transportGet] = await Promise.all([
    fixture.opened.replicas.sync.requestRevisions(room, { operation: "list" }),
    fixture.opened.replicas.sync.requestRevisions(room, { operation: "get", revisionId: "revision-1" }),
  ]);
  expect(transportList).toMatchObject({ ok: true, revisions: entries });
  expect(transportGet).toMatchObject({ ok: true, state: Y.encodeStateAsUpdate(snapshot) });

  const [{ revisions: listed }, { doc: fetched }] = await Promise.all([
    readDocumentHistory(fixture.opened.replicas, fixture.uuid),
    readDocumentRevision(fixture.opened.replicas, fixture.uuid, "revision-1"),
  ]);
  clients.push(() => fetched.destroy());
  expect(listed).toEqual(entries);
  expect(compareRevisions(snapshot, fetched).changed).toBe(false);
  setTitle(fetched, "Detached local change");
  expect(getMeta(fixture.replica.doc).title).toBe("Current document");
  expect(getMeta(snapshot).title).toBe("Earlier title");

  const requested = vi.spyOn(fixture.opened.replicas.sync, "requestRevisions");
  const http = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("A cached history read must not fetch the hub clock."));
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: entries });
  const { doc: cached } = await readDocumentRevision(fixture.opened.replicas, fixture.uuid, "revision-1");
  try { expect(compareRevisions(snapshot, cached).changed).toBe(false); }
  finally { cached.destroy(); }
  expect(requested).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
});

it("refuses snapshot reads from a hub catalog without checksums instead of reading around the cache", async () => {
  const fixture = await admitted();
  const requests: RevisionRequest[] = [];
  const entry = { id: "legacy-revision", author: null, startedAt: 100, endedAt: 200 };
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true, revisions: [entry] });
  });
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: [entry] });
  await expect(readDocumentRevision(fixture.opened.replicas, fixture.uuid, entry.id)).rejects.toMatchObject({ code: "unsupported" });
  expect(requests.map(request => request.operation)).toEqual(["list"]);
});

it("retries the hub clock after a failed refresh without restarting the client", async () => {
  const fixture = await admitted();
  const entries = [{ id: "revision-1", author: null, startedAt: 100, endedAt: 200,
    checksum: documentRevisionChecksum(fixture.replica.doc) }];
  const requests: RevisionRequest[] = [];
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true, revisions: entries });
  });
  const http = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("The hub clock is temporarily unreachable."));

  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid, { refresh: true }))
    .rejects.toMatchObject({ code: "unreachable" });
  expect(requests).toEqual([]);
  expect(fixture.opened.replicas.sync.state().status).toBe("connected");
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid, { refresh: true }))
    .resolves.toMatchObject({ revisions: entries, history: { complete: true, refreshFailed: false, offline: false } });
  expect(requests.map(request => request.operation)).toEqual(["list"]);
  expect(http).toHaveBeenCalledTimes(2);
  expect(http.mock.calls.every(([url]) => String(url).endsWith("/auth/claim-state"))).toBe(true);
});

it("updates an already cached catalog before a successful naming call returns", async () => {
  const fixture = await admitted();
  const entry = { id: "named-revision", author: null, startedAt: 100, endedAt: 200,
    checksum: documentRevisionChecksum(fixture.replica.doc), name: null };
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [entry] }));
  await readDocumentHistory(fixture.opened.replicas, fixture.uuid);
  const named = { ...entry, name: { text: "Reviewed", namedAt: 300, namer: null, canManage: true } };
  const requests: RevisionRequest[] = [];
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true, revision: named });
  });
  await expect(mutateDocumentRevision(fixture.opened.replicas, fixture.uuid, {
    operation: "name", name: "Reviewed", checksum: entry.checksum, surface: { kind: "mcp", name: "Codex" },
  })).resolves.toEqual(named);
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: [named] });
  expect(requests.map(request => request.operation)).toEqual(["name"]);
});

it("returns an empty list only when the hub confirms there are no revisions", async () => {
  const fixture = await admitted();
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [] }));
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: [] });
});

it("delivers revision name notices with their attached room until unsubscribed", async () => {
  const fixture = await admitted();
  const room = roomForDoc(fixture.opened.replicas.config.workspaceId, fixture.uuid);
  const connection = fixture.hub.hocuspocus.documents.get(room)?.getConnections()[0];
  if (connection === undefined) throw new Error("The document did not retain its admitted connection.");
  const notices: string[] = [];
  const unsubscribe = fixture.opened.replicas.sync.onRevisionCatalogChanged(changedRoom => notices.push(changedRoom));
  connection.sendStateless("unrelated-payload");
  connection.sendStateless(encodeRevisionCatalogChanged());
  await waitUntil("the attached room's revision notice", () => notices.length === 1);
  expect(notices).toEqual([room]);

  unsubscribe();
  connection.sendStateless(encodeRevisionCatalogChanged());
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [] }));
  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: [] });
  expect(notices).toEqual([room]);
});

it("rechecks background priority at send time while foreground history remains available", async () => {
  const fixture = await admitted();
  const sync = fixture.opened.replicas.sync;
  let quiet = true;
  vi.spyOn(sync, "isQuiet").mockImplementation(() => quiet);
  const requests: RevisionRequest[] = [];
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true, revisions: [] });
  });
  const room = roomForDoc(fixture.opened.replicas.config.workspaceId, fixture.uuid);
  const background = sync.requestRevisions(room, { operation: "list" }, 5_000, { background: true });
  quiet = false;

  await expect(readDocumentHistory(fixture.opened.replicas, fixture.uuid)).resolves.toMatchObject({ revisions: [] });
  expect(requests).toHaveLength(1);

  quiet = true;
  setTitle(fixture.replica.doc, "Wake deferred background work");
  await expect(background).resolves.toMatchObject({ ok: true, revisions: [] });
  expect(requests).toHaveLength(2);
});

it.each(["directory", "document"] as const)("refuses decision history known through the %s before sending any client request", async source => {
  const opened = workspace();
  const uuid = randomUUID();
  const topic = randomUUID();
  if (source === "directory") {
    upsertDirectoryEntry(opened.replicas.directory().doc, { uuid, title: "Decision", kind: "decision", topic, status: "open" });
  } else {
    const doc = opened.replicas.replica(uuid).doc;
    initDoc(doc, { uuid, title: "Decision" });
    getMetaMap(doc).set("kind", "decision");
    getMetaMap(doc).set("topic", topic);
  }
  const request = vi.spyOn(opened.replicas.sync, "requestRevisions");
  const expected = { code: "decision-no-history", details: { uuid, topic } };
  await expect(readDocumentHistory(opened.replicas, uuid)).rejects.toMatchObject(expected);
  await expect(readDocumentRevision(opened.replicas, uuid, "earlier")).rejects.toMatchObject(expected);
  await expect(mutateDocumentRevision(opened.replicas, uuid, { operation: "name", name: "Reviewed", checksum: "unused" }))
    .rejects.toMatchObject(expected);
  await expect(restoreDocumentRevision(opened.replicas, uuid, { operation: "restore", revisionId: "earlier",
    checksum: "unused", surface: { kind: "mcp", name: "Codex" } })).rejects.toMatchObject(expected);
  expect(request).not.toHaveBeenCalled();
  expect(opened.replicas.hydrated(uuid)).toBe(source === "document");
});

it("preserves independent names and titles options at the revision transport boundary", async () => {
  const fixture = await admitted();
  const requests: RevisionRequest[] = [];
  const entry = { id: "revision-1", author: null, startedAt: 100, endedAt: null };
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true,
      revisions: [request.includeTitles === true ? { ...entry, title: "Earlier title" } : entry] });
  });
  const room = roomForDoc(WORKSPACE, fixture.uuid);
  const list = (options: { includeNames?: true; includeTitles?: true } = {}) =>
    fixture.opened.replicas.sync.requestRevisions(room, { operation: "list", ...options });
  await expect(list()).resolves.toMatchObject({ revisions: [entry] });
  await expect(list({ includeNames: true })).resolves.toMatchObject({ revisions: [entry] });
  await expect(list({ includeTitles: true })).resolves.toMatchObject({ revisions: [{ ...entry, title: "Earlier title" }] });
  await list({ includeNames: true, includeTitles: true });
  expect(requests[0]).not.toHaveProperty("includeNames");
  expect(requests[0]).not.toHaveProperty("includeTitles");
  expect(requests[1]).toMatchObject({ operation: "list", includeNames: true });
  expect(requests[1]).not.toHaveProperty("includeTitles");
  expect(requests[2]).toMatchObject({ operation: "list", includeTitles: true });
  expect(requests[2]).not.toHaveProperty("includeNames");
  expect(requests[3]).toMatchObject({ operation: "list", includeNames: true, includeTitles: true });

  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [entry] }));
  await expect(list({ includeTitles: true })).resolves.toMatchObject({ revisions: [entry] });
});

it("does not claim a sent naming request made no change when its reply is lost or unavailable", async () => {
  const fixture = await admitted();
  const mutation = { operation: "name" as const, name: "Reviewed", checksum: documentRevisionChecksum(fixture.replica.doc),
    surface: { kind: "mcp", name: "Claude Code" } };
  const committed: string[] = [];
  fixture.reply(request => { committed.push(request.name!); });
  await expect(mutateDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation, { timeoutMs: 100 }))
    .rejects.toMatchObject({ code: "naming-outcome-unknown", details: { applied: null, reason: "unsupported" } });
  expect(committed).toEqual(["Reviewed"]);
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error: "unavailable" }));
  await expect(mutateDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation))
    .rejects.toMatchObject({ code: "naming-outcome-unknown", details: { applied: null, reason: "unreachable" } });
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error: "stale-state" }));
  await expect(mutateDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation))
    .rejects.toMatchObject({ code: "stale-state", details: {} });
});

it("preserves restore no-op results and treats missing restore acknowledgements as unknown outcomes", async () => {
  const fixture = await admitted();
  const mutation = { operation: "restore" as const, revisionId: "earlier", checksum: documentRevisionChecksum(fixture.replica.doc),
    surface: { kind: "mcp", name: "Codex" } };
  const entry = { id: "current", author: null, startedAt: 100, endedAt: 200, name: null };
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revision: entry, applied: false }));
  await expect(restoreDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation))
    .resolves.toEqual({ revision: entry, applied: false });
  const requests: RevisionRequest[] = [];
  fixture.reply(request => { requests.push(request); });
  await expect(restoreDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation, { timeoutMs: 100 }))
    .rejects.toMatchObject({ code: "restore-outcome-unknown", details: { applied: null, reason: "unsupported" } });
  expect(requests).toMatchObject([mutation]);
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error: "unavailable" }));
  await expect(restoreDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation))
    .rejects.toMatchObject({ code: "restore-outcome-unknown", details: { applied: null, reason: "unreachable" } });
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error: "stale-state" }));
  await expect(restoreDocumentRevision(fixture.opened.replicas, fixture.uuid, mutation))
    .rejects.toMatchObject({ code: "stale-state", details: {} });
});

it.each([
  ["unsupported", "unsupported"], ["deleted", "deleted"], ["forbidden", "forbidden"],
  ["revision-not-found", "revision-not-found"], ["unavailable", "unreachable"],
] as const)("reports the hub's %s refusal without returning revision content", async (error, code) => {
  const fixture = await admitted();
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error }));
  await expect(readDocumentRevision(fixture.opened.replicas, fixture.uuid, "unknown-or-foreign-id"))
    .rejects.toMatchObject({ name: "RevisionClientError", code });
});

it("distinguishes local-only, missing sign-in and an unreachable hub", async () => {
  const uuid = randomUUID();
  const local = workspace();
  await expect(readDocumentHistory(local.replicas, uuid)).rejects.toMatchObject({ code: "local-only" });

  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(() => hub.close());
  const noLogin = workspace({ ...testConfig({ hubUrl: hub.url }), deviceLogin: { env: { XDG_CONFIG_HOME: tempDir() } } });
  await expect(noLogin.replicas.sync.requestRevisions(noLogin.replicas.replica(uuid).room, { operation: "list" }))
    .rejects.toMatchObject({ code: "sign-in-required" });

  const unreachable = workspace(testConfig({ authSecret: TEST_SECRET, hubUrl: "ws://127.0.0.1:1" }));
  await expect(unreachable.replicas.sync.requestRevisions(unreachable.replicas.replica(uuid).room, { operation: "list" }, 200))
    .rejects.toMatchObject({ code: "unreachable" });
});

it("bounds an old hub's silent reply and distinguishes it from a lost connection", async () => {
  const fixture = await admitted();
  const room = roomForDoc(WORKSPACE, fixture.uuid);
  fixture.reply(() => {});
  await expect(fixture.opened.replicas.sync.requestRevisions(room, { operation: "list" }, 100))
    .rejects.toMatchObject({ code: "unsupported" });
  expect(fixture.opened.replicas.sync.state().status).toBe("connected");
  fixture.reply(() => fixture.hub.hocuspocus.closeConnections());
  await expect(fixture.opened.replicas.sync.requestRevisions(room, { operation: "list" }, 1_000))
    .rejects.toMatchObject({ code: "unreachable" });
});

it("settles a pending read when its owning client is closed", async () => {
  const fixture = await admitted();
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  fixture.reply(() => received());
  const pending = readDocumentHistory(fixture.opened.replicas, fixture.uuid);
  const assertion = expect(pending).rejects.toMatchObject({ code: "unreachable" });
  await arrived;
  await fixture.opened.close();
  await assertion;
});

it("reports an initial deleted-room admission refusal distinctly from sign-in and old-hub silence", async () => {
  const fixture = await admitted();
  const directory = fixture.opened.replicas.directory().doc;
  tombstoneDirectoryEntry(directory, fixture.uuid);
  expect(await fixture.opened.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  deleteDirectoryEntry(directory, fixture.uuid);
  expect(await fixture.opened.replicas.waitForSettled()).toMatchObject({ caughtUp: true });

  const sync = new HubSync(fixture.opened.replicas.config, () => {});
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  clients.push(async () => { await sync.destroy(); awareness.destroy(); doc.destroy(); });
  const room = roomForDoc(fixture.opened.replicas.config.workspaceId, fixture.uuid);
  sync.attach({ room, doc, awareness });
  await expect(sync.requestRevisions(room, { operation: "list" })).rejects.toMatchObject({ code: "deleted" });
});

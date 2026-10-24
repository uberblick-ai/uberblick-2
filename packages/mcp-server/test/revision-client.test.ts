import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  appendBlock, compareRevisions, deleteDirectoryEntry, encodeRevisionResponseFrames, getMeta, initDoc,
  readRevisionRequest, roomForDoc, setTitle, tombstoneDirectoryEntry, type RevisionRequest, type RevisionResponse,
} from "@uberblick/schema";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { documentRevisionChecksum, getDocumentRevision, listDocumentRevisions, mutateDocumentRevision, restoreDocumentRevision } from "../src/revision-client.js";
import { HubSync } from "../src/sync.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, tempDir, testConfig, TEST_SECRET } from "./helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];
afterEach(async () => {
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

function workspace(config = testConfig()): WorkspaceReplicaSet {
  const opened = openWorkspaceReplicas(config, { publishOwnPresence: false });
  clients.push(() => opened.close());
  return opened;
}

async function admitted() {
  const hub = await startHub();
  hubs.push(() => hub.stop());
  const opened = workspace(testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE }));
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
  const entries = [{ id: "revision-1", author: { githubUsername: "current-handle", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 100, endedAt: null }];
  fixture.reply((request, send) => {
    send({ requestId: "some-other-request", ok: true, revisions: [] });
    send(request.operation === "list"
      ? { requestId: request.requestId, ok: true, revisions: entries }
      : { requestId: request.requestId, ok: true, state: Y.encodeStateAsUpdate(snapshot) });
  });

  const [listed, fetched] = await Promise.all([
    listDocumentRevisions(fixture.opened.replicas, fixture.uuid),
    getDocumentRevision(fixture.opened.replicas, fixture.uuid, "revision-1"),
  ]);
  clients.push(() => fetched.destroy());
  expect(listed).toEqual(entries);
  expect(compareRevisions(snapshot, fetched).changed).toBe(false);
  setTitle(fetched, "Detached local change");
  expect(getMeta(fixture.replica.doc).title).toBe("Current document");
  expect(getMeta(snapshot).title).toBe("Earlier title");
});

it("returns an empty list only when the hub confirms there are no revisions", async () => {
  const fixture = await admitted();
  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [] }));
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid)).resolves.toEqual([]);
});

it("opts in to names and titles independently without changing legacy list requests or replies", async () => {
  const fixture = await admitted();
  const requests: RevisionRequest[] = [];
  const entry = { id: "revision-1", author: null, startedAt: 100, endedAt: null };
  fixture.reply((request, send) => {
    requests.push(request);
    send({ requestId: request.requestId, ok: true,
      revisions: [request.includeTitles === true ? { ...entry, title: "Earlier title" } : entry] });
  });
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid)).resolves.toEqual([entry]);
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { includeNames: true })).resolves.toEqual([entry]);
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { includeTitles: true }))
    .resolves.toEqual([{ ...entry, title: "Earlier title" }]);
  await listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { includeNames: true, includeTitles: true });
  expect(requests[0]).not.toHaveProperty("includeNames");
  expect(requests[0]).not.toHaveProperty("includeTitles");
  expect(requests[1]).toMatchObject({ operation: "list", includeNames: true });
  expect(requests[1]).not.toHaveProperty("includeTitles");
  expect(requests[2]).toMatchObject({ operation: "list", includeTitles: true });
  expect(requests[2]).not.toHaveProperty("includeNames");
  expect(requests[3]).toMatchObject({ operation: "list", includeNames: true, includeTitles: true });

  fixture.reply((request, send) => send({ requestId: request.requestId, ok: true, revisions: [entry] }));
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { includeTitles: true })).resolves.toEqual([entry]);
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
  await expect(getDocumentRevision(fixture.opened.replicas, fixture.uuid, "unknown-or-foreign-id"))
    .rejects.toMatchObject({ name: "RevisionClientError", code });
});

it("distinguishes local-only, missing sign-in and an unreachable hub", async () => {
  const uuid = randomUUID();
  const local = workspace();
  await expect(listDocumentRevisions(local.replicas, uuid)).rejects.toMatchObject({ code: "local-only" });

  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(() => hub.close());
  const noLogin = workspace({ ...testConfig({ hubUrl: hub.url }), deviceLogin: { env: { XDG_CONFIG_HOME: tempDir() } } });
  await expect(listDocumentRevisions(noLogin.replicas, uuid)).rejects.toMatchObject({ code: "sign-in-required" });

  const unreachable = workspace(testConfig({ authSecret: TEST_SECRET, hubUrl: "ws://127.0.0.1:1" }));
  await expect(listDocumentRevisions(unreachable.replicas, uuid, { timeoutMs: 200 })).rejects.toMatchObject({ code: "unreachable" });
});

it("bounds an old hub's silent reply and distinguishes it from a lost connection", async () => {
  const fixture = await admitted();
  fixture.reply(() => {});
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { timeoutMs: 100 }))
    .rejects.toMatchObject({ code: "unsupported" });
  expect(fixture.opened.replicas.sync.state().status).toBe("connected");
  fixture.reply(() => fixture.hub.hocuspocus.closeConnections());
  await expect(listDocumentRevisions(fixture.opened.replicas, fixture.uuid, { timeoutMs: 1_000 }))
    .rejects.toMatchObject({ code: "unreachable" });
});

it("settles a pending read when its owning client is closed", async () => {
  const fixture = await admitted();
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  fixture.reply(() => received());
  const pending = listDocumentRevisions(fixture.opened.replicas, fixture.uuid);
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

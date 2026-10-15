import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { deleteDirectoryEntry, directoryRoom, getMeta, initDoc, isDirectoryEntryDeleted, roomForDoc, setTitle } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { HubSync } from "../src/sync.js";
import { compareCorpus, inspectRemote, isIdentical, syncWorkspace } from "../src/remote.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import {
  cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, testConfig,
  TEST_SECRET, WAIT_TIMEOUT_MS, waitUntil,
} from "./helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
const hubs: Hub[] = [];
const extraCleanup: (() => unknown)[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: [...extraCleanup.splice(0), ...workspaces.splice(0).map(workspace => () => workspace.close())],
    hubs: hubs.splice(0).map(hub => () => hub.stop()),
  });
});

function configuration(port: number) {
  return testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(port), ...LIVE_HUB_SETTLE });
}

async function documentOnHub() {
  const hub = await startHub();
  hubs.push(hub);
  const config = configuration(hub.port);
  const workspace = openWorkspaceReplicas(config);
  workspaces.push(workspace);
  const uuid = randomUUID();
  const document = workspace.replicas.replica(uuid);
  initDoc(document.doc, { uuid, title: "Deletion convergence" });
  expect(await workspace.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
  return { hub, workspace, uuid, document };
}

it("purges a connected replica and retains deletion evidence after reopening its store", async () => {
  const { hub, workspace, uuid } = await documentOnHub();
  const config = configuration(hub.port);
  const observer = openWorkspaceReplicas(config);
  workspaces.push(observer);
  await observer.replicas.settle();
  expect(getMeta(observer.replicas.replica(uuid).doc).title).toBe("Deletion convergence");
  const room = roomForDoc(config.workspaceId, uuid);
  expect(observer.store.hasRoom(room)).toBe(true);

  deleteDirectoryEntry(workspace.replicas.directory().doc, uuid);
  await waitUntil("the connected replica to learn the deletion", () => observer.replicas.isDeleted(uuid));
  observer.replicas.refresh();
  expect(observer.store.hasRoom(room)).toBe(false);
  expect(observer.replicas.known(uuid)).toBe(false);
  expect(observer.replicas.sync.state().status).toBe("connected");
  await observer.close();

  const reopened = openWorkspaceReplicas(config);
  workspaces.push(reopened);
  expect(reopened.replicas.isDeleted(uuid)).toBe(true);
  expect(reopened.store.hasRoom(room)).toBe(false);
  expect(() => reopened.replicas.replica(uuid)).toThrow("permanently deleted");
});

it("treats a refused deleted room as deletion while other rooms keep syncing", async () => {
  const { hub, workspace, uuid } = await documentOnHub();
  deleteDirectoryEntry(workspace.replicas.directory().doc, uuid);
  expect(await workspace.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
  const deletedRoom = roomForDoc(workspace.replicas.config.workspaceId, uuid);
  const healthyUuid = randomUUID();
  const healthyRoom = roomForDoc(workspace.replicas.config.workspaceId, healthyUuid);
  const notices: string[] = [];
  const sync = new HubSync(configuration(hub.port), () => {}, { onDocDeleted: room => notices.push(room) });
  const deletedDoc = new Y.Doc();
  const healthyDoc = new Y.Doc();
  const deletedAwareness = new Awareness(deletedDoc);
  const healthyAwareness = new Awareness(healthyDoc);
  extraCleanup.push(async () => {
    await sync.destroy();
    deletedAwareness.destroy(); healthyAwareness.destroy();
    deletedDoc.destroy(); healthyDoc.destroy();
  });
  initDoc(deletedDoc, { uuid, title: "Outdated offline copy" });
  initDoc(healthyDoc, { uuid: healthyUuid, title: "Healthy room" });
  sync.attach({ room: deletedRoom, doc: deletedDoc, awareness: deletedAwareness });
  sync.attach({ room: healthyRoom, doc: healthyDoc, awareness: healthyAwareness });
  await waitUntil("a room-local deletion refusal and healthy handshake", () =>
    notices.includes(deletedRoom) && sync.isRoomQuiet(healthyRoom),
  );
  expect(sync.state().status).toBe("connected");
  const before = sync.mintCount;
  sync.attach({ room: deletedRoom, doc: deletedDoc, awareness: deletedAwareness });
  setTitle(healthyDoc, "Still syncing after deletion");
  await waitUntil("the surviving room's later edit to be acknowledged", () => sync.isRoomQuiet(healthyRoom));
  expect(sync.mintCount).toBe(before);
  expect(notices).toEqual([deletedRoom]);
  expect(getMeta(hub.hocuspocus.documents.get(healthyRoom)!).title).toBe("Still syncing after deletion");
});

it("uploads deletion marks without deleted rooms and verifies them independently of document counts", async () => {
  const localConfig = testConfig();
  const local = openWorkspaceReplicas(localConfig, { hubFree: true });
  workspaces.push(local);
  const uuid = randomUUID();
  initDoc(local.replicas.replica(uuid).doc, { uuid, title: "Permanently removed before promotion" });
  deleteDirectoryEntry(local.replicas.directory().doc, uuid);
  await local.close();
  const hub = await startHub();
  hubs.push(hub);
  const remoteConfig = { ...localConfig, hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET, ...LIVE_HUB_SETTLE };
  const uploaded = await syncWorkspace(remoteConfig);
  expect(uploaded.entries).toEqual([]);
  expect(uploaded.missing).toEqual([]);
  expect(uploaded.unsettled).toEqual([]);
  expect(hub.hocuspocus.documents.has(roomForDoc(localConfig.workspaceId, uuid))).toBe(false);
  expect(isDirectoryEntryDeleted(hub.hocuspocus.documents.get(directoryRoom(localConfig.workspaceId))!, uuid)).toBe(true);
  const readback = await inspectRemote(remoteConfig, { documents: true, workspace: true });
  expect(readback.entries).toEqual([]);
  expect(readback.missing).toEqual([]);
  expect(isIdentical(compareCorpus(uploaded.workspace!, readback.workspace!))).toBe(true);
  const withoutEvidence = uploaded.workspace!.filter(entry => entry.uuid !== "_deleted");
  expect(isIdentical(compareCorpus(withoutEvidence, readback.workspace!))).toBe(false);
});

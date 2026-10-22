import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, deleteDirectoryEntry, getDirectoryMap, getMeta, initDoc,
  roomForDoc, setLinks, setTitle,
} from "@uberblick/schema";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { FailingStore, cleanupTestResources, testConfig } from "./core-helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: workspaces.splice(0).map(workspace => () => workspace.close()) });
});

function workspace(store?: FailingStore): WorkspaceReplicaSet {
  const config = testConfig();
  const opened = openWorkspaceReplicas(config, { hubFree: true, ...(store === undefined ? {} : { store }) });
  workspaces.push(opened);
  return opened;
}

it("purges authority, pending and source indexes and retires the in-memory room", async () => {
  const { replicas, store } = workspace();
  const uuid = randomUUID();
  const target = randomUUID();
  const replica = replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Confidential deletion" });
  appendBlock(replica.doc, { type: "paragraph", text: "sensitive body" });
  setLinks(replica.doc, [target]);
  await replicas.settle();
  store.clearPending(replica.room, replica.lastSeq);
  store.compact(replica.room, Y.encodeStateAsUpdate(replica.doc), replica.lastSeq);
  setTitle(replica.doc, "Confidential updated");
  expect(store.snapshot(replica.room)).not.toBeNull();
  expect(store.updateCount(replica.room)).toBeGreaterThan(0);
  expect(store.pendingRooms().some(row => row.room === replica.room)).toBe(true);
  expect(store.backlinks(target).map(row => row.uuid)).toContain(uuid);

  deleteDirectoryEntry(replicas.directory().doc, uuid);

  expect(store.hasRoom(replica.room)).toBe(false);
  expect(store.snapshot(replica.room)).toBeNull();
  expect(store.pendingRooms().some(row => row.room === replica.room)).toBe(false);
  expect(store.isIndexed(uuid)).toBe(false);
  expect(store.search("confidential", 10)).toEqual([]);
  expect(store.backlinks(target)).toEqual([]);
  expect(replicas.known(uuid)).toBe(false);
  expect(() => replicas.replica(uuid)).toThrow("permanently deleted");
  expect(getDirectoryMap(replicas.directory().doc).has(uuid)).toBe(false);
});

it("purges rows reintroduced by an older process without replaying or repairing its stub", async () => {
  const { replicas, store } = workspace();
  const uuid = randomUUID();
  const oldDoc = new Y.Doc();
  initDoc(oldDoc, { uuid, title: "Offline return" });
  const state = Y.encodeStateAsUpdate(oldDoc);
  const room = roomForDoc(replicas.config.workspaceId, uuid);
  deleteDirectoryEntry(replicas.directory().doc, uuid);
  const firstSeq = store.appendUpdate(room, state, "local");
  store.clearPending(room, firstSeq);
  store.compact(room, state, firstSeq);
  store.indexDoc({ uuid, title: "Offline return", tags: [], description: "", links: [], body: "secret" }, 1);
  getDirectoryMap(replicas.directory().doc).set(uuid, { uuid, title: "Offline return" });
  // Repeat after the directory event's purge: no further directory update is needed.
  const secondSeq = store.appendUpdate(room, state, "local");
  store.clearPending(room, secondSeq);
  store.compact(room, state, secondSeq);
  store.indexDoc({ uuid, title: "Offline return", tags: [], description: "", links: [], body: "secret" }, 1);
  expect(store.hasRoom(room)).toBe(true);
  replicas.refresh();
  expect(store.hasRoom(room)).toBe(false);
  expect(store.isIndexed(uuid)).toBe(false);
  expect(replicas.known(uuid)).toBe(false);
  expect(getDirectoryMap(replicas.directory().doc).has(uuid)).toBe(false);
  oldDoc.destroy();
});

it("never treats an absent directory entry as deletion evidence", async () => {
  const { replicas, store } = workspace();
  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Still here" });
  getDirectoryMap(replicas.directory().doc).delete(uuid);
  replicas.refresh();
  expect(store.hasRoom(replica.room)).toBe(true);
  expect(replicas.known(uuid)).toBe(true);
  expect(getMeta(replica.doc).title).toBe("Still here");
});

it("retains authoritative rows and indexes when the deletion mark cannot be logged", () => {
  const config = testConfig();
  const store = new FailingStore(config.databasePath, config.workspaceId);
  const { replicas } = workspace(store);
  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Durable content" });
  const count = store.updateCount(replica.room);
  store.failRoom = room => room === replicas.directory().room;
  store.failing = true;
  deleteDirectoryEntry(replicas.directory().doc, uuid);
  expect(() => replicas.assertHealthy()).toThrow("update log rejected");
  expect(store.updateCount(replica.room)).toBe(count);
  expect(store.isIndexed(uuid)).toBe(true);
  expect(replicas.known(uuid)).toBe(true);
});

it("stops serving when durable deletion evidence cannot purge stored content", () => {
  class RefusingPurgeStore extends FailingStore {
    override purgeDoc(): void { throw new Error("simulated deletion storage failure"); }
  }
  const config = testConfig();
  const store = new RefusingPurgeStore(config.databasePath, config.workspaceId);
  const { replicas } = workspace(store);
  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Cannot serve after failed deletion" });
  deleteDirectoryEntry(replicas.directory().doc, uuid);
  expect(() => replicas.assertHealthy()).toThrow("simulated deletion storage failure");
  expect(replicas.sync.isQuarantined()).toBe(true);
  expect(replicas.known(uuid)).toBe(false);
  expect(() => replicas.replica(uuid)).toThrow("permanently deleted");
  expect(store.hasRoom(replica.room)).toBe(true);
});

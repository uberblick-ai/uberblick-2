import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  directoryRoom, getDirectoryEntry, getDirectoryMap, getMetaMap,
  initDoc, listDirectory,
} from "@uberblick/schema";
import { MirrorStore } from "../src/store.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, testConfig } from "./core-helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
const docs: Y.Doc[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({
    clients: workspaces.splice(0).map(workspace => () => workspace.close()),
    after: docs.splice(0).map(doc => () => doc.destroy()),
  });
});

function source(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function batch(size: number, stamps = true): Uint8Array {
  const doc = source();
  doc.clientID = 1;
  doc.transact(() => {
    for (let index = 0; index < size; index += 1) {
      const id = uuid(index);
      getDirectoryMap(doc).set(id, { title: "Decision 00000000", tags: [], kind: "decision" });
      if (stamps) doc.getMap("updatedAt").set(`${id}:writer`, 1_800_000_000_000 + index);
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

function workspace(store?: MirrorStore): WorkspaceReplicaSet {
  const config = testConfig({ compactAfter: 100_000 });
  const opened = openWorkspaceReplicas(config, { hubFree: true, ...(store === undefined ? {} : { store }) });
  workspaces.push(opened);
  return opened;
}

/** Count directory lookup and scanning work, independent of machine timing and sorting. */
function directoryWork(): { reads(): number } {
  let reads = 0;
  const relevant = (map: Y.Map<unknown>) => Object.is(map.doc?.share.get("docs"), map) || Object.is(map.doc?.share.get("updatedAt"), map);
  const entries = Y.Map.prototype.entries;
  vi.spyOn(Y.Map.prototype, "entries").mockImplementation(function* (this: Y.Map<unknown>) {
    for (const entry of entries.call(this)) {
      if (relevant(this)) reads += 1;
      yield entry;
    }
  });
  const get = Y.Map.prototype.get;
  vi.spyOn(Y.Map.prototype, "get").mockImplementation(function(this: Y.Map<unknown>, key: string) {
    if (relevant(this)) reads += 1;
    return get.call(this, key);
  });
  return { reads: () => reads };
}

describe("one directory batch", () => {
  const size = 256;

  it("bounds receipt, reconciliation and the next refresh to linear directory work", () => {
    const update = batch(size);
    const { replicas } = workspace();
    const work = directoryWork();
    Y.applyUpdate(replicas.directory().doc, update, "remote");
    replicas.refresh();
    expect(work.reads()).toBeLessThan(48 * size);
    expect(listDirectory(replicas.directory().doc)).toHaveLength(size);
    expect(getDirectoryEntry(replicas.directory().doc, uuid(size - 1))?.updatedAt).toBe(1_800_000_000_000 + size - 1);
    expect(replicas.indexReconciled(uuid(size - 1))).toBe(true);
    expect(replicas.known(uuid(size - 1))).toBe(true);
  });

  it.each(["tail", "snapshot"])("bounds %s replay and the next refresh to linear directory work", representation => {
    const update = batch(size);
    const config = testConfig();
    const store = new MirrorStore(":memory:", config.workspaceId);
    const room = directoryRoom(config.workspaceId);
    const seq = store.appendUpdate(room, update, "remote");
    if (representation === "snapshot") store.compact(room, update, seq);
    const work = directoryWork();
    const { replicas } = workspace(store);
    replicas.refresh();
    expect(work.reads()).toBeLessThan(48 * size);
    expect(listDirectory(replicas.directory().doc)).toHaveLength(size);
    expect(replicas.indexReconciled(uuid(size - 1))).toBe(true);
    expect(replicas.known(uuid(size - 1))).toBe(true);
  });

  it("reconciles all topic members when a peer process supplies the missing first stub and archives it", () => {
    const { replicas, store } = workspace();
    const first = uuid(1);
    const successor = uuid(2);
    const unrelated = uuid(3);
    const record = replicas.replica(successor);
    initDoc(record.doc, { uuid: successor, title: "Member survives restore", governs: unrelated, topic: first, supersedes: first });
    getMetaMap(record.doc).set("kind", "decision");
    getMetaMap(record.doc).set("status", "open");
    getDirectoryMap(replicas.directory().doc).set(successor, { title: "Member survives restore", tags: [], kind: "decision", topic: first });
    expect(store.isIndexed(successor)).toBe(true);
    expect(getDirectoryEntry(replicas.directory().doc, first)).toBeNull();

    const peer = source();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(replicas.directory().doc));
    const before = Y.encodeStateVector(peer);
    getDirectoryMap(peer).set(first, { title: "First record", tags: [], kind: "decision", deleted: true });
    store.appendUpdate(replicas.directory().room, Y.encodeStateAsUpdate(peer, before), "remote");
    replicas.refresh();
    expect(store.isIndexed(successor)).toBe(false);
    expect(listDirectory(replicas.directory().doc)).toEqual([]);
    expect(replicas.indexReconciled(successor)).toBe(true);

    const archived = Y.encodeStateVector(peer);
    getDirectoryMap(peer).set(first, { title: "First record", tags: [], kind: "decision" });
    store.appendUpdate(replicas.directory().room, Y.encodeStateAsUpdate(peer, archived), "remote");
    replicas.refresh();
    expect(store.isIndexed(successor)).toBe(true);
    expect(listDirectory(replicas.directory().doc).map(entry => entry.uuid)).toEqual([first, successor]);
  });

  // UB_DIRECTORY_BENCH=1 mise exec -- pnpm --filter @uberblick/mcp-server exec vitest run test/directory-batch.core.test.ts --silent=false -t measures
  it.skipIf(process.env.UB_DIRECTORY_BENCH !== "1")("measures the 8,000-stub update on receipt and both reopen paths", async () => {
    const update = batch(8_000, false);
    expect(update.byteLength).toBe(752_006);
    const times: Record<string, number> = { bytes: update.byteLength };
    let opened = workspace();
    try {
      let start = performance.now();
      Y.applyUpdate(opened.replicas.directory().doc, update, "remote");
      times.receiptMs = performance.now() - start;
      start = performance.now();
      opened.replicas.refresh();
      times.refreshMs = performance.now() - start;
      expect(listDirectory(opened.replicas.directory().doc)).toHaveLength(8_000);
    } finally { await opened.close(); }

    for (const representation of ["tail", "snapshot"]) {
      const config = testConfig();
      const store = new MirrorStore(":memory:", config.workspaceId);
      const room = directoryRoom(config.workspaceId);
      const seq = store.appendUpdate(room, update, "remote");
      if (representation === "snapshot") store.compact(room, update, seq);
      const start = performance.now();
      opened = workspace(store);
      const ready = performance.now();
      try {
        opened.replicas.refresh();
        times[`${representation}ReopenMs`] = ready - start;
        times[`${representation}RefreshMs`] = performance.now() - ready;
        expect(listDirectory(opened.replicas.directory().doc)).toHaveLength(8_000);
      } finally { await opened.close(); }
    }
    console.info(JSON.stringify(times));
  }, 300_000);
});

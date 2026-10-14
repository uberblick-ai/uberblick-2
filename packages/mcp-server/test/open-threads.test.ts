import { randomUUID } from "node:crypto";
import {
  addComment, createAnnotation, getDirectoryMap, getMeta, listAnnotations,
  roomForDoc, setAnnotationResolved, upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  hubUrl, LIVE_HUB_SETTLE, peerClient, removeTempDirs, startHub, startServer,
  tempDatabasePath, testConfig, TEST_SECRET, waitUntil, WORKSPACE,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.stop();
});
afterAll(removeTempDirs);

async function localRig(databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

async function seeded(rig: Rig, title = "Comments", fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title, description: "A document with comments.",
    blocks: [{ type: "paragraph", text: "one two three" }], ...fields,
  });
}

async function openThread(rig: Rig, doc: { uuid: string; blocks: { id: string }[] }, start = 0) {
  return rig.ok("annotate", {
    uuid: doc.uuid, block_id: doc.blocks[0]?.id, start, end: start + 3, text: "Question",
  });
}

function forgetCount(rig: Rig, uuid: string): void {
  const directory = getDirectoryMap(rig.instance.replicas.directory().doc);
  const entry = { ...(directory.get(uuid) as Record<string, unknown>) };
  delete entry.openThreadCount;
  directory.set(uuid, entry);
}

async function rows(rig: Rig, fields: Record<string, unknown> = {}): Promise<any[]> {
  return (await rig.ok("list_docs", fields)).docs;
}

describe("open comment threads through directory stubs", () => {
  it("counts threads rather than replies, including deleted anchors, and follows resolution immediately", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);
    expect(await rows(rig)).toMatchObject([{ uuid: doc.uuid, openThreadCount: 0 }]);
    expect(await rows(rig, { has_open_threads: true })).toEqual([]);

    const first = await openThread(rig, doc);
    expect(await rows(rig, { has_open_threads: true })).toMatchObject([{ uuid: doc.uuid, openThreadCount: 1 }]);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: first.annotation.id, text: "Reply" });
    expect(await rows(rig)).toMatchObject([{ openThreadCount: 1 }]);
    const second = await openThread(rig, doc, 4);
    expect(await rows(rig)).toMatchObject([{ openThreadCount: 2 }]);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: second.annotation.id, text: "Done", resolved: true });
    expect(await rows(rig)).toMatchObject([{ openThreadCount: 1 }]);

    await rig.ok("delete_block", { uuid: doc.uuid, block_id: doc.blocks[0].id });
    const annotations = (await rig.ok("get_doc", { uuid: doc.uuid })).annotations;
    expect(annotations).toHaveLength(2);
    expect(annotations.find((thread: any) => thread.id === first.annotation.id)).toMatchObject({ range: null });
    expect(annotations.find((thread: any) => thread.id === second.annotation.id)).toMatchObject({ range: null, resolved: true });
    expect(await rows(rig, { has_open_threads: true })).toMatchObject([{ openThreadCount: 1 }]);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: first.annotation.id, text: "Resolved", resolved: true });
    expect(await rows(rig)).toMatchObject([{ openThreadCount: 0 }]);
    expect(await rows(rig, { has_open_threads: true, include_superseded: true })).toEqual([]);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: first.annotation.id, text: "A reply to the resolved thread" });
    expect(await rows(rig)).toMatchObject([{ openThreadCount: 0 }]);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: first.annotation.id, text: "Reconsider", resolved: false });
    expect(await rows(rig, { has_open_threads: true })).toMatchObject([{ openThreadCount: 1 }]);
  });

  it("filters known regular caches, combines tags and archives, and refuses false without writing", async () => {
    const rig = await localRig();
    const directory = rig.instance.replicas.directory().doc;
    const [open, closed, unknown, otherTag, archived] = Array.from({ length: 5 }, () => randomUUID());
    for (const entry of [
      { uuid: open, tags: ["00000000-0000-4000-8000-000000000003"], openThreadCount: 2 },
      { uuid: closed, tags: ["00000000-0000-4000-8000-000000000003"], openThreadCount: 0 },
      { uuid: unknown, tags: ["00000000-0000-4000-8000-000000000003"] },
      { uuid: otherTag, tags: ["00000000-0000-4000-8000-000000000005"], openThreadCount: 1 },
      { uuid: archived, tags: ["00000000-0000-4000-8000-000000000003"], openThreadCount: 3, deleted: true },
    ]) getDirectoryMap(directory).set(entry.uuid as string, { title: "Cached regular", ...entry });

    expect((await rows(rig, { has_open_threads: true })).map(row => row.uuid).sort()).toEqual([open, otherTag].sort());
    expect(await rows(rig, { has_open_threads: true, tag: "mcp" })).toMatchObject([{ uuid: open, openThreadCount: 2 }]);
    expect((await rows(rig, { has_open_threads: true, tag: "mcp", include_deleted: true })).map(row => row.uuid).sort()).toEqual([open, archived].sort());
    expect(await rows(rig, { has_open_threads: true, status: "open" })).toEqual([]);
    expect(await rows(rig, { has_open_threads: true, kind: "decision" })).toEqual([]);
    expect((await rows(rig)).find(row => row.uuid === unknown)).not.toHaveProperty("openThreadCount");
    const before = rig.instance.store.logSize();
    expect((await rig.call("list_docs", { has_open_threads: false })).payload.error).toBe("schema_validation");
    expect(rig.instance.store.logSize()).toBe(before);
    for (const uuid of [open, closed, unknown, otherTag, archived]) expect(rig.instance.replicas.hydrated(uuid as string)).toBe(false);
  });

  it("matches topics through a superseded live record even when the representative has zero or unknown count", async () => {
    const rig = await localRig();
    const directory = rig.instance.replicas.directory().doc;
    const [first, superseded, current] = [randomUUID(), randomUUID(), randomUUID()] as const;
    for (const entry of [
      { uuid: first, createdAt: 1, openThreadCount: 0 },
      { uuid: superseded, createdAt: 2, supersedes: first, openThreadCount: 1, tags: ["00000000-0000-4000-8000-000000000005"] },
      { uuid: current, createdAt: 3, supersedes: superseded, openThreadCount: 0 },
    ]) upsertDirectoryEntry(directory, { title: "Topic", kind: "decision", status: "decided", topic: first, tags: [], ...entry });

    expect(await rows(rig, { has_open_threads: true })).toMatchObject([
      { uuid: current, openThreadCount: 0, inForce: { uuid: current, openThreadCount: 0 }, pending: [], conflicts: [] },
    ]);
    expect(await rows(rig, { has_open_threads: true, kind: "decision", status: "decided", tag: "sync", include_superseded: true })).toMatchObject([
      { uuid: superseded, openThreadCount: 1 },
    ]);
    forgetCount(rig, current);
    const topic = (await rows(rig, { has_open_threads: true }))[0];
    expect(topic.uuid).toBe(current);
    expect(topic).not.toHaveProperty("openThreadCount");
    expect(topic.inForce).not.toHaveProperty("openThreadCount");
    upsertDirectoryEntry(directory, { uuid: superseded, title: "Topic", openThreadCount: 0 });
    expect(await rows(rig, { has_open_threads: true })).toEqual([]);
    for (const uuid of [first, superseded, current]) expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
  });

  it("reports each projected record's own count and retains the existing topic predicate conjunction", async () => {
    const rig = await localRig();
    const directory = rig.instance.replicas.directory().doc;
    const [first, pending, fork, left, right, proposal] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
    for (const entry of [
      { uuid: first, topic: first, status: "decided", createdAt: 1, openThreadCount: 1 },
      { uuid: pending, topic: first, status: "open", supersedes: first, createdAt: 2, openThreadCount: 2 },
      { uuid: fork, topic: fork, status: "decided", createdAt: 3, openThreadCount: 0 },
      { uuid: left, topic: fork, status: "decided", supersedes: fork, createdAt: 4, openThreadCount: 4, tags: ["00000000-0000-4000-8000-000000000005"] },
      { uuid: right, topic: fork, status: "decided", supersedes: fork, createdAt: 5 },
      { uuid: proposal, topic: fork, status: "open", supersedes: left, createdAt: 6, openThreadCount: 5 },
    ] as const) upsertDirectoryEntry(directory, { title: "Topic", kind: "decision", ...entry, tags: [...(entry.tags ?? [])] });

    const listed = await rows(rig, { kind: "decision", has_open_threads: true });
    expect(listed.find(row => row.topic === first)).toMatchObject({
      uuid: first, openThreadCount: 1, inForce: { uuid: first, openThreadCount: 1 }, pending: [{ uuid: pending, openThreadCount: 2 }],
    });
    const conflicted = listed.find(row => row.topic === fork);
    expect(conflicted).toMatchObject({ uuid: proposal, openThreadCount: 5, inForce: null, pending: [{ uuid: proposal, openThreadCount: 5 }] });
    expect(conflicted.conflicts.find((record: any) => record.uuid === left)).toMatchObject({ openThreadCount: 4 });
    expect(conflicted.conflicts.find((record: any) => record.uuid === right)).not.toHaveProperty("openThreadCount");
    expect(await rows(rig, { kind: "decision", status: "open", tag: "sync", has_open_threads: true })).toMatchObject([{ topic: fork }]);
    expect(await rows(rig, { kind: "decision", status: "open", tag: "sync", has_open_threads: true, include_superseded: true })).toEqual([]);
    for (const uuid of [first, pending, fork, left, right, proposal]) expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
  });

  it("excludes rejected and withdrawn records from topic matching but includes their individual matching records and archives", async () => {
    const rig = await localRig();
    const directory = rig.instance.replicas.directory().doc;
    const [first, withdrawn] = [randomUUID(), randomUUID()] as const;
    upsertDirectoryEntry(directory, { uuid: first, title: "Inactive topic", kind: "decision", status: "rejected", topic: first, openThreadCount: 1 });
    upsertDirectoryEntry(directory, { uuid: withdrawn, title: "Inactive topic", kind: "decision", status: "withdrawn", topic: first, supersedes: first, openThreadCount: 2 });
    expect(await rows(rig, { has_open_threads: true })).toEqual([]);
    expect((await rows(rig, { has_open_threads: true, include_superseded: true })).map(row => row.uuid).sort()).toEqual([first, withdrawn].sort());
    expect(await rows(rig, { has_open_threads: true, status: "rejected", include_superseded: true })).toMatchObject([{ uuid: first, openThreadCount: 1 }]);
    getDirectoryMap(directory).set(first, { ...(getDirectoryMap(directory).get(first) as object), deleted: true });
    expect(await rows(rig, { has_open_threads: true, include_superseded: true })).toEqual([]);
    expect(await rows(rig, { has_open_threads: true, status: "withdrawn", include_superseded: true, include_deleted: true })).toMatchObject([{ uuid: withdrawn, deleted: true, openThreadCount: 2 }]);
  });

  it("repairs a dropped whole-entry cache on document updates and replay, while archived regular stubs wait for restore", async () => {
    const databasePath = tempDatabasePath();
    const author = await localRig(databasePath);
    const live = await seeded(author, "Live");
    const archived = await seeded(author, "Archived");
    const decision = await seeded(author, "Decision", { kind: "decision" });
    await openThread(author, live);
    await openThread(author, archived);
    await author.ok("archive_doc", { uuid: archived.uuid });
    for (const doc of [live, archived, decision]) forgetCount(author, doc.uuid);
    expect(await rows(author, { has_open_threads: true })).toEqual([]);
    expect((await rows(author, { include_deleted: true })).find(row => row.uuid === live.uuid)).not.toHaveProperty("openThreadCount");
    await author.ok("insert_block", { uuid: live.uuid, type: "paragraph", text: "A later document change" });
    expect(await rows(author, { has_open_threads: true })).toMatchObject([{ uuid: live.uuid, openThreadCount: 1 }]);
    forgetCount(author, live.uuid);
    await author.close();
    rigs.splice(rigs.indexOf(author), 1);

    const restarted = await localRig(databasePath);
    expect(await rows(restarted, { has_open_threads: true })).toMatchObject([{ uuid: live.uuid, openThreadCount: 1 }]);
    expect(await rows(restarted, { kind: "decision" })).toMatchObject([{ uuid: decision.uuid, openThreadCount: 0 }]);
    expect((await rows(restarted, { include_deleted: true })).find(row => row.uuid === archived.uuid)).not.toHaveProperty("openThreadCount");
    await restarted.ok("restore_doc", { uuid: archived.uuid });
    expect((await rows(restarted, { has_open_threads: true })).map(row => [row.uuid, row.openThreadCount]).sort()).toEqual([[live.uuid, 1], [archived.uuid, 1]].sort());
  });

  it("backfills a hydrated peer document and follows peer open, reply, resolve and reopen updates through the hub", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const config = () => testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE });
    const author = await startServer(config());
    rigs.push(author);
    const doc = await seeded(author);
    const peer = await peerClient(hub.port, roomForDoc(WORKSPACE, doc.uuid));
    peers.push(peer);
    await waitUntil("the peer to hydrate the document", () => getMeta(peer.doc).uuid === doc.uuid);
    await author.close();
    rigs.splice(rigs.indexOf(author), 1);

    const first = createAnnotation(peer.doc, doc.blocks[0].id, 0, 3, "Peer", "Initial discussion");
    const observer = await startServer(config());
    rigs.push(observer);
    await waitUntil("the fresh MCP replica to hydrate the peer's first thread", async () =>
      (await rows(observer, { has_open_threads: true })).some(row => row.uuid === doc.uuid && row.openThreadCount === 1),
    );
    expect(observer.instance.replicas.hydrated(doc.uuid)).toBe(true);

    const second = createAnnotation(peer.doc, doc.blocks[0].id, 4, 7, "Peer", "Another question");
    await waitUntil("the MCP directory to count the peer's new thread", async () =>
      (await rows(observer))[0]?.openThreadCount === 2,
    );
    addComment(peer.doc, first.id, "Peer", "Reply");
    await waitUntil("the MCP replica to receive the peer's reply", () =>
      listAnnotations(observer.instance.replicas.replica(doc.uuid).doc).find(thread => thread.id === first.id)?.comments.length === 2,
    );
    expect(await rows(observer, { has_open_threads: true })).toMatchObject([{ uuid: doc.uuid, openThreadCount: 2 }]);
    peer.doc.transact(() => {
      setAnnotationResolved(peer.doc, first.id, true);
      setAnnotationResolved(peer.doc, second.id, true);
    });
    await waitUntil("the MCP directory to reflect resolution of the last peer thread", async () =>
      (await rows(observer))[0]?.openThreadCount === 0,
    );
    expect(await rows(observer, { has_open_threads: true })).toEqual([]);
    setAnnotationResolved(peer.doc, first.id, false);
    await waitUntil("the MCP directory to reflect the reopened peer thread", async () =>
      (await rows(observer, { has_open_threads: true }))[0]?.openThreadCount === 1,
    );
  });
});

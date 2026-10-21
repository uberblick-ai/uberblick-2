import { randomUUID } from "node:crypto";
import { deleteBlock, getDirectoryMap, upsertDirectoryEntry } from "@uberblick/schema";

import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestResources, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
  });
});

async function localRig(databasePath = ":memory:"): Promise<Rig> {
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

    deleteBlock(rig.instance.replicas.replica(doc.uuid).doc, doc.blocks[0].id);
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

});

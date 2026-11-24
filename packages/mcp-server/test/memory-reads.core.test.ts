import { randomUUID } from "node:crypto";
import { compareDirectoryEntries, initDoc, setKind, setMemoryAgent, setMemoryRepository, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import type { Rig } from "./core-helpers.js";
import { startServer } from "./core-helpers.js";

let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });

it("filters each memory scope independently, omits archived entries and answers from directory rows", async () => {
  rig = await startServer();
  const directory = rig.instance.replicas.directory();
  const fixtures = [
    { title: "All agents and repositories" },
    { title: "All agents in this repository", repository: "uberblick-ai/uberblick-2" },
    { title: "All agents in another repository", repository: "owner/other" },
    { title: "Implementer in all repositories", agent: "implementer" },
    { title: "Implementer in this repository", agent: "implementer", repository: "uberblick-ai/uberblick-2" },
    { title: "Implementer in another repository", agent: "implementer", repository: "owner/other" },
    { title: "Reviewer in all repositories", agent: "reviewer" },
    { title: "Reviewer in this repository", agent: "reviewer", repository: "uberblick-ai/uberblick-2" },
    { title: "Reviewer in another repository", agent: "reviewer", repository: "owner/other" },
  ];
  const memories = fixtures.map(scope => ({
    uuid: randomUUID(), kind: "memory" as const, description: "Directory-only discovery.",
    updatedAt: Date.UTC(2026, 10, 24), ...scope,
  })).sort(compareDirectoryEntries);
  directory.doc.transact(() => {
    for (const memory of memories) upsertDirectoryEntry(directory.doc, memory);
    const archived = randomUUID();
    upsertDirectoryEntry(directory.doc, { uuid: archived, title: "Archived memory", kind: "memory" });
    tombstoneDirectoryEntry(directory.doc, archived);
    upsertDirectoryEntry(directory.doc, { uuid: randomUUID(), title: "Regular page" });
    upsertDirectoryEntry(directory.doc, { uuid: randomUUID(), title: "Decision", kind: "decision", status: "open" });
  });
  await rig.instance.replicas.settle();
  const opening = vi.spyOn(rig.instance.replicas, "replica");
  const touching = vi.spyOn(rig.instance.replicas, "touch");
  const before = rig.instance.store.logSize();
  const applicable = await rig.ok("get_memories", { agent: "implementer", repository: "Uberblick-Ai/Uberblick-2" });
  const matching = memories.filter(memory => (!memory.agent || memory.agent === "implementer") &&
    (!memory.repository || memory.repository === "uberblick-ai/uberblick-2"));
  expect(applicable).toMatchObject({ workspace: rig.config.workspaceId, complete: true });
  expect(applicable).not.toHaveProperty("directoryHint");
  expect(applicable.memories).toEqual(matching.map(({ kind: _kind, updatedAt: _stamp, ...memory }) => ({
    ...memory, updatedAt: "2026-11-24T00:00:00.000Z",
  })));
  expect((await rig.ok("get_memories", { agent: "implementer" })).memories.map((memory: any) => memory.uuid))
    .toEqual(memories.filter(memory => !memory.agent || memory.agent === "implementer").map(memory => memory.uuid));
  expect((await rig.ok("get_memories", { repository: "uberblick-ai/uberblick-2" })).memories.map((memory: any) => memory.uuid))
    .toEqual(memories.filter(memory => !memory.repository || memory.repository === "uberblick-ai/uberblick-2").map(memory => memory.uuid));
  expect((await rig.ok("get_memories")).memories).toHaveLength(memories.length);
  expect(opening).not.toHaveBeenCalled();
  expect(touching).not.toHaveBeenCalled();
  expect(rig.instance.store.logSize()).toBe(before);
  for (const memory of memories) expect(rig.instance.replicas.hydrated(memory.uuid)).toBe(false);

  vi.spyOn(rig.instance.replicas, "roomComplete").mockReturnValue(false);
  expect(await rig.ok("get_memories")).toMatchObject({ complete: false, directoryHint: expect.stringContaining("sync_status") });
});

it("refuses malformed memory filters with recovery without changing the replica", async () => {
  rig = await startServer();
  const before = rig.instance.store.logSize();
  for (const [field, value] of [
    ["agent", "Implementer"], ["agent", " implementer"], ["agent", ""], ["agent", null],
    ["repository", "uberblick-2"], ["repository", "https://github.com/owner/repo"], ["repository", " "], ["repository", 17],
  ] as const) {
    expect(await rig.call("get_memories", { [field]: value })).toMatchObject({
      isError: true, payload: { error: `invalid_memory_${field}`, recoveryClass: "manual", recovery: expect.any(String) },
    });
  }
  expect(rig.instance.store.logSize()).toBe(before);
});

it("keeps memory kind distinct in list and search, including after an index rebuild", async () => {
  rig = await startServer();
  const regular = await rig.ok("create_doc", { title: "Sharedword regular", description: "A regular page." });
  const memory = randomUUID();
  const replica = rig.instance.replicas.replica(memory);
  replica.doc.transact(() => {
    initDoc(replica.doc, { uuid: memory, title: "Sharedword memory", description: "A scoped note." });
    setKind(replica.doc, "memory");
    setMemoryAgent(replica.doc, "implementer");
    setMemoryRepository(replica.doc, "uberblick-ai/uberblick-2");
  });
  const checkDiscovery = async () => {
    expect((await rig!.ok("list_docs")).docs.map((entry: any) => entry.uuid)).toEqual([regular.uuid]);
    expect((await rig!.ok("list_docs", { include_deleted: true })).docs.map((entry: any) => entry.uuid)).toEqual([regular.uuid]);
    expect((await rig!.ok("list_docs", { kind: "memory" })).docs).toEqual([
      expect.objectContaining({ uuid: memory, kind: "memory", agent: "implementer", repository: "uberblick-ai/uberblick-2" }),
    ]);
    expect((await rig!.ok("search", { query: "Sharedword", kind: "memory" })).hits).toEqual([
      expect.objectContaining({ uuid: memory, kind: "memory" }),
    ]);
    expect((await rig!.ok("search", { query: "Sharedword", kind: "regular" })).hits.map((entry: any) => entry.uuid)).toEqual([regular.uuid]);
    expect((await rig!.ok("search", { query: "Sharedword" })).hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: memory, kind: "memory" }), expect.objectContaining({ uuid: regular.uuid, kind: "regular" }),
    ]));
  };
  await checkDiscovery();
  rig.instance.replicas.rebuildIndex();
  await checkDiscovery();
  await rig.ok("archive_doc", { uuid: memory });
  expect((await rig.ok("get_memories")).memories).toEqual([]);
  expect((await rig.ok("search", { query: "Sharedword", kind: "memory" })).hits).toEqual([]);
  expect((await rig.ok("list_docs", { kind: "memory", include_deleted: true })).docs).toEqual([
    expect.objectContaining({ uuid: memory, kind: "memory", deleted: true }),
  ]);
  await rig.ok("restore_doc", { uuid: memory });
  await checkDiscovery();
});

it("repairs legacy regular classification at equal source cuts while refusing stale memory derivations", async () => {
  rig = await startServer();
  const store = rig.instance.store;
  const row = { uuid: randomUUID(), title: "Memoryclassification", description: "", body: "", tags: [], links: [] };
  expect(store.indexDoc({ ...row, kind: "regular" }, 7, 3)).toBe(true);
  expect(store.indexDoc({ ...row, kind: "memory" }, 7, 3)).toBe(true);
  expect(store.search("Memoryclassification", 10, undefined, "memory")).toEqual([
    expect.objectContaining({ uuid: row.uuid, kind: "memory" }),
  ]);
  expect(store.search("Memoryclassification", 10, undefined, "regular")).toEqual([]);
  expect(store.indexDoc({ ...row, kind: "regular" }, 6, 3)).toBe(false);
  expect(store.indexDoc({ ...row, kind: "regular" }, 7, 2)).toBe(false);
  expect(store.search("Memoryclassification", 10)[0]?.kind).toBe("memory");
});

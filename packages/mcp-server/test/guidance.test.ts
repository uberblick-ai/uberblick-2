import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTagCatalogEntry, retireTagCatalogEntry, restoreTagCatalogEntry,
  setTags, setTitle, tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "@uberblick/schema";
import { DOCUMENT_MUTATING_TOOLS } from "../src/failures.js";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const marker = "5a7808ea-1c79-4330-af35-3f67f9f38a3b";
async function local(config = testConfig()): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}
async function doc(rig: Rig, title: string) {
  return rig.ok("create_doc", {
    title, description: "Guidance test fixture.",
    blocks: [{ type: "paragraph", text: "Read before writing." }],
  });
}
function mark(rig: Rig, ...uuids: string[]) {
  createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance", marker);
  for (const uuid of uuids) setTags(rig.instance.replicas.replica(uuid).doc, [marker]);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  removeTempDirs();
});

it("refuses every document mutation before logging, teaches recovery, and leaves reads and navigation usable", async () => {
  const rig = await local();
  const first = await doc(rig, "Editorial guidance");
  const second = await doc(rig, "Tagging guidance");
  const target = await doc(rig, "Target");
  const archived = await doc(rig, "Archived target");
  await rig.ok("archive_doc", { uuid: archived.uuid });
  const read = await rig.ok("get_doc", { uuid: target.uuid });
  const block = read.blocks[0];
  mark(rig, first.uuid, second.uuid);
  const uuid = target.uuid;
  const calls: Record<string, Record<string, unknown>> = {
    create_doc: { title: "Must not exist", description: "Refused creation." },
    edit_block: { uuid, block_id: block.id, old_text: block.text, new_text: "Changed", rev: block.rev },
    insert_block: { uuid, type: "paragraph", text: "Changed" },
    delete_block: { uuid, block_id: block.id },
    set_tags: { uuid, tags: [] }, set_links: { uuid, links: [] },
    set_title: { uuid, title: "Changed" }, set_description: { uuid, description: "Changed" },
    set_tldr: { uuid, tldr: "Changed" }, set_status: { uuid, status: "planned" },
    set_changelog_suggestion: { uuid, suggestion: "Changed" },
    archive_doc: { uuid: first.uuid }, restore_doc: { uuid: archived.uuid },
    annotate: { uuid, block_id: block.id, start: 0, end: 4, text: "Comment" },
    link_range: { uuid, block_id: block.id, start: 0, end: 4, doc_id: first.uuid, rev: block.rev },
  };
  expect(Object.keys(calls).sort()).toEqual([...DOCUMENT_MUTATING_TOOLS].sort());
  const size = rig.instance.store.logSize();
  for (const [name, args] of Object.entries(calls)) {
    const result = await rig.call(name, args);
    expect(result, name).toMatchObject({ isError: true, payload: {
      error: "guidance_required", applied: false, partial: false, synced: false,
      recoveryClass: "reread", recovery: expect.stringMatching(/get_doc.*retry/),
      unread: expect.arrayContaining([
        { uuid: first.uuid, title: "Editorial guidance" }, { uuid: second.uuid, title: "Tagging guidance" },
      ]),
    } });
    expect(rig.instance.store.logSize(), name).toBe(size);
  }
  for (const [name, args] of [
    ["list_docs", {}], ["list_tags", {}], ["search", { query: "writing" }],
    ["backlinks", { uuid }], ["export_markdown", { uuid }], ["sync_status", {}], ["get_sidebar", {}],
    ["find_decisions", { github_ref: "owner/repo#1" }],
  ] as const) await rig.ok(name, args);
  await rig.ok("pin_doc", { uuid, group: "Reference" });
  const sidebar = await rig.ok("get_sidebar");
  await rig.ok("sidebar_group", { group: sidebar.groups[0].id, action: "rename", name: "Notes" });
  await rig.ok("unpin_doc", { uuid });
  const beforeReads = rig.instance.store.logSize();
  await rig.ok("get_doc", { uuid: first.uuid });
  expect((await rig.call("set_title", calls.set_title)).payload.unread).toEqual([
    { uuid: second.uuid, title: "Tagging guidance" },
  ]);
  await rig.ok("get_doc", { uuid: second.uuid });
  expect(rig.instance.store.logSize()).toBe(beforeReads);
  expect(await rig.ok("set_title", calls.set_title)).toMatchObject({ applied: true, tagHint: expect.any(String) });
  expect((await rig.ok("get_doc", { uuid })).title).toBe("Changed");
});

it("keeps a lease through guidance changes, expires without wall-clock sleeps, and forgets it on restart", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const config = testConfig();
  const rig = await local(config);
  const first = await doc(rig, "First");
  const next = await doc(rig, "Next");
  mark(rig, first.uuid);
  await rig.ok("get_doc", { uuid: first.uuid });
  now += 300_000;
  await rig.ok("get_doc", { uuid: first.uuid }); // A reread must not extend the lease.
  setTags(rig.instance.replicas.replica(next.uuid).doc, [marker]);
  now += 299_999;
  await rig.ok("set_title", { uuid: first.uuid, title: "Changed in lease" });
  now += 1;
  const refusal = await rig.call("set_title", { uuid: first.uuid, title: "After expiry" });
  expect(refusal.payload.unread.map((item: { uuid: string }) => item.uuid).sort()).toEqual([first.uuid, next.uuid].sort());
  // A read stops counting once its document leaves the guidance set, so re-marking makes it unread again.
  await rig.ok("get_doc", { uuid: first.uuid });
  setTags(rig.instance.replicas.replica(first.uuid).doc, []);
  expect((await rig.call("set_title", { uuid: first.uuid, title: "While unmarked" })).payload.unread)
    .toEqual([{ uuid: next.uuid, title: "Next" }]);
  setTitle(rig.instance.replicas.replica(first.uuid).doc, "Revised while unmarked");
  setTags(rig.instance.replicas.replica(first.uuid).doc, [marker]);
  const remarked = await rig.call("set_title", { uuid: first.uuid, title: "After remarking" });
  expect(remarked.payload.unread.map((item: { uuid: string }) => item.uuid).sort()).toEqual([first.uuid, next.uuid].sort());
  await rig.ok("get_doc", { uuid: next.uuid });
  expect((await rig.call("set_title", { uuid: first.uuid, title: "Only next read" })).payload.unread)
    .toEqual([{ uuid: first.uuid, title: "Revised while unmarked" }]);
  await rig.ok("get_doc", { uuid: first.uuid });
  now += 600_000; // Drop the lease that completed and continue from the expired state above.
  await rig.ok("get_doc", { uuid: first.uuid });
  // Curation removes the last unread guide: the next write completes briefing.
  setTags(rig.instance.replicas.replica(next.uuid).doc, []);
  await rig.ok("set_title", { uuid: first.uuid, title: "Briefed again" });
  setTags(rig.instance.replicas.replica(next.uuid).doc, [marker]);
  await rig.ok("set_title", { uuid: first.uuid, title: "Still briefed" });
  await rig.close();
  const restarted = await local(config);
  expect((await restarted.call("set_title", { uuid: first.uuid, title: "Restarted" })).payload.error).toBe("guidance_required");
});

it("lists and serves current guidance independently of leases and stale cached tags", async () => {
  const rig = await local();
  const first = await doc(rig, "First");
  const next = await doc(rig, "Next");
  mark(rig, first.uuid);
  const replicas = rig.instance.replicas;
  // Cached tags lie in both directions; hydrated document assignments win.
  upsertDirectoryEntry(replicas.directory().doc, { uuid: first.uuid, title: "Stale", tags: [] });
  upsertDirectoryEntry(replicas.directory().doc, { uuid: next.uuid, title: "Next", tags: [marker] });
  const resources = await rig.client.listResources();
  expect(resources.resources).toMatchObject([{ uri: `uberblick://doc/${first.uuid}`, title: "First", name: first.uuid }]);
  const size = rig.instance.store.logSize();
  expect((await rig.client.readResource({ uri: `uberblick://doc/${first.uuid}` })).contents[0]).toMatchObject({ text: expect.stringContaining("Read before writing.") });
  expect(rig.instance.store.logSize()).toBe(size);
  expect((await rig.call("set_title", { uuid: next.uuid, title: "Refused" })).payload.error).toBe("guidance_required");
  await rig.ok("get_doc", { uuid: first.uuid });
  setTags(replicas.replica(next.uuid).doc, [marker]);
  setTitle(replicas.replica(next.uuid).doc, "Current title");
  expect((await rig.client.listResources()).resources).toHaveLength(2);
  expect((await rig.client.readResource({ uri: `uberblick://doc/${next.uuid}` })).contents[0]).toMatchObject({ text: expect.stringContaining("Current title") });
  tombstoneDirectoryEntry(replicas.directory().doc, first.uuid);
  expect((await rig.client.listResources()).resources).toMatchObject([{ title: "Current title" }]);
  await expect(rig.client.readResource({ uri: `uberblick://doc/${first.uuid}` })).rejects.toThrow("No locally readable guidance");
  retireTagCatalogEntry(replicas.settings().doc, marker);
  expect((await rig.client.listResources()).resources).toEqual([]);
  restoreTagCatalogEntry(replicas.settings().doc, marker);
  expect((await rig.client.listResources()).resources).toHaveLength(1);
});

it("is inert for absent or retired markers and for archived or unhydrated guidance", async () => {
  const rig = await local();
  const guide = await doc(rig, "Guide");
  const replicas = rig.instance.replicas;
  // An assignment may arrive before its catalog identity.
  setTags(replicas.replica(guide.uuid).doc, [marker]);
  await rig.ok("set_title", { uuid: guide.uuid, title: "Absent marker" });
  mark(rig, guide.uuid);
  retireTagCatalogEntry(replicas.settings().doc, marker);
  await rig.ok("set_title", { uuid: guide.uuid, title: "Retired marker" });
  restoreTagCatalogEntry(replicas.settings().doc, marker);
  tombstoneDirectoryEntry(replicas.directory().doc, guide.uuid);
  upsertDirectoryEntry(replicas.directory().doc, { uuid: randomUUID(), title: "Not hydrated", tags: [marker] });
  const result = await doc(rig, "No readable guidance");
  expect(result.applied).toBe(true);
  expect(result).not.toHaveProperty("unread");
  expect((await rig.client.listResources()).resources).toEqual([]);
});


it("refreshes guidance resources from another process's durable local updates", async () => {
  const config = testConfig();
  const reader = await local(config);
  const writer = await local(config);
  const guide = await doc(writer, "Another process");
  mark(writer, guide.uuid);
  expect((await reader.client.listResources()).resources).toMatchObject([{ title: "Another process" }]);
  setTitle(writer.instance.replicas.replica(guide.uuid).doc, "Updated remotely");
  expect((await reader.client.readResource({ uri: `uberblick://doc/${guide.uuid}` })).contents[0]).toMatchObject({ text: expect.stringContaining("Updated remotely") });
  retireTagCatalogEntry(writer.instance.replicas.settings().doc, marker);
  expect((await reader.client.listResources()).resources).toEqual([]);
});

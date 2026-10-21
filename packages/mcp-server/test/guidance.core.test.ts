

import { afterEach, expect, it, vi } from "vitest";
import { createTagCatalogEntry, setTags } from "@uberblick/schema";
import { tools } from "../src/tool-table.js";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

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
/** Static product help shares resources/list without changing guidance visibility. */

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
    set_metadata: { uuid, title: "Changed" }, set_status: { uuid, status: "open" },
    update_data: { uuid, operations: [] },
    archive_doc: { uuid: first.uuid }, restore_doc: { uuid: archived.uuid },
    delete_doc: { uuid: archived.uuid },
    annotate: { uuid, block_id: block.id, start: 0, end: 4, text: "Comment" },
    link_range: { uuid, block_id: block.id, start: 0, end: 4, doc_id: first.uuid, rev: block.rev },
  };
  expect(Object.keys(calls).sort()).toEqual(tools.filter(({ writes }) => writes === "document").map(({ name }) => name).sort());
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
  expect((await rig.call("set_metadata", calls.set_metadata)).payload.unread).toEqual([
    { uuid: second.uuid, title: "Tagging guidance" },
  ]);
  await rig.ok("get_doc", { uuid: second.uuid });
  expect(rig.instance.store.logSize()).toBe(beforeReads);
  expect(await rig.ok("set_metadata", calls.set_metadata)).toMatchObject({ applied: true, tagHint: expect.any(String) });
  expect((await rig.ok("get_doc", { uuid })).title).toBe("Changed");
});

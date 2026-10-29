import { randomUUID } from "node:crypto";
import { appendBlock, createAnnotation, decisionApprovalFingerprint, findBlockElement, getBlocksFragment, getMetaMap, initDoc, setKind, setStatus } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
async function localRig(databasePath?: string): Promise<Rig> {
  const rig = await startServer(testConfig(databasePath === undefined ? {} : { databasePath }));
  rigs.push(rig);
  return rig;
}
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

const GFM = "| Name | Value |\n| --- | --- |\n| Alpha | Beta |";

/** Old persisted shape, including a real thread anchored in its source. */
function legacy(source: string, decided = false): { doc: Y.Doc; id: string; threadId: string } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: randomUUID(), title: "Legacy", description: "A synthetic legacy table." });
  const id = appendBlock(doc, { type: "paragraph", text: source });
  const thread = createAnnotation(doc, id, 0, 1, "Reader", "Existing conversation");
  const old = findBlockElement(doc, id)!;
  const table = new Y.XmlElement("table");
  table.setAttribute("id", id);
  table.insert(0, [(old.firstChild as Y.XmlText).clone()]);
  doc.transact(() => {
    getBlocksFragment(doc).insert(0, [table]);
    getBlocksFragment(doc).delete(1, 1);
  });
  if (decided) {
    setKind(doc, "decision");
    setStatus(doc, "decided");
    getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
  }
  return { doc, id, threadId: thread.id };
}

describe("structured tables through MCP", () => {

  it("refuses missing, misplaced, outside, empty and overlapping cell ranges before a write", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Cell refusals", description: "Refusals are atomic.",
      blocks: [{ type: "table", text: GFM }, { type: "paragraph", text: "Prose" }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const args = { uuid: created.uuid, block_id: id, start: 0, end: 3, text: "Thread" };
    await rig.ok("annotate", { ...args, row: 1, column: 0 });
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const extra of [{}, { row: 1 }, { column: 0 }, { row: 2, column: 0 }, { row: 1, column: 2 },
      { block_id: created.blocks[1].id, row: 0, column: 0 }]) {
      const refused = await rig.call("annotate", { ...args, ...extra });
      expect(refused.payload).toMatchObject({ error: "annotation_cell", recoveryClass: "manual",
        applied: false, partial: false, synced: false });
      expect(refused.payload.recovery).toContain("row and column");
    }
    for (const offsets of [{ start: 1, end: 4 }, { start: 99, end: 100 }]) {
      const refused = await rig.call("annotate", { ...args, row: 1, column: 0, ...offsets });
      expect(refused.payload).toMatchObject({ error: "annotation_range", applied: false });
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const help = await rig.ok("get_help", { topic: "annotate" });
    expect(help.text).toContain("header as row 0");
    const thread = (await rig.ok("get_doc", { uuid: created.uuid })).annotations[0];
    for (const coordinates of [{ row: 0 }, { column: 0 }, { row: 0, column: 0 }]) {
      const refused = await rig.call("annotate", { uuid: created.uuid, thread_id: thread.id, text: "Reply", ...coordinates });
      expect(refused.payload.error).toBe("schema_validation");
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const prose = await rig.ok("annotate", { ...args, block_id: created.blocks[1].id });
    expect(prose.annotation.range).toEqual({ start: 0, end: 3, collapsed: false });
  });

  it("advertises a strict optional mapping and refuses malformed shapes at the MCP boundary", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Mapping input", description: "The advertised schema and actual input boundary agree.",
      blocks: [{ type: "table", text: GFM }],
    });
    const tool = (await rig.client.listTools()).tools.find(tool => tool.name === "edit_block")!;
    const help = await rig.ok("get_help", { topic: "edit_block" });
    expect(help.text).toContain("table_mapping_required");
    expect(help.text).toContain("invalid_table_mapping");
    const mappingSchema = (tool.inputSchema.properties as Record<string, any>).table_mapping;
    expect(mappingSchema.additionalProperties).toBe(false);
    expect(mappingSchema.required).toEqual(["rows", "columns"]);
    expect(tool.inputSchema.required).not.toContain("table_mapping");
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const state = Y.encodeStateAsUpdate(doc);
    for (const mapping of [
      { rows: [0, 1] }, { columns: [0, 1] },
      { rows: [0, 1], columns: [0, 1], force: true },
      { rows: [0, -1], columns: [0, 1] },
      { rows: [0, 1.5], columns: [0, 1] },
      { rows: [0, Number.MAX_SAFE_INTEGER + 1], columns: [0, 1] },
      { rows: [0, "1"], columns: [0, 1] }, null,
    ]) {
      const refused = await rig.call("edit_block", {
        uuid: created.uuid, block_id: created.blocks[0].id, old_text: GFM, new_text: GFM, table_mapping: mapping,
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload.error).toBe("schema_validation");
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("opens cell threads while preserving orphaned legacy conversations and their lifecycle", async () => {
    const rig = await localRig();
    const old = legacy(GFM);
    const uuid = getMetaMap(old.doc).get("uuid") as string;
    const replica = rig.instance.replicas.replica(uuid);
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(old.doc));
    old.doc.destroy();
    const read = await rig.ok("get_doc", { uuid });
    expect(read.blocks[0]).toMatchObject({ id: old.id, type: "table", text: GFM });
    expect(read.annotations[0]).toMatchObject({ id: old.threadId, range: null });
    const state = Y.encodeStateVector(replica.doc);
    const refused = await rig.call("annotate", { uuid, block_id: old.id, start: 0, end: 3, text: "New thread" });
    expect(refused.payload).toMatchObject({ error: "annotation_cell", applied: false, blockId: old.id });
    expect(Y.encodeStateVector(replica.doc)).toEqual(state);
    for (const resolved of [undefined, true]) {
      const reply = await rig.ok("annotate", { uuid, thread_id: old.threadId, text: "Reply", resolved });
      expect(reply.annotation).toMatchObject({ range: null });
      expect(reply.annotation.resolved).toBe(resolved);
    }
    const created = await rig.ok("annotate", { uuid, block_id: old.id, row: 1, column: 0, start: 1, end: 4, text: "New cell thread" });
    expect(created.annotation.range).toEqual({ row: 1, column: 0, start: 1, end: 4, collapsed: false });
    const annotations = (await rig.ok("get_doc", { uuid })).annotations;
    expect(annotations.find((entry: { id: string }) => entry.id === old.threadId)).toMatchObject({ range: null, comments: expect.any(Array) });
    expect(annotations.find((entry: { id: string }) => entry.id === old.threadId).comments).toHaveLength(3);
    const help = await rig.ok("get_help", { topic: "annotate" });
    expect(help.text).toContain("zero-based GFM projection");
  });

});

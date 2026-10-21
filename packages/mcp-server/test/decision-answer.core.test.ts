import * as Y from "yjs";
import { getMeta, getMetaMap, setKind, setStatus, setTldr } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const attribution = { who: "A person", when: "2026-10-12", where: "A team discussion." };
const paragraph = { type: "paragraph", text: "Use the log because replay preserves history." };

async function local() {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Answer", description: "A short decision answer.", kind: "decision", ...fields });
}

function state(rig: Rig, uuid?: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    ...(uuid === undefined ? {} : { document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc) }),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, tool: string, args: Record<string, unknown>, error: string, uuid?: string) {
  const before = state(rig, uuid);
  expect(await rig.call(tool, args)).toMatchObject({ isError: true, payload: {
    error, applied: false, partial: false, synced: false, recoveryClass: "manual", recovery: expect.any(String),
  } });
  expect(state(rig, uuid)).toEqual(before);
}

afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
afterAll(removeTempDirs);

describe("short decision answers", () => {
  it("refuses every unsupported seed and insert atomically, including invalid card source", async () => {
    const rig = await local();
    const open = await create(rig);
    for (const type of ["heading", "quote", "terminal", "chart", "card"]) {
      await refuse(rig, "create_doc", { title: "Unsupported", description: "Use supported answer blocks.", kind: "decision", blocks: [{ type, text: "answer" }] }, "decision_block_unsupported");
      await refuse(rig, "insert_block", { uuid: open.uuid, blocks: [{ type, text: "answer" }] }, "decision_block_unsupported", open.uuid);
    }
    await refuse(rig, "create_doc", { title: "Too long", description: "Three blocks at most.", kind: "decision", blocks: Array.from({ length: 4 }, () => paragraph) }, "decision_answer_too_long");
  });

  it("counts adjacent list items as one and checks the insertion position when a list is split", async () => {
    const rig = await local();
    const record = await create(rig, { blocks: [paragraph, { type: "list-item", text: "First" }, { type: "list-item", text: "Second" }, { type: "code", text: "replay()" }] });
    await rig.ok("insert_block", { uuid: record.uuid, after_block_id: record.blocks[1].id, blocks: [{ type: "list-item", text: "Third" }] });
    await refuse(rig, "insert_block", { uuid: record.uuid, after_block_id: record.blocks[1].id, blocks: [{ type: "paragraph", text: "Splits the list." }] }, "decision_answer_too_long", record.uuid);
    await refuse(rig, "insert_block", { uuid: record.uuid, blocks: [{ type: "paragraph", text: "Fourth block." }] }, "decision_answer_too_long", record.uuid);
    await rig.ok("set_status", { uuid: record.uuid, status: "decided" });
    for (const blocks of [
      [{ type: "code", text: "replay()" }],
      [{ type: "table", text: "| Answer | Reason |\n| --- | --- |\n| Use the log | Replay |" }],
    ]) expect(await create(rig, { status: "decided", blocks })).toMatchObject({ status: "decided", agentStance: true });
  });

  it("requires nonblank stored answer text for creation and deciding, including inline overrides", async () => {
    const rig = await local();
    for (const blocks of [[], [{ type: "paragraph", text: " \n " }], [{ type: "code", text: " \t " }], [{ ...paragraph, inline: [{ text: "  ", marks: { bold: true } }] }]]) {
      await refuse(rig, "create_doc", { title: "Empty", description: "No nonblank answer.", kind: "decision", status: "decided", blocks }, "decision_answer_empty");
      const open = await create(rig, { blocks });
      await refuse(rig, "set_status", { uuid: open.uuid, status: "decided", answer: attribution }, "decision_answer_empty", open.uuid);
    }
    const decided = await create(rig, { status: "decided", blocks: [{ type: "paragraph", text: "", inline: [{ text: "Use the log.", marks: { italic: true } }] }] });
    expect(decided.blocks[0].text).toBe("Use the log.");
  });

  it("validates legacy open content and kind adoption before mutation", async () => {
    const rig = await local();
    for (const [fields, failure] of [
      [{ blocks: [] }, "decision_answer_empty"],
      [{ tldr: "Legacy summary.", blocks: [paragraph] }, "decision_tldr_unsupported"],
      [{ blocks: [{ type: "heading", text: "Legacy heading" }] }, "decision_block_unsupported"],
      [{ blocks: Array.from({ length: 4 }, () => paragraph) }, "decision_answer_too_long"],
      [{ blocks: [paragraph], data: true }, "decision_data_unsupported"],
    ] as const) {
      const { data, ...input } = fields as Record<string, unknown>;
      const ordinary = await rig.ok("create_doc", { title: "Legacy content", description: "A regular page before kind adoption.", ...input });
      if (data) await rig.ok("update_data", { uuid: ordinary.uuid, operations: [{ collection: "facts", schema: { version: 1, schema: { type: "object" } }, upsert: [{ id: "one", value: {} }] }] });
      await refuse(rig, "set_status", { uuid: ordinary.uuid, status: "decided", answer: attribution }, failure, ordinary.uuid);
      expect(getMeta(rig.instance.replicas.replica(ordinary.uuid).doc).kind).toBeUndefined();
      await rig.ok("set_status", { uuid: ordinary.uuid, status: "open" });
      if (input.tldr !== undefined) {
        expect(await rig.ok("get_doc", { uuid: ordinary.uuid })).toMatchObject({ tldr: null });
        expect(await rig.ok("set_status", { uuid: ordinary.uuid, status: "decided" })).toMatchObject({ status: "decided" });
        expect(getMetaMap(rig.instance.replicas.replica(ordinary.uuid).doc).get("tldr")).toBe(input.tldr);
      } else {
        await refuse(rig, "set_status", { uuid: ordinary.uuid, status: "decided" }, failure, ordinary.uuid);
      }
    }
    const valid = await rig.ok("create_doc", { title: "Valid content", description: "Adoptable answer.", blocks: [paragraph] });
    expect(await rig.ok("set_status", { uuid: valid.uuid, status: "decided" })).toMatchObject({ kind: "decision", status: "decided", agentStance: true });
  });

  it("accepts null TL;DR on open records and never nudges decision writes", async () => {
    const rig = await local();
    const record = await create(rig, { blocks: [paragraph] });
    expect(record).not.toHaveProperty("tldrHint");
    setTldr(rig.instance.replicas.replica(record.uuid).doc, "Legacy answer");
    expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ tldr: null });
    expect(await rig.ok("set_metadata", { uuid: record.uuid, description: "Discovery copy." })).toMatchObject({ tldr: null });
    expect(await rig.ok("set_metadata", { uuid: record.uuid, tldr: null })).toMatchObject({ tldr: null });
    const edit = await rig.ok("edit_block", { uuid: record.uuid, block_id: record.blocks[0].id, old_text: paragraph.text, new_text: "Use the log." });
    const insert = await rig.ok("insert_block", { uuid: record.uuid, blocks: [{ type: "paragraph", text: "Replay preserves history." }] });
    const deleted = await rig.ok("delete_block", { uuid: record.uuid, block_id: insert.blocks[0].id });
    for (const write of [edit, insert, deleted]) expect(write).not.toHaveProperty("tldrHint");
    await rig.ok("set_status", { uuid: record.uuid, status: "decided" });
  });

  it("leaves legacy edits and decided stance confirmation or rejection available without rechecking shape", async () => {
    const rig = await local();
    const legacy = await rig.ok("create_doc", { title: "Legacy proposal", description: "Existing content can still be repaired.", blocks: [{ type: "heading", text: "Legacy heading" }, ...Array.from({ length: 4 }, () => paragraph)] });
    await rig.ok("set_status", { uuid: legacy.uuid, status: "open" });
    const edited = await rig.ok("edit_block", { uuid: legacy.uuid, block_id: legacy.blocks[0].id, old_text: "Legacy heading", new_text: "Repaired wording" });
    await rig.ok("link_range", { uuid: legacy.uuid, block_id: legacy.blocks[0].id, start: 0, end: 8, doc_id: legacy.uuid, rev: edited.block.rev });
    await rig.ok("delete_block", { uuid: legacy.uuid, block_id: legacy.blocks[4].id });
    await refuse(rig, "set_status", { uuid: legacy.uuid, status: "decided" }, "decision_block_unsupported", legacy.uuid);
    for (const status of ["decided", "rejected"]) {
      const record = await rig.ok("create_doc", { title: "Legacy stance", description: "An already decided legacy agent stance.", tldr: "Legacy answer", blocks: [] });
      const doc = rig.instance.replicas.replica(record.uuid).doc;
      doc.transact(() => { setKind(doc, "decision"); setStatus(doc, "decided"); getMetaMap(doc).set("agentStance", true); });
      await rig.ok("get_doc", { uuid: record.uuid });
      expect(await rig.ok("set_status", { uuid: record.uuid, status, answer: attribution, ...(status === "rejected" ? { reason: "Choose another answer." } : {}) })).toMatchObject({ status, decidedBy: attribution.who, approvalChanged: false });
    }
  });
});

import { randomUUID } from "node:crypto";
import { cardPartTexts, createAnnotation, decisionApprovalFingerprint, findBlockElement, getMetaMap, setKind, setStatus } from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { docFingerprint } from "../src/remote.js";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const PARTS: readonly CardPart[] = ["label", "title", "body", "footer"];
const SOURCE = "label: Review\ntitle: Keep the title\nfooter: Evidence\n\nKeep the body.";

async function localRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

function partText(doc: Y.Doc, id: string, part: CardPart): Y.XmlText {
  const element = findBlockElement(doc, id);
  const text = element === null ? null : cardPartTexts(element, part)[0] ?? null;
  if (text === null) throw new Error(`no ${part} text`);
  return text;
}

function sourceWithPart(part: CardPart, value: string): string {
  return `label: ${part === "label" ? value : "Review"}\ntitle: ${part === "title" ? value : "Keep the title"}\nfooter: ${part === "footer" ? value : "Evidence"}\n\n${part === "body" ? value : "Keep the body."}`;
}

describe("cards through MCP", () => {
  it.each([
    { source: "title: Card title\n\nCard body", part: "body" },
    { source: "title: Card title\n\n", part: "title" },
  ] as const)("places the agent caret in $part when later optional parts are empty", async ({ source, part }) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card caret", description: "The agent caret stays in a visible part." });
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "card", text: source });
    const replica = rig.instance.replicas.replica(created.uuid);
    const cursor = replica.awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), replica.doc);
    const text = partText(replica.doc, inserted.block.id, part);
    expect(position?.type).toBe(text);
    expect(position?.index).toBe(text.length);
  });

  it("refuses malformed card content before any create, insert or edit write", async () => {
    const invalid = "label: Missing title\n\nBody";
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card refusals", description: "Invalid parts cannot make a partial write.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const [name, args] of [
      ["create_doc", { title: "No partial card", description: "All seeds validate before creation.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "card", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, type: "card", text: invalid }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id, old_text: SOURCE,
        new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      const refused = await rig.call(name, args);
      expect(refused).toMatchObject({ isError: true, payload: { error: "invalid_card", recoveryClass: "manual",
        applied: false, partial: false, synced: false } });
      expect(refused.payload.recovery).toContain("title");
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
  });

  it("keeps stale assertions ahead of malformed replacement content", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card revisions", description: "Formatting is part of the edit assertion.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    partText(doc, created.blocks[0].id, "title").format(0, 4, { bold: {} });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const before = Y.encodeStateAsUpdate(doc);
    const stale = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: read.text, new_text: "missing title", rev: created.blocks[0].rev });
    expect(stale.payload).toMatchObject({ error: "stale_block", applied: false });
    const mismatch = await rig.call("edit_block", { uuid: created.uuid, block_id: read.id,
      old_text: SOURCE, new_text: "missing title", rev: read.rev });
    expect(mismatch.payload).toMatchObject({ error: "old_text_mismatch", applied: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("indexes document links independently from all four parts", async () => {
    const rig = await localRig();
    const targets: Record<string, string> = {};
    for (const part of PARTS) targets[part] = (await rig.ok("create_doc", {
      title: `Target ${part}`, description: "A card part link target.",
    })).uuid;
    const source = `label: [Label](${targets.label})\ntitle: [Title](${targets.title})\nfooter: [Footer](${targets.footer})\n\n[Body](${targets.body})`;
    const created = await rig.ok("create_doc", { title: "Card outgoing links", description: "Each part contributes its links.",
      blocks: [{ type: "card", text: source }] });
    for (const part of PARTS) {
      expect((await rig.ok("backlinks", { uuid: targets[part] })).backlinks.map((row: { uuid: string }) => row.uuid))
        .toEqual([created.uuid]);
    }
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: source, new_text: source.replace(`[Label](${targets.label})`, "Label"), rev: created.blocks[0].rev });
    expect((await rig.ok("backlinks", { uuid: targets.label })).backlinks).toEqual([]);
    for (const part of ["title", "body", "footer"] as const) {
      expect((await rig.ok("backlinks", { uuid: targets[part] })).backlinks.map((row: { uuid: string }) => row.uuid))
        .toEqual([created.uuid]);
    }
  });

  it.each(PARTS)("refuses a newly unknown document link in %s before any write", async (part) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card target validation", description: "Every card part validates new links.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const invalid = sourceWithPart(part, `[Unknown](${randomUUID()})`);
    const listed = await rig.ok("list_docs");
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    for (const [name, args] of [
      ["create_doc", { title: "No partial link", description: "Validate all seed card parts first.",
        blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "card", text: invalid }] }],
      ["insert_block", { uuid: created.uuid, type: "card", text: invalid }],
      ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
        old_text: SOURCE, new_text: invalid, rev: created.blocks[0].rev }],
    ] as const) {
      expect(await rig.call(name, args)).toMatchObject({ isError: true, payload: {
        error: "doclink_target_not_known_locally", applied: false, partial: false,
      } });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect(await rig.ok("list_docs")).toEqual(listed);
  });

  it("refuses new MCP anchors and link ranges while preserving existing card thread lifecycle", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Card range target", description: "A known target for a refused range." });
    const created = await rig.ok("create_doc", { title: "Card thread lifecycle", description: "Web anchors remain agent-readable and replyable.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Web thread", { part: "body" });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    const before = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    const annotated = await rig.call("annotate", { uuid: created.uuid, block_id: id, start: 0, end: 4, text: "New thread" });
    expect(annotated).toMatchObject({ isError: true, payload: { error: "annotation_card", recoveryClass: "manual",
      applied: false, partial: false, synced: false } });
    expect(annotated.payload.recovery).toContain("web editor");
    const linked = await rig.call("link_range", { uuid: created.uuid, block_id: id,
      start: 0, end: 4, doc_id: target.uuid, rev: read.blocks[0].rev });
    expect(linked).toMatchObject({ isError: true, payload: { error: "inline_link_range", applied: false, partial: false } });
    expect(linked.payload.recovery).toEqual(expect.any(String));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(writes);
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid: created.uuid, thread_id: thread.id, resolved, text: "Reply" });
      expect(reply.annotation).toMatchObject({ resolved, range: { part: "body", start: 0, end: 4, collapsed: false } });
    }
    const after = await rig.ok("get_doc", { uuid: created.uuid });
    expect(after.blocks).toEqual(read.blocks);
    expect(after.annotations[0].comments).toHaveLength(3);
  });

  it("keeps formatting-only legacy card changes outside a decision's approved content", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Approved card", description: "Card approval projects plain part content.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    doc.transact(() => {
      setKind(doc, "decision");
      setStatus(doc, "decided");
      getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
    });
    for (const part of PARTS) {
      const text = partText(doc, created.blocks[0].id, part);
      text.format(0, text.length, { bold: {} });
    }
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.approvalChanged).toBe(false);
    partText(doc, created.blocks[0].id, "body").insert(0, "Changed ");
    expect((await rig.ok("get_doc", { uuid: created.uuid })).approvalChanged).toBe(true);
  });

  it("detects anchor-only card divergence during content verification", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Card replication", description: "A surviving thread record does not prove its anchor arrived.",
      blocks: [{ type: "card", text: SOURCE }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "Anchored card thread", { part: "footer" });
    const before = await rig.ok("get_doc", { uuid: created.uuid });
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
      partText(doc, id, "footer").format(0, 4, { comment: null });
      const after = await rig.ok("get_doc", { uuid: created.uuid });
      expect(after.blocks).toEqual(before.blocks);
      expect(after.annotations[0]).toMatchObject({ id: thread.id, comments: before.annotations[0].comments, range: null });
      expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    } finally {
      copy.destroy();
    }
  });
});

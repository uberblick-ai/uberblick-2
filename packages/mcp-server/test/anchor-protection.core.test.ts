import {
  cardPartTexts, createAnnotation, figmaCaptionTexts, findBlockElement,
  tableCellText, tableRows,
} from "@uberblick/schema";
import type { CardPart, TableMapping } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blockText } from "../src/replica.js";
import { startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const PROSE = "The client retries after an 8s timeout. Then it gives up.";
const TABLE = "| Name | Value |\n| --- | --- |\n| Alpha | Beta |";
const CARD = "label: Review\ntitle: Keep title\nfooter: Evidence\n\nKeep body.";
const FIGMA = "url: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345\n\nKeep caption.";

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

async function localRig(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function proseDoc(rig: Rig) {
  const created = await rig.ok("create_doc", {
    title: "Protected discussion", description: "Open threads keep their last anchored character.",
    blocks: [{ type: "paragraph", text: PROSE }],
  });
  const id = created.blocks[0].id;
  const opened = await rig.ok("annotate", {
    uuid: created.uuid, block_id: id, start: PROSE.indexOf("8s timeout"),
    end: PROSE.indexOf("8s timeout") + "8s timeout".length, text: "What timeout?",
  });
  return { ...created, id, threadId: opened.annotation.id };
}

function cellText(doc: Y.Doc, id: string, row: number, column: number): Y.XmlText {
  const element = findBlockElement(doc, id)!;
  return tableCellText(tableRows(element)[row]![column]!)!;
}

async function refusal(
  rig: Rig, uuid: string, name: "delete_block" | "edit_block", args: Record<string, unknown>,
  threads: Array<{ id: string; text: string }>,
) {
  const replica = rig.instance.replicas.replica(uuid);
  const before = Y.encodeStateAsUpdate(replica.doc);
  const logs = rig.instance.store.logSize();
  const awareness = structuredClone(replica.awareness.getLocalState());
  const peer = new Y.Doc();
  Y.applyUpdate(peer, before);
  let updates = 0;
  const forward = (update: Uint8Array) => {
    updates += 1;
    Y.applyUpdate(peer, update);
  };
  replica.doc.on("update", forward);
  try {
    const failed = await rig.call(name, { uuid, ...args });
    expect(failed).toMatchObject({ isError: true, payload: {
      error: "open_thread_anchored", recoveryClass: "manual",
      applied: false, partial: false, synced: false, blockId: args.block_id,
    } });
    expect(failed.payload.threads).toHaveLength(threads.length);
    expect(failed.payload.threads).toEqual(expect.arrayContaining(threads));
    for (const thread of threads) {
      expect(failed.payload.message).toContain(thread.id);
      expect(failed.payload.message).toContain(thread.text);
    }
    expect(failed.payload.recovery).toMatch(/annotate/);
    expect(failed.payload.recovery).toMatch(/resolv/i);
    expect(failed.payload.recovery).toMatch(/mov/i);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(replica.doc)).toEqual(before);
    expect(Y.encodeStateAsUpdate(peer)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(logs);
    expect(replica.awareness.getLocalState()).toEqual(awareness);
    return failed.payload;
  } finally {
    replica.doc.off("update", forward);
    peer.destroy();
  }
}

describe("MCP protects the last anchor of an open comment thread", () => {
  it("refuses edit and delete atomically, names every endangered open thread, and allows both after resolution", async () => {
    const rig = await localRig();
    const created = await proseDoc(rig);
    const second = await rig.ok("annotate", { uuid: created.uuid, block_id: created.id,
      start: 4, end: 10, text: "Which client?" });
    const resolved = await rig.ok("annotate", { uuid: created.uuid, block_id: created.id,
      start: PROSE.indexOf("gives up"), end: PROSE.indexOf("gives up") + 8, text: "Done" });
    await rig.ok("annotate", { uuid: created.uuid, thread_id: resolved.annotation.id, text: "Resolved", resolved: true });
    const endangered = [{ id: created.threadId, text: "8s timeout" }, { id: second.annotation.id, text: "client" }];
    const deleted = await refusal(rig, created.uuid, "delete_block", { block_id: created.id }, endangered);
    expect(deleted.message).not.toContain(resolved.annotation.id);
    await refusal(rig, created.uuid, "edit_block", {
      block_id: created.id, old_text: PROSE, new_text: "Then it gives up.",
    }, endangered);
    await rig.ok("annotate", { uuid: created.uuid, thread_id: created.threadId, resolved: true, text: "Raised to 10s" });
    await rig.ok("annotate", { uuid: created.uuid, thread_id: second.annotation.id, resolved: true, text: "Client identified" });
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.id, old_text: PROSE, new_text: "Then it gives up." });
    await rig.ok("delete_block", { uuid: created.uuid, block_id: created.id });
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual([]);
  });

  it("judges the actual splice: a timeout replacement and edits elsewhere retain anchored characters", async () => {
    const rig = await localRig();
    const created = await proseDoc(rig);
    const changed = PROSE.replace("8s timeout", "10s timeout");
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.id, old_text: PROSE, new_text: changed });
    let read = await rig.ok("get_doc", { uuid: created.uuid });
    const range = read.annotations[0].range;
    expect(changed.slice(range.start, range.end)).toBe("s timeout");
    const elsewhere = changed.replace("Then it gives up.", "Then it retries again.");
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.id, old_text: changed, new_text: elsewhere });
    read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.annotations[0].range).toEqual(range);
    await refusal(rig, created.uuid, "edit_block", { block_id: created.id, old_text: elsewhere,
      new_text: "The client retries. Then it retries again." }, [{ id: created.threadId, text: "s timeout" }]);
  });

  it("refuses deletion of an old anchor even when the same words are inserted elsewhere", async () => {
    const rig = await localRig();
    const suffix = "A much longer sentence remains exactly unchanged.";
    const source = `8s timeout. ${suffix}`;
    const created = await rig.ok("create_doc", { title: "Moved words", description: "Equal words do not imply surviving marks.",
      blocks: [{ type: "paragraph", text: source }] });
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: created.blocks[0].id,
      start: 0, end: 10, text: "Keep this context" });
    await refusal(rig, created.uuid, "edit_block", { block_id: created.blocks[0].id, old_text: source,
      new_text: `${suffix} 8s timeout.` }, [{ id: opened.annotation.id, text: "8s timeout" }]);
  });

  it("ignores already orphaned open threads", async () => {
    const rig = await localRig();
    const created = await proseDoc(rig);
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    blockText(doc, created.id)!.format(0, PROSE.length, { comment: null });
    await rig.ok("edit_block", { uuid: created.uuid, block_id: created.id, old_text: PROSE, new_text: "Changed" });
    await rig.ok("delete_block", { uuid: created.uuid, block_id: created.id });
    expect((await rig.ok("get_doc", { uuid: created.uuid })).annotations[0]).toMatchObject({ id: created.threadId, range: null });
  });

  it.each(["paragraph", "table", "card", "figma"] as const)(
    "finds surviving and endangered marks in another %s block, independently of recorded blockId", async (type) => {
      const rig = await localRig();
      const created = await proseDoc(rig);
      const text = type === "paragraph" ? "Other anchor" : type === "table" ? TABLE : type === "card" ? CARD : FIGMA;
      const inserted = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type, text }] });
      const doc = rig.instance.replicas.replica(created.uuid).doc;
      const other = inserted.blocks[0].id;
      const element = findBlockElement(doc, other)!;
      const target = type === "table" ? cellText(doc, other, 1, 0) : type === "card" ? cardPartTexts(element, "body")[0]!
        : type === "figma" ? figmaCaptionTexts(element)[0]! : blockText(doc, other)!;
      const anchored = target.toString().slice(0, 1);
      target.format(0, 1, { comment: { threadId: created.threadId } });
      await rig.ok("edit_block", { uuid: created.uuid, block_id: created.id, old_text: PROSE, new_text: "No timeout remains." });
      await rig.ok("delete_block", { uuid: created.uuid, block_id: created.id });
      expect((await rig.ok("get_doc", { uuid: created.uuid })).annotations[0].range).toBeNull();
      await refusal(rig, created.uuid, "delete_block", { block_id: other }, [{ id: created.threadId, text: anchored }]);
    },
  );

  it.each(["cell", "row", "column"] as const)("refuses a table %s edit that removes the last anchored character", async (change) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Protected cell", description: "Structural edits preserve open discussion.",
      blocks: [{ type: "table", text: TABLE }] });
    const id = created.blocks[0].id;
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 1,
      start: 0, end: 4, text: "Why Beta?" });
    const replacement = change === "cell" ? TABLE.replace("Beta", "ZZZ") : change === "row"
      ? "| Name | Value |\n| --- | --- |" : "| Name |\n| --- |\n| Alpha |";
    const mapping: TableMapping | undefined = change === "row" ? { rows: [0], columns: [0, 1] }
      : change === "column" ? { rows: [0, 1], columns: [0] } : undefined;
    await refusal(rig, created.uuid, "edit_block", { block_id: id, old_text: TABLE, new_text: replacement,
      ...(mapping === undefined ? {} : { table_mapping: mapping }) }, [{ id: opened.annotation.id, text: "Beta" }]);
  });

  it("allows dropping one marked table cell while a different cell still anchors the thread", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Shared cell anchor", description: "A thread may span cells after peer edits.",
      blocks: [{ type: "table", text: TABLE }] });
    const id = created.blocks[0].id;
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 1,
      start: 0, end: 4, text: "Shared discussion" });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    cellText(doc, id, 1, 0).format(0, 1, { comment: { threadId: opened.annotation.id } });
    await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: TABLE,
      new_text: "| Name |\n| --- |\n| Alpha |", table_mapping: { rows: [0, 1], columns: [0] } });
    expect((await rig.ok("get_doc", { uuid: created.uuid })).annotations[0].range)
      .toEqual({ row: 1, column: 0, start: 0, end: 1, collapsed: false });
  });

  it.each(["label", "title", "body", "footer", "caption"] as const)("protects an existing %s anchor during content edits", async (part) => {
    const rig = await localRig();
    const source = part === "caption" ? FIGMA : CARD;
    const created = await rig.ok("create_doc", { title: "Protected embed discussion", description: "Existing web anchors remain protected.",
      blocks: [{ type: part === "caption" ? "figma" : "card", text: source }] });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const element = findBlockElement(doc, id)!;
    const target = part === "caption" ? figmaCaptionTexts(element)[0]! : cardPartTexts(element, part as CardPart)[0]!;
    const anchored = target.toString();
    const opened = createAnnotation(doc, id, 0, anchored.length, "Reader", "Discuss this part", { part });
    await refusal(rig, created.uuid, "edit_block", { block_id: id, old_text: source, new_text: source.replace(anchored, "ZZZ") },
      [{ id: opened.id, text: anchored }]);
    await rig.ok("annotate", { uuid: created.uuid, thread_id: opened.id, text: "Resolved before replacing", resolved: true });
    await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: source, new_text: source.replace(anchored, "ZZZ") });
  });
});

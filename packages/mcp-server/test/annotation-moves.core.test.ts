import { createAnnotation, deleteBlock, listAnnotationRanges } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestResources, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: rigs.splice(0).map((rig) => () => rig.close()) });
});

async function fixture(firstText = "Old context") {
  const rig = await startServer(testConfig({ databasePath: ":memory:" }));
  rigs.push(rig);
  const doc = await rig.ok("create_doc", {
    title: "Moving comments", description: "Existing threads keep their conversation when moved.",
    blocks: [
      { type: "paragraph", text: firstText },
      { type: "paragraph", text: "New context" },
      { type: "table", text: "| Head |\n| --- |\n| Cell |" },
      { type: "card", text: "title: Card\n\nBody" },
      { type: "figma", text: "url: https://www.figma.com/design/Abc123/File\n\nCaption" },
    ],
  });
  const opened = await rig.ok("annotate", {
    uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Question",
  });
  return { rig, doc, threadId: opened.annotation.id as string };
}

describe("moving annotation anchors through MCP", () => {
  it("moves onto the full replacement timeout after a partial-anchor edit, then permits deleting the source", async () => {
    const sentence = "The client retries after an 8s timeout.";
    const { rig, doc, threadId } = await fixture(sentence);
    const start = sentence.indexOf("8s timeout");
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, block_id: doc.blocks[0].id,
      start, end: start + "8s timeout".length, text: "Discuss timeout" });
    const before = (await rig.ok("get_doc", { uuid: doc.uuid })).blocks[0];
    await rig.ok("edit_block", { uuid: doc.uuid, block_id: before.id, old_text: before.text, rev: before.rev,
      new_text: sentence.replace("8s", "10s") });
    const moved = await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, block_id: before.id,
      start, end: start + "10s timeout".length, text: "Discuss the complete new timeout" });
    expect(moved.annotation.range).toEqual({ start, end: start + 11, collapsed: false });
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, block_id: doc.blocks[1].id,
      start: 0, end: 3, text: "Keep discussion on another block" });
    await rig.ok("delete_block", { uuid: doc.uuid, block_id: before.id });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0]).toMatchObject({
      id: threadId, blockId: doc.blocks[1].id, range: { start: 0, end: 3, collapsed: false },
    });
  });

  it("moves an existing thread in one document update and returns its new block and range", async () => {
    const { rig, doc, threadId } = await fixture();
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Answered", resolved: true });
    const replica = rig.instance.replicas.replica(doc.uuid);
    const before = rig.instance.replicas.store.updateCount(replica.room);
    const moved = await rig.ok("annotate", {
      uuid: doc.uuid, thread_id: threadId, block_id: doc.blocks[1].id,
      start: 0, end: 3, text: "New context", author: "Agent",
    });
    expect(rig.instance.replicas.store.updateCount(replica.room)).toBe(before + 1);
    expect(moved.annotation).toMatchObject({
      id: threadId, blockId: doc.blocks[1].id, resolved: true,
      range: { start: 0, end: 3, collapsed: false },
      comments: [{ text: "Question" }, { text: "Answered" }, { author: "Agent", text: "New context" }],
    });
    expect(listAnnotationRanges(replica.doc, doc.blocks[0].id)).toEqual([]);
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.annotations[0]).toEqual(moved.annotation);
  });

  it("moves orphaned and card or Figma caption threads into prose or table cells", async () => {
    const { rig, doc, threadId } = await fixture();
    const ydoc = rig.instance.replicas.replica(doc.uuid).doc;
    deleteBlock(ydoc, doc.blocks[0].id);
    const restored = await rig.ok("annotate", {
      uuid: doc.uuid, thread_id: threadId, block_id: doc.blocks[2].id,
      row: 1, column: 0, start: 0, end: 4, text: "Restored context",
    });
    expect(restored.annotation).toMatchObject({ blockId: doc.blocks[2].id,
      range: { row: 1, column: 0, start: 0, end: 4, collapsed: false } });
    for (const [blockId, part, start] of [
      [doc.blocks[3].id, "body", 0], [doc.blocks[4].id, "caption", 4],
    ] as const) {
      const thread = createAnnotation(ydoc, blockId, 0, 4, "Reader", "Container question", { part });
      const moved = await rig.ok("annotate", {
        uuid: doc.uuid, thread_id: thread.id, block_id: doc.blocks[1].id,
        start, end: start + 3, text: "Move out of container",
      });
      expect(moved.annotation.blockId).toBe(doc.blocks[1].id);
      expect(listAnnotationRanges(ydoc, blockId)).toEqual([]);
    }
  });

  it("refuses invalid targets before changing anchors or appending replies", async () => {
    const { rig, doc, threadId } = await fixture();
    await rig.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[1].id, start: 0, end: 3, text: "Occupied",
    });
    const before = await rig.ok("get_doc", { uuid: doc.uuid });
    const replica = rig.instance.replicas.replica(doc.uuid);
    const logged = rig.instance.replicas.store.updateCount(replica.room);
    for (const [fields, code] of [
      [{ block_id: doc.blocks[0].id, start: 1, end: 1 }, "annotation_range"],
      [{ block_id: doc.blocks[1].id, start: 0, end: 2 }, "annotation_range"],
      [{ block_id: doc.blocks[2].id, start: 0, end: 2 }, "annotation_cell"],
      [{ block_id: doc.blocks[2].id, row: 1, start: 0, end: 2 }, "annotation_cell"],
      [{ block_id: doc.blocks[2].id, row: 99, column: 0, start: 0, end: 2 }, "annotation_cell"],
      [{ block_id: doc.blocks[3].id, start: 0, end: 2 }, "annotation_card"],
      [{ block_id: doc.blocks[4].id, start: 0, end: 2 }, "annotation_figma"],
      [{ block_id: doc.blocks[1].id, start: 4, end: 7, thread_id: "unknown" }, "thread_not_found"],
    ] as const) {
      const refused = await rig.call("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Refused move", ...fields });
      expect(refused).toMatchObject({ isError: true, payload: { error: code, applied: false, partial: false } });
    }
    expect(rig.instance.replicas.store.updateCount(replica.room)).toBe(logged);
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toEqual(before);

    const overlap = await rig.ok("annotate", {
      uuid: doc.uuid, thread_id: threadId, block_id: doc.blocks[0].id,
      start: 1, end: 5, text: "Own overlap is permitted",
    });
    expect(overlap.annotation.range).toEqual({ start: 1, end: 5, collapsed: false });
  });
});

import {
  appendBlock, createAnnotation, findBlockElement, getAnnotationsMap, getBlocks,
  getBlocksFragment, setKind, tableRows,
} from "@uberblick/schema";
import type { Block } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

/** The created page with its stored blocks, which create_doc names only by id and rev. */
async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  const created = await rig.ok("create_doc", {
    title: "Moving blocks", description: "Reordering retains block content and comments.",
    blocks: [
      { type: "paragraph", text: "First" }, { type: "paragraph", text: "Middle" },
      { type: "paragraph", text: "Last" },
    ],
    ...fields,
  });
  return { ...created, blocks: (await rig.ok("get_doc", { uuid: created.uuid })).blocks };
}

async function refuse(
  rig: Rig, uuid: string, args: Record<string, unknown>, error: string, offendingId?: string,
) {
  const doc = rig.instance.replicas.replica(uuid).doc;
  const before = Y.encodeStateAsUpdate(doc);
  const directory = Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc);
  const logged = rig.instance.store.logSize();
  const update = vi.fn();
  const cursor = vi.spyOn(rig.instance.replicas, "publishCursor");
  doc.on("update", update);
  try {
    const result = await rig.call("move_block", { uuid, ...args });
    expect(result).toMatchObject({ isError: true, payload: {
      error, applied: false, partial: false, synced: false,
      recovery: expect.any(String), recoveryClass: expect.any(String),
    } });
    expect(result.payload.message).toContain("Nothing was written.");
    if (offendingId !== undefined) expect(result.payload.message).toContain(offendingId);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc)).toEqual(directory);
    expect(rig.instance.store.logSize()).toBe(logged);
    expect(update).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
  } finally {
    doc.off("update", update);
    cursor.mockRestore();
  }
}

function elementTree(element: Y.XmlElement): unknown {
  return {
    name: element.nodeName,
    attributes: element.getAttributes(),
    children: element.toArray().map(child => child instanceof Y.XmlElement
      ? elementTree(child) : child instanceof Y.XmlText ? { delta: child.toDelta() } : child.toString()),
  };
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  vi.restoreAllMocks();
});

describe("atomic move_block", () => {
  it.each(["anchor", "omitted", "null"])(
    "moves nonadjacent blocks in supplied order at the %s position and retains their revisions", async (position) => {
      const rig = await local();
      const page = await create(rig, { blocks: [
        { type: "paragraph", text: "Retained first" },
        { type: "heading", text: "Heading", level: 3 },
        { type: "paragraph", text: "Retained second" },
        { type: "paragraph", text: "Paragraph" },
        { type: "list-item", text: "Ordered item", list: "ordered", indent: 2 },
        { type: "code", text: "answer()", language: "ts" },
        { type: "paragraph", text: "Target" },
        { type: "paragraph", text: "Retained last" },
      ] });
      const selected = [page.blocks[5], page.blocks[1], page.blocks[4], page.blocks[3]];
      const remaining = [page.blocks[0], page.blocks[2], page.blocks[6], page.blocks[7]];
      const result = await rig.ok("move_block", {
        uuid: page.uuid, block_ids: selected.map(block => block.id),
        ...(position === "anchor" ? { after_block_id: page.blocks[6].id }
          : position === "null" ? { after_block_id: null } : {}),
      });
      expect(result).toMatchObject({ uuid: page.uuid, applied: true, synced: false, hub: { status: "disabled" } });
      expect(result.blocks).toEqual(selected.map(({ id, rev }) => ({ id, rev })));
      const expected = position === "anchor"
        ? [...remaining.slice(0, 3), ...selected, remaining[3]] : [...selected, ...remaining];
      expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks).toEqual(expected);
    },
  );

  it("preserves all block trees, inline marks, structured fields and open or resolved comment anchors", async () => {
    const rig = await local();
    const target = await create(rig, { title: "Linked document" });
    const page = await create(rig, { blocks: [
      { type: "paragraph", inline: [{ text: "Paragraph ", marks: { bold: true } },
        { text: "Linked", marks: { docLink: target.uuid } }] },
      { type: "heading", text: "Heading text", level: 4 },
      { type: "list-item", text: "List text", list: "ordered", indent: 3 },
      { type: "code", text: "const value = 42", language: "ts" },
      { type: "table", text: `| Head | Other |\n| --- | --- |\n| **Cell** | [Link](${target.uuid}) |` },
      { type: "card", text: `label: Label text\ntitle: Title text\nfooter: Footer text\nbutton: [Open](https://example.com) filled blue\n\n**Body** [link](${target.uuid})` },
      { type: "figma", text: `url: https://www.figma.com/design/Abc123/File?node-id=1-2\ntitle: Figma title\nheight: 560\n\n**Caption** [link](${target.uuid})` },
      { type: "paragraph", text: "Retained target" },
    ] });
    const replica = rig.instance.replicas.replica(page.uuid);
    const ids = page.blocks.map((block: { id: string }) => block.id);
    const table = findBlockElement(replica.doc, ids[4])!;
    const firstCell = tableRows(table)[0]![0]!;
    (firstCell as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [225.5]);
    expect(firstCell.getAttributes()).toMatchObject({ colspan: 1, rowspan: 1, colwidth: [225.5] });
    const threads = [
      createAnnotation(replica.doc, ids[0], 1, 5, "Reader", "Paragraph question"),
      createAnnotation(replica.doc, ids[1], 2, 6, "Reader", "Heading question"),
      createAnnotation(replica.doc, ids[2], 0, 4, "Reader", "List question"),
      createAnnotation(replica.doc, ids[4], 0, 4, "Reader", "Cell question", { row: 1, column: 0 }),
      ...(["label", "title", "body", "footer"] as const).map(part =>
        createAnnotation(replica.doc, ids[5], 0, 4, "Reader", `${part} question`, { part })),
      createAnnotation(replica.doc, ids[6], 1, 5, "Reader", "Caption question", { part: "caption" }),
    ];
    await rig.ok("annotate", {
      uuid: page.uuid, thread_id: threads[0]!.id, text: "Resolved with explanation", resolved: true,
    });
    const before = await rig.ok("get_doc", { uuid: page.uuid });
    const records = getAnnotationsMap(replica.doc).toJSON();
    const trees = ids.map((id: string) => elementTree(findBlockElement(replica.doc, id)!));
    const order = [ids[6], ids[2], ids[4], ids[0], ids[5], ids[3], ids[1]];
    await rig.ok("move_block", { uuid: page.uuid, block_ids: order, after_block_id: ids[7] });
    const after = await rig.ok("get_doc", { uuid: page.uuid });
    expect(after.blocks).toEqual([before.blocks[7], ...order.map(id => before.blocks.find((block: Block) => block.id === id))]);
    expect(after.annotations).toEqual(before.annotations);
    expect(after.annotations).toHaveLength(9);
    expect(after.annotations.every((annotation: { range: unknown }) => annotation.range !== null)).toBe(true);
    expect(getAnnotationsMap(replica.doc).toJSON()).toEqual(records);
    expect(ids.map((id: string) => elementTree(findBlockElement(replica.doc, id)!))).toEqual(trees);
  });

  it("requires a nonempty block id array and refuses unknown arguments before writing", async () => {
    const rig = await local();
    const page = await create(rig);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    const logged = rig.instance.store.logSize();
    for (const fields of [
      {}, { block_ids: [] }, { block_ids: [""] }, { block_ids: [1] },
      { block_ids: [page.blocks[0].id], after_block_id: "" },
      { block_ids: [page.blocks[0].id], unexpected: true },
    ]) {
      expect(await rig.call("move_block", { uuid: page.uuid, ...fields }))
        .toMatchObject({ isError: true, payload: { error: "schema_validation" } });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(logged);
  });

  it("refuses missing or duplicate ids and a target in the selection without writing any block", async () => {
    const rig = await local();
    const page = await create(rig);
    const first = page.blocks[0].id;
    const last = page.blocks[2].id;
    await refuse(rig, page.uuid, { block_ids: [last, "unknown-block"], after_block_id: first }, "block_not_found", "unknown-block");
    await refuse(rig, page.uuid, { block_ids: [last, first, last] }, "duplicate_block_id", last);
    await refuse(rig, page.uuid, { block_ids: [last], after_block_id: "unknown-target" }, "block_not_found", "unknown-target");
    await refuse(rig, page.uuid, { block_ids: [last, first], after_block_id: first }, "move_target_in_selection", first);
  });

  it("refuses archived pages and decided records as other content writes do", async () => {
    const rig = await local();
    const page = await create(rig);
    await rig.ok("archive_doc", { uuid: page.uuid });
    await refuse(rig, page.uuid, { block_ids: [page.blocks[2].id] }, "doc_archived");
    const decision = await create(rig, { kind: "decision", status: "decided" });
    await refuse(rig, decision.uuid, { block_ids: [decision.blocks[2].id] }, "decision_read_only");
  });

  it("checks the resulting decision answer when a move would split an adjacent list", async () => {
    const rig = await local();
    const page = await create(rig, { kind: "decision", blocks: [
      { type: "paragraph", text: "Reason" }, { type: "list-item", text: "First" },
      { type: "list-item", text: "Second" }, { type: "code", text: "answer()" },
    ] });
    await refuse(rig, page.uuid, {
      block_ids: [page.blocks[1].id], after_block_id: page.blocks[3].id,
    }, "decision_answer_too_long");
    await rig.ok("move_block", {
      uuid: page.uuid, block_ids: [page.blocks[1].id, page.blocks[2].id], after_block_id: page.blocks[3].id,
    });
    expect(getBlocks(rig.instance.replicas.replica(page.uuid).doc))
      .toEqual([page.blocks[0], page.blocks[3], page.blocks[1], page.blocks[2]]);
  });

  it("refuses an unsupported resulting answer in a legacy open decision", async () => {
    const rig = await local();
    const page = await create(rig);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const heading = appendBlock(doc, { type: "heading", text: "Legacy unsupported answer" });
    setKind(doc, "decision");
    await refuse(rig, page.uuid, {
      block_ids: [heading], after_block_id: page.blocks[0].id,
    }, "decision_block_unsupported");
  });

  it("applies one document update, with no duplicate ids at a peer, and publishes one cursor", async () => {
    const rig = await local();
    const page = await create(rig);
    const replica = rig.instance.replicas.replica(page.uuid);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(replica.doc));
    const observations: string[][] = [];
    const replicate = (update: Uint8Array) => {
      Y.applyUpdate(peer, update);
      observations.push(getBlocksFragment(peer).toArray()
        .filter((block): block is Y.XmlElement => block instanceof Y.XmlElement)
        .map(block => block.getAttribute("id")!));
    };
    replica.doc.on("update", replicate);
    const cursor = vi.spyOn(rig.instance.replicas, "publishCursor");
    const logged = rig.instance.store.updateCount(replica.room);
    try {
      await rig.ok("move_block", {
        uuid: page.uuid, block_ids: [page.blocks[2].id, page.blocks[0].id], after_block_id: page.blocks[1].id,
      });
      expect(observations).toEqual([[page.blocks[1].id, page.blocks[2].id, page.blocks[0].id]]);
      expect(rig.instance.store.updateCount(replica.room)).toBe(logged + 1);
      expect(getBlocks(peer)).toEqual([page.blocks[1], page.blocks[2], page.blocks[0]]);
      expect(cursor).toHaveBeenCalledExactlyOnceWith(replica, page.blocks[0].id, page.blocks[0].text.length);
    } finally {
      replica.doc.off("update", replicate);
      cursor.mockRestore();
      peer.destroy();
    }
  });

  it("reports a directory persistence failure honestly after the moved blocks are durably logged", async () => {
    const rig = await startServer(testConfig({ updatedAtCoarsenessMs: 0 }));
    rigs.push(rig);
    const page = await create(rig);
    const replica = rig.instance.replicas.replica(page.uuid);
    const directory = rig.instance.replicas.directory();
    const store = rig.instance.store;
    const logged = store.updateCount(replica.room);
    const append = store.appendUpdate.bind(store);
    const failure = vi.spyOn(store, "appendUpdate").mockImplementation((...args) => {
      if (args[0] === directory.room) throw new Error("simulated directory append failure");
      return append(...args);
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    const replay = new Y.Doc();
    try {
      const result = await rig.call("move_block", {
        uuid: page.uuid, block_ids: [page.blocks[2].id],
      });
      expect(result).toMatchObject({ isError: true, payload: {
        error: "persistence_failed", room: directory.room,
      } });
      expect(JSON.stringify(result.payload)).not.toMatch(/nothing was written/i);
      expect(store.updateCount(replica.room)).toBe(logged + 1);
      expect(getBlocks(replica.doc)).toEqual([page.blocks[2], page.blocks[0], page.blocks[1]]);
      const persisted = store.readSince(replica.room, 0);
      if (persisted.snapshot !== null) Y.applyUpdate(replay, persisted.snapshot.state);
      for (const update of persisted.updates) Y.applyUpdate(replay, update.payload);
      expect(getBlocks(replay)).toEqual(getBlocks(replica.doc));
    } finally {
      clock.mockRestore();
      failure.mockRestore();
      replay.destroy();
    }
  });

  it.each(["top", "anchor"])("keeps an already satisfied %s move free of updates or recreated blocks", async (position) => {
    const rig = await local();
    const page = await create(rig);
    const replica = rig.instance.replicas.replica(page.uuid);
    const selected = position === "top" ? page.blocks.slice(0, 2) : page.blocks.slice(1);
    const before = Y.encodeStateAsUpdate(replica.doc);
    const logged = rig.instance.store.logSize();
    const update = vi.fn();
    const cursor = vi.spyOn(rig.instance.replicas, "publishCursor");
    replica.doc.on("update", update);
    try {
      const result = await rig.ok("move_block", {
        uuid: page.uuid, block_ids: selected.map((block: Block) => block.id),
        ...(position === "anchor" ? { after_block_id: page.blocks[0].id } : {}),
      });
      expect(result.blocks).toEqual(selected.map(({ id, rev }: Block) => ({ id, rev })));
      expect(Y.encodeStateAsUpdate(replica.doc)).toEqual(before);
      expect(rig.instance.store.logSize()).toBe(logged);
      expect(update).not.toHaveBeenCalled();
      expect(cursor).not.toHaveBeenCalled();
    } finally {
      replica.doc.off("update", update);
      cursor.mockRestore();
    }
  });
});

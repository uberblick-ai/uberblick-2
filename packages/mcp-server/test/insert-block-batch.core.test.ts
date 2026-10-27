import { getBlockInline, getBlocks } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { readBlocks, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const paragraph = { type: "paragraph", text: "Earlier valid entry" };
const unknown = "59f090ec-4be6-44f4-a2e7-bf9e7ad98888";
const figmaUrl = "https://www.figma.com/design/key/Example";

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Batch insertion", description: "Ordered blocks are written atomically.", ...fields,
  });
}

async function refuse(
  rig: Rig,
  uuid: string,
  args: Record<string, unknown>,
  error: string,
  entryIndex?: number,
) {
  const doc = rig.instance.replicas.replica(uuid).doc;
  const before = Y.encodeStateAsUpdate(doc);
  const directory = Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc);
  const log = rig.instance.store.logSize();
  const update = vi.fn();
  const cursor = vi.spyOn(rig.instance.replicas, "publishCursor");
  doc.on("update", update);
  try {
    const result = await rig.call("insert_block", { uuid, ...args });
    expect(result).toMatchObject({ isError: true, payload: {
      error, applied: false, partial: false, synced: false,
      recoveryClass: error === "block_not_found" || error === "doclink_target_not_known_locally" ? "reread" : "manual",
      recovery: expect.any(String),
    } });
    expect(result.payload.message).toContain("Nothing was written.");
    if (entryIndex === undefined) {
      expect(result.payload).not.toHaveProperty("entry_index");
    } else {
      expect(result.payload.entry_index).toBe(entryIndex);
      expect(result.payload.message).toContain(`Entry ${entryIndex}`);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc)).toEqual(directory);
    expect(rig.instance.store.logSize()).toBe(log);
    expect(update).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
  } finally {
    doc.off("update", update);
    cursor.mockRestore();
  }
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  vi.restoreAllMocks();
});
afterAll(removeTempDirs);

describe("atomic insert_block batches", () => {
  it.each(["anchor", "top"])("keeps the requested order at the %s and returns every id and rev", async (position) => {
    const rig = await local();
    const original = await create(rig, { blocks: [
      { type: "paragraph", text: "Before" }, { type: "paragraph", text: "After" },
    ] });
    const entries = [
      { type: "heading", text: "Section", level: 2 },
      { type: "paragraph", text: "First paragraph" },
      { type: "paragraph", text: "Second paragraph" },
      { type: "list-item", text: "First item" },
      { type: "list-item", text: "Second item" },
    ];
    const result = await rig.ok("insert_block", {
      uuid: original.uuid,
      ...(position === "anchor" ? { after_block_id: original.blocks[0].id } : {}),
      blocks: entries,
    });
    expect(result).not.toHaveProperty("block");
    // The answer names the written blocks without replaying their content.
    expect(result.blocks).toEqual(entries.map(() => ({ id: expect.any(String), rev: expect.any(String) })));
    expect(new Set(result.blocks.map((block: { id: string }) => block.id)).size).toBe(entries.length);
    const expected = position === "anchor"
      ? [original.blocks[0], ...result.blocks, original.blocks[1]]
      : [...result.blocks, ...original.blocks];
    const read = (await rig.ok("get_doc", { uuid: original.uuid })).blocks;
    expect(read).toMatchObject(expected);
    expect(await readBlocks(rig, original.uuid, result.blocks)).toMatchObject(entries);
  });

  it("preserves every block kind and field, inline overrides, known links and literal chart source", async () => {
    const rig = await local();
    const target = await create(rig, { title: "Known target" });
    const page = await create(rig);
    const result = await rig.ok("insert_block", { uuid: page.uuid, blocks: [
      { type: "heading", text: "Heading", level: 3 },
      { type: "paragraph", text: "Ignored", inline: [
        { text: "Marked ", marks: { bold: true } }, { text: "", marks: { docLink: target.uuid } },
      ] },
      { type: "list-item", text: "Numbered", list: "ordered", indent: 2 },
      { type: "list-item", text: "Default list" },
      { type: "quote", inline: [{ text: "Quotation", marks: { italic: true } }] },
      { type: "code", text: "const answer = 42", language: "ts" },
      { type: "terminal", text: "echo hello" },
      { type: "chart", text: "{ incomplete" },
      { type: "table", text: `| Reference |\n| --- |\n| [Known](${target.uuid}) |` },
      { type: "card", text: `title: A card\nbutton: [Open](https://example.com) filled blue\n\n[Known](${target.uuid})` },
      { type: "figma", text: `url: ${figmaUrl}\nheight: 560\n\n[Known](${target.uuid})` },
    ] });
    expect(await readBlocks(rig, page.uuid, result.blocks)).toMatchObject([
      { type: "heading", text: "Heading", level: 3 },
      { type: "paragraph", text: "Marked Known target" },
      { type: "list-item", text: "Numbered", list: "ordered", indent: 2 },
      { type: "list-item", text: "Default list", list: "bullet", indent: 0 },
      { type: "quote", text: "Quotation" },
      { type: "code", text: "const answer = 42", language: "ts" },
      { type: "terminal", text: "echo hello" },
      { type: "chart", text: "{ incomplete" },
      { type: "table" }, { type: "card" }, { type: "figma" },
    ]);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    expect(getBlockInline(doc, result.blocks[1].id)).toEqual([
      { text: "Marked ", marks: { bold: true } },
      { text: "Known target", marks: { docLink: target.uuid } },
    ]);
    const read = (await rig.ok("get_doc", { uuid: page.uuid })).blocks;
    expect(read).toMatchObject(result.blocks.map(({ id, rev }: { id: string; rev: string }) => ({ id, rev })));
    for (const block of read) expect(block).not.toHaveProperty("chart");
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks)
      .toMatchObject([{ uuid: page.uuid }]);
  });

  it("requires nonempty strict entries and removes root-level block fields before admitting writes", async () => {
    const rig = await local();
    const page = await create(rig);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    const log = rig.instance.store.logSize();
    for (const args of [
      {}, { blocks: [] }, { type: "paragraph", text: "Old input" },
      { blocks: [paragraph], type: "paragraph" },
      { blocks: [paragraph, { ...paragraph, unexpected: true }] },
      { blocks: [paragraph, { type: "list-item", indent: 4 }] },
    ]) {
      expect(await rig.call("insert_block", { uuid: page.uuid, ...args }))
        .toMatchObject({ isError: true, payload: { error: "schema_validation" } });
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(log);
  });

  it.each([
    { name: "table", type: "table", text: "Not a GFM table", error: "invalid_table" },
    { name: "card", type: "card", text: "label: Missing title", error: "invalid_card" },
    { name: "Figma", type: "figma", text: "title: Missing URL", error: "invalid_figma" },
  ])("refuses a malformed later $name entry without any live write", async ({ type, text, error }) => {
    const rig = await local();
    const page = await create(rig, { blocks: [paragraph] });
    await refuse(rig, page.uuid, {
      after_block_id: page.blocks[0].id,
      blocks: [paragraph, { type, text }, paragraph],
    }, error, 2);
  });

  it.each([
    { name: "inline run", block: { type: "paragraph", inline: [{ text: "Unknown", marks: { docLink: unknown } }] } },
    { name: "table cell", block: { type: "table", text: `| Name |\n| --- |\n| [Unknown](${unknown}) |` } },
    { name: "card body", block: { type: "card", text: `title: Card\n\n[Unknown](${unknown})` } },
    { name: "Figma caption", block: { type: "figma", text: `url: ${figmaUrl}\n\n[Unknown](${unknown})` } },
  ])("refuses a later unknown link in a $name before writing earlier entries", async ({ block }) => {
    const rig = await local();
    const page = await create(rig);
    await refuse(rig, page.uuid, { blocks: [paragraph, paragraph, block] }, "doclink_target_not_known_locally", 3);
  });

  it("identifies the first entry that exceeds a decision answer's shape", async () => {
    const rig = await local();
    const record = await create(rig, { kind: "decision", blocks: [paragraph] });
    await refuse(rig, record.uuid, {
      blocks: [paragraph, paragraph, paragraph, { type: "heading", text: "Later unsupported block" }],
    }, "decision_answer_too_long", 3);
    await refuse(rig, record.uuid, {
      blocks: [paragraph, { type: "card", text: "Missing title" }, { type: "heading", text: "Later" }],
    }, "decision_block_unsupported", 2);
  });

  it("counts adjacent list items together and refuses the first batch entry that splits the list too far", async () => {
    const rig = await local();
    const record = await create(rig, { kind: "decision", blocks: [
      paragraph, { type: "list-item", text: "First" }, { type: "list-item", text: "Last" },
      { type: "code", text: "answer()" },
    ] });
    const args = { after_block_id: record.blocks[1].id, blocks: [
      { type: "list-item", text: "Another" }, { type: "paragraph", text: "Splits the list" },
    ] };
    await refuse(rig, record.uuid, args, "decision_answer_too_long", 2);
    const result = await rig.ok("insert_block", {
      uuid: record.uuid, after_block_id: record.blocks[1].id,
      blocks: [{ type: "list-item", text: "Another" }, { type: "list-item", text: "One more" }],
    });
    expect((await rig.ok("get_doc", { uuid: record.uuid })).blocks).toMatchObject([
      record.blocks[0], record.blocks[1], ...result.blocks, record.blocks[2], record.blocks[3],
    ]);
  });

  it("keeps missing anchors and locked documents as call-level refusals", async () => {
    const rig = await local();
    const page = await create(rig);
    await refuse(rig, page.uuid, { after_block_id: "missing-anchor", blocks: [paragraph] }, "block_not_found");
    await rig.ok("archive_doc", { uuid: page.uuid });
    await refuse(rig, page.uuid, { blocks: [paragraph, paragraph] }, "doc_archived");
    const record = await create(rig, { kind: "decision", status: "decided", blocks: [paragraph] });
    await refuse(rig, record.uuid, { blocks: [paragraph, paragraph] }, "decision_read_only");
  });

  it("publishes one document update to a peer and moves the cursor once to the last stored text", async () => {
    const rig = await local();
    const page = await create(rig, { blocks: [paragraph] });
    const replica = rig.instance.replicas.replica(page.uuid);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(replica.doc));
    const updates: Uint8Array[] = [];
    const replicate = (update: Uint8Array) => { updates.push(update); Y.applyUpdate(peer, update); };
    replica.doc.on("update", replicate);
    const cursor = vi.spyOn(rig.instance.replicas, "publishCursor");
    const log = rig.instance.store.updateCount(replica.room);
    try {
      const result = await rig.ok("insert_block", {
        uuid: page.uuid, after_block_id: page.blocks[0].id,
        blocks: [paragraph, { type: "paragraph", text: "Ignored longer supplied text", inline: [{ text: "Final", marks: { bold: true } }] }],
      });
      expect(updates).toHaveLength(1);
      expect(rig.instance.store.updateCount(replica.room)).toBe(log + 1);
      expect(getBlocks(peer)).toMatchObject([page.blocks[0], ...result.blocks]);
      expect(cursor).toHaveBeenCalledExactlyOnceWith(replica, result.blocks[1].id, "Final".length);
    } finally {
      replica.doc.off("update", replicate);
      cursor.mockRestore();
      peer.destroy();
    }
  });

  it("does not claim nothing was written when directory persistence fails after the document batch is logged", async () => {
    const rig = await startServer(testConfig({ updatedAtCoarsenessMs: 0 }));
    rigs.push(rig);
    const page = await create(rig, { blocks: [paragraph] });
    const replica = rig.instance.replicas.replica(page.uuid);
    const directory = rig.instance.replicas.directory();
    const store = rig.instance.store;
    const log = store.updateCount(replica.room);
    const append = store.appendUpdate.bind(store);
    const failure = vi.spyOn(store, "appendUpdate").mockImplementation((...args) => {
      if (args[0] === directory.room) throw new Error("simulated directory append failure");
      return append(...args);
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    const replay = new Y.Doc();
    try {
      const result = await rig.call("insert_block", { uuid: page.uuid, blocks: [
        { type: "paragraph", text: "Durable first entry" },
        { type: "paragraph", text: "Durable second entry" },
      ] });
      expect(result).toMatchObject({ isError: true, payload: {
        error: "persistence_failed", room: directory.room,
      } });
      expect(JSON.stringify(result.payload)).not.toMatch(/nothing was written/i);
      expect(result.payload).not.toHaveProperty("entry_index");
      expect(store.updateCount(replica.room)).toBe(log + 1);
      expect(getBlocks(replica.doc).map(block => block.text))
        .toEqual(["Durable first entry", "Durable second entry", paragraph.text]);
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
});

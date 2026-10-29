import { listAnnotationRanges } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import { blockText } from "../src/replica.js";
import { cleanupTestResources, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: rigs.splice(0).map((rig) => () => rig.close()) });
});

async function fixture(text = "brave") {
  const rig = await startServer(testConfig({ databasePath: ":memory:" }));
  rigs.push(rig);
  const doc = await rig.ok("create_doc", {
    title: "Final resolution", description: "Resolved conversations stay retained and final.",
    blocks: [{ type: "paragraph", text }, { type: "paragraph", text: "Other text" }],
  });
  return { rig, doc, replica: rig.instance.replicas.replica(doc.uuid) };
}

describe("final comment resolution through MCP", () => {
  it("refuses false on open and resolved threads and refuses resolved replies and moves without writing", async () => {
    const { rig, doc, replica } = await fixture();
    const opened = await rig.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 5, text: "Question",
    });
    const threadId = opened.annotation.id;
    const logged = () => rig.instance.replicas.store.updateCount(replica.room);
    const beforeFalse = logged();
    expect(await rig.call("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Refused", resolved: false }))
      .toMatchObject({ isError: true, payload: { error: "resolution_final", recoveryClass: "manual",
        recovery: expect.stringContaining("Start a new comment"), applied: false, partial: false, synced: false } });
    expect(logged()).toBe(beforeFalse);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations).toEqual([opened.annotation]);

    const resolved = await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Done", resolved: true });
    expect(logged()).toBe(beforeFalse + 1);
    expect(resolved.annotation).toMatchObject({ resolved: true, comments: [{ text: "Question" }, { text: "Done" }] });
    const before = await rig.ok("get_doc", { uuid: doc.uuid });
    const beforeRefusals = logged();
    for (const [fields, code] of [
      [{ resolved: false }, "resolution_final"],
      [{}, "thread_resolved"],
      [{ resolved: true }, "thread_resolved"],
      [{ block_id: doc.blocks[1].id, start: 0, end: 5 }, "thread_resolved"],
    ] as const) {
      const refused = await rig.call("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Refused", ...fields });
      expect(refused).toMatchObject({ isError: true, payload: { error: code, recoveryClass: "manual",
        recovery: expect.stringContaining("Start a new comment"), applied: false, partial: false, synced: false } });
      expect(refused.payload.message).toBe("This conversation was resolved. Start a new comment to continue.");
      expect(logged()).toBe(beforeRefusals);
      expect(await rig.ok("get_doc", { uuid: doc.uuid })).toEqual(before);
    }
  });

  it.each(["exact", "wider", "second mark"])("replaces a resolved %s anchor in one update while retaining its conversation", async (scenario) => {
    const { rig, doc, replica } = await fixture(scenario === "wider" ? "brave words" : "brave");
    const opened = await rig.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: scenario === "wider" ? 11 : 5, text: "Original question",
    });
    const threadId = opened.annotation.id;
    if (scenario === "second mark") {
      blockText(replica.doc, doc.blocks[1].id)!.format(0, 5, { comment: { threadId } });
    }
    const resolved = await rig.ok("annotate", { uuid: doc.uuid, thread_id: threadId, text: "Done", resolved: true });
    const logged = rig.instance.replicas.store.updateCount(replica.room);
    const created = await rig.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 5, text: "A new conversation",
    });
    expect(rig.instance.replicas.store.updateCount(replica.room)).toBe(logged + 1);
    expect(created.annotation).toMatchObject({ range: { start: 0, end: 5, collapsed: false } });
    expect(created.annotation.resolved).not.toBe(true);
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.annotations).toHaveLength(2);
    expect(read.annotations.find((thread: { id: string }) => thread.id === threadId))
      .toEqual({ ...resolved.annotation, range: null });
    expect(listAnnotationRanges(replica.doc, doc.blocks[0].id)).toMatchObject([{ threadId: created.annotation.id }]);
    expect(listAnnotationRanges(replica.doc, doc.blocks[1].id)).toEqual([]);
  });

  it("refuses a new range across resolved and open threads atomically and keeps moves off resolved anchors", async () => {
    const { rig, doc, replica } = await fixture("one two three");
    const resolved = await rig.ok("annotate", { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Resolved" });
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: resolved.annotation.id, text: "Done", resolved: true });
    const open = await rig.ok("annotate", { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 4, end: 7, text: "Open" });
    const before = await rig.ok("get_doc", { uuid: doc.uuid });
    const logged = rig.instance.replicas.store.updateCount(replica.room);
    const refused = await rig.call("annotate", { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 7, text: "Refused" });
    expect(refused).toMatchObject({ isError: true, payload: {
      error: "annotation_range", reason: "overlap", conflictingThreadId: open.annotation.id, applied: false, partial: false, synced: false,
    } });
    const move = await rig.call("annotate", { uuid: doc.uuid, thread_id: open.annotation.id,
      block_id: doc.blocks[0].id, start: 0, end: 3, text: "Refused move" });
    expect(move).toMatchObject({ isError: true, payload: {
      error: "annotation_range", reason: "overlap", conflictingThreadId: resolved.annotation.id, applied: false, partial: false, synced: false,
    } });
    expect(rig.instance.replicas.store.updateCount(replica.room)).toBe(logged);
    expect(await rig.ok("get_doc", { uuid: doc.uuid })).toEqual(before);
  });
});

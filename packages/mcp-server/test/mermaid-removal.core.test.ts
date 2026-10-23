import { randomUUID } from "node:crypto";
import {
  appendBlock,
  createAnnotation,
  decisionApprovalFingerprint,
  getBlocks,
  getBlocksFragment,
  getMeta,
  getMetaMap,
  initDoc,
  roomForDoc,
  setKind,
  setStatus,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cleanupTestResources, directoryStub, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const docs: Y.Doc[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map(rig => () => rig.close()),
    after: docs.splice(0).map(doc => () => doc.destroy()),
  });
});

async function server(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

function mermaid(doc: Y.Doc, source = "flowchart LR; A --> B"): string {
  const id = randomUUID();
  const block = new Y.XmlElement("mermaid");
  block.setAttribute("id", id);
  const text = new Y.XmlText();
  text.insert(0, source);
  block.insert(0, [text]);
  getBlocksFragment(doc).push([block]);
  return id;
}

function legacy(decided: boolean) {
  const doc = new Y.Doc();
  docs.push(doc);
  const uuid = randomUUID();
  initDoc(doc, { uuid, title: "Stored diagram", description: "An older client's document." });
  appendBlock(doc, { type: "paragraph", text: "Keep this prose." });
  const id = mermaid(doc);
  const thread = createAnnotation(doc, id, 0, 9, "Reader", "Existing discussion");
  appendBlock(doc, { type: "code", language: "mermaid", text: "sequenceDiagram\n  A->>B: Keep this code" });
  if (decided) {
    setKind(doc, "decision");
    setStatus(doc, "decided");
    getMetaMap(doc).set("decidedBy", "Owner");
    getMetaMap(doc).set("decidedAt", "2026-10-12");
    getMetaMap(doc).set("decidedWhere", "A recorded answer.");
    getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
  }
  return { doc, uuid, id, thread, survivors: getBlocks(doc).filter(block => block.id !== id) };
}

describe("stored Mermaid removal through MCP", () => {
  it.each([
    { archived: false, decided: false },
    { archived: true, decided: false },
    { archived: false, decided: true },
    { archived: true, decided: true },
  ])("removes stored blocks on opening $archived archived / $decided decided documents", async ({ archived, decided }) => {
    const rig = await server();
    const old = legacy(decided);
    const approval = getMeta(old.doc);
    rig.instance.store.appendUpdate(roomForDoc(WORKSPACE, old.uuid), Y.encodeStateAsUpdate(old.doc), "remote");
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: old.uuid, title: approval.title,
      ...(decided ? { kind: "decision", status: "decided", topic: old.uuid } : {}),
      ...(archived ? { deleted: true } : {}),
    });

    const read = await rig.ok("get_doc", { uuid: old.uuid });
    expect(read.blocks).toEqual(old.survivors);
    expect(read.annotations).toMatchObject([{ id: old.thread.id, range: null }]);
    if (decided) {
      expect(read).toMatchObject({
        approvalChanged: true, approvalFingerprint: approval.approvalFingerprint,
        decidedBy: approval.decidedBy, decidedAt: approval.decidedAt, decidedWhere: approval.decidedWhere,
      });
    }
    const exported = await rig.ok("export_markdown", { uuid: old.uuid, frontmatter: false });
    expect(exported.markdown).not.toContain("flowchart");
    expect(exported.markdown).toContain("Keep this prose.");
    expect(exported.markdown).toContain("```mermaid\nsequenceDiagram\n  A->>B: Keep this code\n```");
    const replica = rig.instance.replicas.replica(old.uuid);
    expect(getBlocksFragment(replica.doc).toArray()).toHaveLength(2);

    const durable = new Y.Doc();
    docs.push(durable);
    const log = rig.instance.store.readSince(replica.room, 0);
    if (log.snapshot !== null) Y.applyUpdate(durable, log.snapshot.state);
    for (const update of log.updates) Y.applyUpdate(durable, update.payload);
    expect(getBlocks(durable)).toEqual(old.survivors);
    const before = rig.instance.store.logSize();
    await rig.ok("get_doc", { uuid: old.uuid });
    await rig.ok("export_markdown", { uuid: old.uuid });
    expect(rig.instance.store.logSize()).toBe(before);
  });

  it("keeps orphan discussions counted and permits replies, resolution and reopening on decided records", async () => {
    const rig = await server();
    const old = legacy(true);
    rig.instance.store.appendUpdate(roomForDoc(WORKSPACE, old.uuid), Y.encodeStateAsUpdate(old.doc), "local");
    rig.instance.replicas.replica(old.uuid);
    expect((await rig.ok("list_docs", { kind: "decision", has_open_threads: true })).docs).toMatchObject([
      { uuid: old.uuid, openThreadCount: 1 },
    ]);
    expect(directoryStub(rig.instance, old.uuid)?.approvalChanged).toBe(true);
    for (const resolved of [false, true, false]) {
      const replied = await rig.ok("annotate", { uuid: old.uuid, thread_id: old.thread.id, text: "Continue discussion", resolved });
      expect(replied.annotation).toMatchObject({ range: null, resolved });
      expect((await rig.ok("list_docs", { kind: "decision" })).docs[0].openThreadCount).toBe(resolved ? 0 : 1);
    }
    expect((await rig.ok("get_doc", { uuid: old.uuid })).annotations[0].comments).toHaveLength(4);
    expect(getMeta(rig.instance.replicas.replica(old.uuid).doc).approvalFingerprint).toBe(getMeta(old.doc).approvalFingerprint);
  });

  it("removes late older-client writes received through the log and live updates", async () => {
    const rig = await server();
    const created = await rig.ok("create_doc", {
      title: "Shared", description: "An open replica receives older writes.",
      blocks: [{ type: "paragraph", text: "Keep this text." }],
    });
    const replica = rig.instance.replicas.replica(created.uuid);
    const seeded = getBlocks(replica.doc);
    const older = new Y.Doc();
    docs.push(older);
    Y.applyUpdate(older, Y.encodeStateAsUpdate(replica.doc));
    mermaid(older, "late log write");
    rig.instance.store.appendUpdate(replica.room, Y.encodeStateAsUpdate(older), "local");
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(seeded);
    mermaid(older, "offline reconnect write");
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(older), "remote-client");
    expect(getBlocks(replica.doc)).toEqual(seeded);
    Y.applyUpdate(older, Y.encodeStateAsUpdate(replica.doc));
    expect(getBlocksFragment(older).toArray()).toHaveLength(1);
    await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "paragraph", text: "Still editable." }] });
  });

  it("preserves approval and writes nothing when an approved record has no Mermaid block", async () => {
    const rig = await server();
    const created = await rig.ok("create_doc", {
      title: "Unaffected", description: "An answer with ordinary code.", kind: "decision", status: "decided",
      blocks: [{ type: "code", language: "mermaid", text: "flowchart LR; A --> B" }],
    });
    const replica = rig.instance.replicas.replica(created.uuid);
    const before = Y.encodeStateAsUpdate(replica.doc);
    const fingerprint = getMeta(replica.doc).approvalFingerprint;
    const count = rig.instance.store.logSize();
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    await rig.ok("export_markdown", { uuid: created.uuid });
    expect(read.approvalChanged).toBe(false);
    expect(read.approvalFingerprint).toBe(fingerprint);
    expect(Y.encodeStateAsUpdate(replica.doc)).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(count);
  });

  it("refuses Mermaid as an input block type without writing", async () => {
    const rig = await server();
    const created = await rig.ok("create_doc", { title: "No Mermaid type", description: "Only current block types are accepted." });
    const count = rig.instance.store.logSize();
    expect((await rig.call("create_doc", {
      title: "Refused", description: "No old block type.", blocks: [{ type: "mermaid", text: "flowchart LR; A --> B" }],
    })).payload.error).toBe("schema_validation");
    expect((await rig.call("insert_block", { uuid: created.uuid, blocks: [{ type: "mermaid", text: "flowchart LR; A --> B" }] })).payload.error).toBe("schema_validation");
    expect(rig.instance.store.logSize()).toBe(count);
  });
});

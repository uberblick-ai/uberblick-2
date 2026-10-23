/** Recorded answers, immutable decided content and directory-backed approval state. */
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MAX_TLDR_LENGTH, decisionApprovalFingerprint, editBlock, getBlocks, getDirectoryEntry, getDirectoryMap, getMetaMap, setTldr, setTitle } from "@uberblick/schema";
import { directoryStub, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const answer = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };
const body = [{ type: "paragraph", text: "Use the append-only update log because replay preserves the history." }];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Persistence", description: "The durable choice of storage.", kind: "decision", blocks: body, ...fields });
}

async function legacyDecision(rig: Rig, fields: Record<string, unknown>) {
  const { tldr, ...current } = fields;
  const record = await decision(rig, current);
  const doc = rig.instance.replicas.replica(record.uuid).doc;
  setTldr(doc, tldr as string);
  if (fields.answer !== undefined) getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
  await rig.ok("get_doc", { uuid: record.uuid });
  return record;
}

function state(rig: Rig, uuid?: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    ...(uuid === undefined ? {} : { document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc) }),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, name: string, args: Record<string, unknown>, error: string, uuid?: string) {
  const before = state(rig, uuid);
  const result = await rig.call(name, args);
  expect(result.isError).toBe(true);
  expect(result.payload).toMatchObject({ error, applied: false, partial: false, synced: false });
  expect(state(rig, uuid)).toEqual(before);
  return result.payload;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("decision authority through MCP", () => {
  it("takes a first stance without Reconsidering and confirms it only with a recorded answer", async () => {
    const rig = await localRig();
    const born = await decision(rig, { status: "decided" });
    const later = await decision(rig);
    await rig.ok("set_status", { uuid: later.uuid, status: "decided" });
    for (const record of [born, later]) {
      expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ status: "decided", agentStance: true });
      await rig.ok("set_status", { uuid: record.uuid, status: "decided" });
      expect((await rig.ok("get_doc", { uuid: record.uuid })).agentStance).toBe(true);
      const confirmed = await rig.ok("set_status", { uuid: record.uuid, status: "decided", answer });
      expect(confirmed).toMatchObject({ status: "decided" });
      expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({
        decidedBy: answer.who, decidedAt: answer.when, decidedWhere: answer.where, approvalChanged: false,
      });
      expect((await rig.ok("get_doc", { uuid: record.uuid })).agentStance).not.toBe(true);
      await rig.ok("set_status", { uuid: record.uuid, status: "decided" });
      expect((await rig.ok("get_doc", { uuid: record.uuid })).agentStance).not.toBe(true);
    }
    expect((await rig.call("set_status", { uuid: born.uuid, status: "decided", agentStance: false })).payload.error).toBe("schema_validation");
    // A foreign offline writer can merge an open status onto an answered first
    // record. That must never make the first-stance door available again.
    getMetaMap(rig.instance.replicas.replica(born.uuid).doc).set("status", "open");
    await rig.ok("get_doc", { uuid: born.uuid });
    await refuse(rig, "set_status", { uuid: born.uuid, status: "decided" }, "decision_answer_required", born.uuid);
    expect((await rig.ok("get_doc", { uuid: born.uuid })).agentStance).not.toBe(true);
  });

  it("refuses successor decisions atomically until a complete answer is recorded", async () => {
    const rig = await localRig();
    const first = await decision(rig, { status: "decided" });
    const next = await decision(rig, { supersedes: first.uuid });
    await refuse(rig, "set_status", { uuid: next.uuid, status: "decided" }, "decision_answer_required", next.uuid);
    expect((await rig.ok("get_doc", { uuid: next.uuid })).status).toBe("open");
    await refuse(rig, "create_doc", {
      description: "A successor needs a person's answer.", kind: "decision", status: "decided", supersedes: first.uuid, blocks: body,
    }, "decision_answer_required");
    for (const invalid of [
      { who: "", when: answer.when, where: answer.where },
      { who: answer.who, when: "", where: answer.where },
      { who: answer.who, when: answer.when },
      { who: answer.who, when: answer.when, where: "  " },
    ]) {
      const before = state(rig, next.uuid);
      expect((await rig.call("set_status", { uuid: next.uuid, status: "decided", answer: invalid })).payload.error).toBe("schema_validation");
      expect(state(rig, next.uuid)).toEqual(before);
    }
    await rig.ok("set_status", { uuid: next.uuid, status: "decided", answer });
    expect(await rig.ok("get_doc", { uuid: next.uuid })).toMatchObject({ status: "decided", decidedBy: answer.who });
    expect((await rig.ok("get_doc", { uuid: next.uuid })).agentStance).not.toBe(true);
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ uuid: next.uuid, inForce: next.uuid, pending: [] }]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs).toHaveLength(2);
  });

  it("requires a reason and answer for rejection and permits it only for a proposal", async () => {
    const rig = await localRig();
    const open = await decision(rig);
    const stance = await decision(rig, { status: "decided" });
    await refuse(rig, "set_status", { uuid: open.uuid, status: "rejected", reason: "Another option won." }, "decision_answer_required", open.uuid);
    await refuse(rig, "set_status", { uuid: open.uuid, status: "rejected", answer }, "decision_reason_required", open.uuid);
    await refuse(rig, "set_status", { uuid: open.uuid, status: "rejected", answer, reason: "   " }, "decision_reason_required", open.uuid);
    for (const record of [open, stance]) {
      await rig.ok("set_status", { uuid: record.uuid, status: "rejected", answer, reason: "  Another option won.  " });
      expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ status: "rejected", rejectionReason: "Another option won.", decidedBy: answer.who });
    }
    const first = await decision(rig, { status: "decided", answer });
    await refuse(rig, "set_status", { uuid: first.uuid, status: "rejected", answer, reason: "Cannot reject the answer in force." }, "decision_transition_invalid", first.uuid);
    const left = await decision(rig, { status: "decided", supersedes: first.uuid, answer });
    const right = await decision(rig, { status: "decided", supersedes: first.uuid, answer });
    expect((await rig.ok("get_doc", { uuid: left.uuid })).resolution.conflicts).toHaveLength(2);
    await refuse(rig, "set_status", { uuid: first.uuid, status: "rejected", answer, reason: "A superseded answer is history." }, "decision_transition_invalid", first.uuid);
    await rig.ok("set_status", { uuid: right.uuid, status: "rejected", answer, reason: "Prefer the other side of the conflict." });
    expect((await rig.ok("get_doc", { uuid: left.uuid })).resolution).toMatchObject({ inForce: left.uuid, conflicts: [] });
  });

  it("withdraws open records, keeps final records in history, and never reopens a decided record", async () => {
    const rig = await localRig();
    const first = await decision(rig, { status: "decided" });
    for (const status of ["open", "withdrawn"]) {
      await refuse(rig, "set_status", { uuid: first.uuid, status, answer }, "decision_transition_invalid", first.uuid);
    }
    const withdrawn = await decision(rig, { supersedes: first.uuid });
    const rejected = await decision(rig, { supersedes: first.uuid });
    await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", answer, reason: "Not the desired direction." });
    for (const record of [withdrawn, rejected]) {
      for (const status of ["open", "decided", "rejected", "withdrawn"]) {
        await refuse(rig, "set_status", { uuid: record.uuid, status, answer, reason: "No final reversal." }, "decision_transition_invalid", record.uuid);
      }
    }
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.map((record: any) => record.uuid).sort()).toEqual([first.uuid, withdrawn.uuid, rejected.uuid].sort());
    expect((await rig.ok("get_doc", { uuid: first.uuid })).resolution).toMatchObject({ inForce: first.uuid, pending: [] });
    for (const status of ["rejected", "withdrawn"]) {
      await refuse(rig, "create_doc", { title: "No existing proposal", description: "Final states require an existing record.", kind: "decision", status, answer }, "decision_transition_invalid");
    }
  });

  it("explains the decided content lock while comments and unapproved metadata remain writable", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Reference", description: "A curated reference." });
    const record = await legacyDecision(rig, { status: "decided", answer, tldr: "Use the update log." });
    const block = record.blocks[0];
    const refused = await refuse(rig, "set_metadata", { uuid: record.uuid, tldr: "Changed decision line." }, "decision_read_only", record.uuid);
    expect(refused).toMatchObject({
      message: "A decided record's answer blocks and structured data are read-only; decisions have no TL;DR. Create a superseding record.",
      recoveryClass: "manual",
      recovery: "A decided record's answer blocks, structured data and discussion reference are read-only. Decisions have no TL;DR. Create an open superseding record " +
        "for any answer change, then record a person's answer to decide it. Titles stay editable without changing approval; comments stay open.",
    });
    const thread = await rig.ok("annotate", { uuid: record.uuid, block_id: block.id, start: 0, end: 3, text: "Discuss the rationale." });
    await rig.ok("annotate", { uuid: record.uuid, thread_id: thread.annotation.id, text: "Resolved in discussion.", resolved: true });
    await rig.ok("set_metadata", { uuid: record.uuid, description: "Updated discovery copy." });
    await rig.ok("set_metadata", { uuid: record.uuid, tags: ["mcp"] });
    await rig.ok("set_metadata", { uuid: record.uuid, links: [target.uuid] });
    await rig.ok("set_metadata", { uuid: record.uuid, title: "Reworded topic" });
    const read = await rig.ok("get_doc", { uuid: record.uuid });
    expect(read).toMatchObject({ title: "Reworded topic", tldr: null, approvalChanged: false, description: "Updated discovery copy." });
    expect(read.blocks[0]).toMatchObject({ id: block.id, rev: block.rev });
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)).toMatchObject({ approvalChanged: false, commentCount: 2 });
  });

  it("hides stored legacy TL;DR without rewriting it", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Owning page", description: "The page this decision governs." });
    const first = await legacyDecision(rig, { status: "decided", answer, related: page.uuid, tldr: "  Use the update log.  " });
    const next = await legacyDecision(rig, { status: "decided", supersedes: first.uuid, answer, tldr: "Use a database-backed update log." });
    for (const [record, tldr] of [[first, "  Use the update log.  "], [next, "Use a database-backed update log."]] as const) {
      const doc = rig.instance.replicas.replica(record.uuid).doc;
      const before = Y.encodeStateAsUpdate(doc);
      const fingerprint = getMetaMap(doc).get("approvalFingerprint");
      for (let read = 0; read < 2; read++) {
        const result = await rig.ok("get_doc", { uuid: record.uuid });
        expect(result).toMatchObject({ tldr: null, approvalChanged: false });
        for (const entry of [...result.predecessors, ...result.successors]) {
          expect(entry).not.toHaveProperty("tldr");
          expect(entry.answerPreview).toBe(body[0]!.text);
        }
      }
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(getMetaMap(doc).get("tldr")).toBe(tldr);
      expect(getMetaMap(doc).get("approvalFingerprint")).toBe(fingerprint);
      expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
      expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)).not.toHaveProperty("tldr");
      const row = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.find((row: any) => row.uuid === record.uuid);
      expect(row).not.toHaveProperty("tldr");
      expect(row.answerPreview).toBe(body[0]!.text);
      expect(await rig.ok("set_metadata", { uuid: record.uuid, description: "Updated discovery copy." })).toMatchObject({ tldr: null });
      expect(getMetaMap(doc).get("tldr")).toBe(tldr);
      expect(record).not.toHaveProperty("tldrHint");
    }
    const topics = (await rig.ok("list_docs", { kind: "decision" })).docs;
    const pageTopics = (await rig.ok("get_doc", { uuid: page.uuid })).decisions;
    for (const topic of [...topics, ...pageTopics]) {
      expect(topic).not.toHaveProperty("tldr");
      expect(topic.inForce).not.toHaveProperty("tldr");
      expect(topic.answerPreview).toBe(body[0]!.text);
    }
    expect(getMetaMap(rig.instance.replicas.replica(next.uuid).doc).get("approvalFingerprint")).toEqual(expect.any(String));
    expect((await rig.ok("get_doc", { uuid: (await decision(rig)).uuid })).tldr).toBeNull();
    expect((await rig.ok("get_doc", { uuid: (await decision(rig, { tldr: null })).uuid })).tldr).toBeNull();
    const exact = await legacyDecision(rig, { tldr: "x".repeat(MAX_TLDR_LENGTH) });
    expect((await rig.ok("get_doc", { uuid: exact.uuid })).tldr).toBeNull();
    for (const tldr of ["", "  ", "x".repeat(MAX_TLDR_LENGTH + 1)]) {
      const before = state(rig);
      expect((await rig.call("create_doc", { title: "Invalid line", description: "The same TL;DR limits as set_metadata.", kind: "decision", status: "decided", tldr })).payload.error).toBe("schema_validation");
      expect(state(rig)).toEqual(before);
    }
  });

  it("detects merged changes to every approved content field and reapproves the current content", async () => {
    const rig = await localRig();
    const record = await legacyDecision(rig, { status: "decided", answer, tldr: "Use the update log." });
    const doc = rig.instance.replicas.replica(record.uuid).doc;
    const changedAgain = { who: "Another workspace member", when: "2026-10-05T08:00:00Z", where: "An in-person review." };
    const edits: ((offline: Y.Doc) => void)[] = [
      offline => setTldr(offline, "Use the database-backed log."),
      offline => {
        const block = getBlocks(offline)[0];
        if (block === undefined) throw new Error("No decision block");
        editBlock(offline, block.id, block.text, "Use the log with a revised rationale.", { rev: block.rev });
      },
    ];
    for (const edit of edits) {
      const offline = new Y.Doc();
      try {
        Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
        const vector = Y.encodeStateVector(doc);
        edit(offline);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(offline, vector), "remote");
        expect((await rig.ok("get_doc", { uuid: record.uuid })).approvalChanged).toBe(true);
        expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.approvalChanged).toBe(true);
        await rig.ok("set_status", { uuid: record.uuid, status: "decided", answer: changedAgain });
        expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ approvalChanged: false, decidedBy: changedAgain.who, decidedAt: changedAgain.when, decidedWhere: changedAgain.where });
        expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.approvalChanged).toBe(false);
      } finally {
        offline.destroy();
      }
    }
  });

  it("preserves answer approval across local and synced title renames without clearing an answer warning", async () => {
    const rig = await localRig();
    const record = await legacyDecision(rig, { status: "decided", answer, tldr: "Use the update log." });
    const untouched = await decision(rig, { status: "decided", answer });
    const doc = rig.instance.replicas.replica(record.uuid).doc;
    const fingerprint = getMetaMap(doc).get("approvalFingerprint");
    await rig.ok("set_metadata", { uuid: record.uuid, title: "Which persistence should we use?" });
    expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ approvalChanged: false });

    const offline = new Y.Doc();
    try {
      Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
      const vector = Y.encodeStateVector(doc);
      setTitle(offline, "What should store workspace updates?");
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(offline, vector), "remote");
      expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({
        title: "What should store workspace updates?", approvalChanged: false,
      });
    } finally {
      offline.destroy();
    }
    const block = getBlocks(doc)[0]!;
    editBlock(doc, block.id, block.text, "A changed answer that has not been approved.", { rev: block.rev });
    expect((await rig.ok("get_doc", { uuid: record.uuid })).approvalChanged).toBe(true);
    await rig.ok("set_metadata", { uuid: record.uuid, title: "How do we persist updates?" });
    expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ approvalChanged: true });
    expect(getMetaMap(doc).get("approvalFingerprint")).toBe(fingerprint);
    const rows = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(rows.find((row: any) => row.uuid === record.uuid)).toMatchObject({ title: "How do we persist updates?", inForce: record.uuid });
    expect(rows.find((row: any) => row.uuid === untouched.uuid)).toMatchObject({ inForce: untouched.uuid });
    expect(directoryStub(rig.instance, record.uuid)?.approvalChanged).toBe(true);
    expect(directoryStub(rig.instance, untouched.uuid)?.approvalChanged).toBe(false);
  });

  it("exposes stance and answer caches on representative, in-force, pending and conflict entries without opening record rooms", async () => {
    const author = await localRig();
    const stance = await decision(author, { status: "decided" });
    const pending = await decision(author, { supersedes: stance.uuid });
    const first = await decision(author, { status: "decided", answer });
    const left = await decision(author, { supersedes: first.uuid, status: "decided", answer });
    const right = await decision(author, { supersedes: first.uuid, status: "decided", answer });
    setTldr(author.instance.replicas.replica(right.uuid).doc, "Merged after approval.");
    await author.ok("get_doc", { uuid: right.uuid });
    for (const record of [stance, pending, first, left, right]) {
      const directory = author.instance.replicas.directory().doc;
      getDirectoryMap(directory).set(record.uuid, { ...getDirectoryEntry(directory, record.uuid), tldr: "A stale legacy summary." });
    }
    const reader = await localRig();
    Y.applyUpdate(reader.instance.replicas.directory().doc, Y.encodeStateAsUpdate(author.instance.replicas.directory().doc));
    const rows = (await reader.ok("list_docs", { kind: "decision" })).docs;
    const stanceRow = rows.find((row: any) => row.topic === stance.uuid);
    expect(stanceRow).toMatchObject({ uuid: stance.uuid, inForce: stance.uuid, pending: [pending.uuid] });
    expect(stanceRow).not.toHaveProperty("tldr");
    expect(directoryStub(reader.instance, stance.uuid)?.agentStance).toBe(true);
    for (const uuid of [stance.uuid, pending.uuid]) expect(directoryStub(reader.instance, uuid)).not.toHaveProperty("tldr");
    const conflictRow = rows.find((row: any) => row.topic === first.uuid);
    expect(conflictRow.inForce).toBeNull();
    expect([...conflictRow.conflicts].sort()).toEqual([left.uuid, right.uuid].sort());
    for (const uuid of conflictRow.conflicts) {
      const conflict = directoryStub(reader.instance, uuid);
      expect(conflict).toMatchObject({ decidedBy: answer.who, decidedAt: answer.when });
      expect(conflict?.agentStance).not.toBe(true);
      expect(conflict).not.toHaveProperty("tldr");
      expect(conflict?.answerPreview).toBe(body[0]!.text);
    }
    expect(directoryStub(reader.instance, right.uuid)?.approvalChanged).toBe(true);
    expect(directoryStub(reader.instance, first.uuid)).toMatchObject({ decidedBy: answer.who, decidedAt: answer.when, approvalChanged: false });
    for (const uuid of [stance.uuid, pending.uuid, first.uuid, left.uuid, right.uuid]) expect(reader.instance.replicas.hydrated(uuid)).toBe(false);
  });
});

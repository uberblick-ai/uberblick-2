/** Recorded answers, immutable decided content and directory-backed approval state. */
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  MAX_TLDR_LENGTH,
  editBlock,
  getBlocks,
  getDirectoryEntry,
  getMetaMap,
  setTldr,
  setTitle,
} from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

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
      title: "Replacement", description: "A successor needs a person's answer.", kind: "decision", status: "decided", supersedes: first.uuid, blocks: body,
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
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ uuid: next.uuid, inForce: { uuid: next.uuid }, pending: [] }]);
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
    expect((await rig.ok("get_doc", { uuid: left.uuid })).resolution).toMatchObject({ inForce: { uuid: left.uuid }, conflicts: [] });
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
    expect((await rig.ok("get_doc", { uuid: first.uuid })).resolution).toMatchObject({ inForce: { uuid: first.uuid }, pending: [] });
    for (const status of ["rejected", "withdrawn"]) {
      await refuse(rig, "create_doc", { title: "No existing proposal", description: "Final states require an existing record.", kind: "decision", status, answer }, "decision_transition_invalid");
    }
  });

  it("protects all decided content doors while comments and unapproved metadata remain writable", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Reference", description: "A curated reference." });
    const record = await decision(rig, { status: "decided", answer, tldr: "Use the update log." });
    const block = record.blocks[0];
    const mutations: [string, Record<string, unknown>][] = [
      ["set_title", { title: "Reworded topic" }],
      ["set_tldr", { tldr: "Changed decision line." }],
      ["edit_block", { block_id: block.id, old_text: block.text, new_text: "Changed text.", rev: block.rev }],
      ["insert_block", { type: "paragraph", text: "Additional reasoning." }],
      ["delete_block", { block_id: block.id }],
      ["link_range", { block_id: block.id, start: 0, end: 3, doc_id: target.uuid, rev: block.rev }],
    ];
    for (const [name, args] of mutations) await refuse(rig, name, { uuid: record.uuid, ...args }, "decision_read_only", record.uuid);
    const thread = await rig.ok("annotate", { uuid: record.uuid, block_id: block.id, start: 0, end: 3, text: "Discuss the rationale." });
    await rig.ok("annotate", { uuid: record.uuid, thread_id: thread.annotation.id, text: "Resolved in discussion.", resolved: true });
    await rig.ok("set_description", { uuid: record.uuid, description: "Updated discovery copy." });
    await rig.ok("set_tags", { uuid: record.uuid, tags: ["mcp"] });
    await rig.ok("set_links", { uuid: record.uuid, links: [target.uuid] });
    await rig.ok("set_changelog_suggestion", { uuid: record.uuid, suggestion: "Explain the storage choice." });
    const read = await rig.ok("get_doc", { uuid: record.uuid });
    expect(read).toMatchObject({ title: "Persistence", tldr: "Use the update log.", approvalChanged: false, description: "Updated discovery copy.", changelogSuggestion: "Explain the storage choice." });
    expect(read.blocks[0].text).toBe(block.text);
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)).toMatchObject({ approvalChanged: false, commentCount: 2 });
  });

  it("seeds and validates the decision line before direct decided creation freezes it", async () => {
    const rig = await localRig();
    const first = await decision(rig, { status: "decided", tldr: "  Use the update log.  " });
    const next = await decision(rig, { status: "decided", supersedes: first.uuid, answer, tldr: "Use a database-backed update log." });
    for (const [record, tldr] of [[first, "Use the update log."], [next, "Use a database-backed update log."]] as const) {
      expect((await rig.ok("get_doc", { uuid: record.uuid })).tldr).toBe(tldr);
      expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.tldr).toBe(tldr);
      expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.find((row: any) => row.uuid === record.uuid)?.tldr).toBe(tldr);
      expect(JSON.stringify(record)).not.toContain("set_tldr");
    }
    expect(getMetaMap(rig.instance.replicas.replica(next.uuid).doc).get("approvalFingerprint")).toEqual(expect.any(String));
    expect((await rig.ok("get_doc", { uuid: (await decision(rig)).uuid })).tldr).toBeNull();
    expect((await rig.ok("get_doc", { uuid: (await decision(rig, { tldr: null })).uuid })).tldr).toBeNull();
    const exact = await decision(rig, { tldr: "x".repeat(MAX_TLDR_LENGTH) });
    expect((await rig.ok("get_doc", { uuid: exact.uuid })).tldr).toHaveLength(MAX_TLDR_LENGTH);
    for (const tldr of ["", "  ", "x".repeat(MAX_TLDR_LENGTH + 1)]) {
      const before = state(rig);
      expect((await rig.call("create_doc", { title: "Invalid line", description: "The same TL;DR limits as set_tldr.", kind: "decision", status: "decided", tldr })).payload.error).toBe("schema_validation");
      expect(state(rig)).toEqual(before);
    }
  });

  it("detects merged changes to every approved content field and reapproves the current content", async () => {
    const rig = await localRig();
    const record = await decision(rig, { status: "decided", answer, tldr: "Use the update log." });
    const doc = rig.instance.replicas.replica(record.uuid).doc;
    const changedAgain = { who: "Another workspace member", when: "2026-10-05T08:00:00Z", where: "An in-person review." };
    const edits: ((offline: Y.Doc) => void)[] = [
      offline => setTitle(offline, "Updated persistence topic"),
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
        const listing = (await rig.ok("list_docs", { kind: "decision" })).docs[0];
        expect(listing).toMatchObject({ approvalChanged: true, inForce: { approvalChanged: true } });
        await rig.ok("set_status", { uuid: record.uuid, status: "decided", answer: changedAgain });
        expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ approvalChanged: false, decidedBy: changedAgain.who, decidedAt: changedAgain.when, decidedWhere: changedAgain.where });
        expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.approvalChanged).toBe(false);
      } finally {
        offline.destroy();
      }
    }
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
    const reader = await localRig();
    Y.applyUpdate(reader.instance.replicas.directory().doc, Y.encodeStateAsUpdate(author.instance.replicas.directory().doc));
    const rows = (await reader.ok("list_docs", { kind: "decision" })).docs;
    const stanceRow = rows.find((row: any) => row.topic === stance.uuid);
    expect(stanceRow).toMatchObject({ agentStance: true, inForce: { uuid: stance.uuid, agentStance: true }, pending: [{ uuid: pending.uuid }] });
    const conflictRow = rows.find((row: any) => row.topic === first.uuid);
    expect(conflictRow.inForce).toBeNull();
    expect(conflictRow.conflicts).toHaveLength(2);
    for (const conflict of conflictRow.conflicts) {
      expect(conflict).toMatchObject({ decidedBy: answer.who, decidedAt: answer.when });
      expect(conflict.agentStance).not.toBe(true);
    }
    expect(conflictRow.conflicts.find((row: any) => row.uuid === right.uuid)?.approvalChanged).toBe(true);
    const history = (await reader.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    expect(history.find((row: any) => row.uuid === first.uuid)).toMatchObject({ decidedBy: answer.who, decidedAt: answer.when, approvalChanged: false });
    for (const uuid of [stance.uuid, pending.uuid, first.uuid, left.uuid, right.uuid]) expect(reader.instance.replicas.hydrated(uuid)).toBe(false);
  });
});

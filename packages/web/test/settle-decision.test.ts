import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  directoryRoom,
  documentStubFields,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  resolveDecisionTopics,
  roomForDoc,
  setKind,
  setStatus,
  tombstoneDecisionRecord,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { watchDocumentStub } from "../src/collab/directory-stub.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { canSettleDecision, settleDecision, settlementFailure } from "../src/collab/settle-decision.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const FIRST = "9ebf44bd-97f8-479d-8e7c-5fbc96173504";
const PROPOSAL = "e795b3c7-cd85-4e6f-8950-a4f479b077ba";
const OTHER = "34865e42-d48f-497a-8e1b-132c504a3e45";
const NOW = "2026-11-02T12:00:00.000Z";
const LIVE: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true, hasAnswered: true,
  writable: true, storeRefused: false, unsyncedChanges: 0,
  protocolMismatch: null, authFailed: false, tokenMissing: false,
};
const docs: Y.Doc[] = [];
const stops: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const stop of stops) stop();
  for (const doc of docs) doc.destroy();
  stops.length = 0;
  docs.length = 0;
  vi.useRealTimers();
});

function connection(room: string): RoomConnection {
  const ydoc = new Y.Doc();
  docs.push(ydoc);
  return { room, ydoc, status: { ...LIVE }, provider: {}, onStatusChange: () => () => {} } as unknown as RoomConnection;
}

function record(uuid: string, status: "open" | "decided", supersedes?: string, blocks: BlockInput[] = [{ type: "paragraph", text: "The answer." }]): RoomConnection {
  const source = connection(roomForDoc(WORKSPACE, uuid));
  initDoc(source.ydoc, { uuid, title: "Which answer applies?", ...(supersedes === undefined ? {} : { topic: FIRST, supersedes }) });
  setKind(source.ydoc, "decision");
  setStatus(source.ydoc, status);
  for (const block of blocks) appendBlock(source.ydoc, block);
  return source;
}

function publish(directory: RoomConnection, source: RoomConnection): void {
  upsertDirectoryEntry(directory.ydoc, { ...documentStubFields(source.ydoc), createdAt: Date.now(), updatedAt: Date.now() });
}

function fixture(proposal = false, blocks?: BlockInput[]) {
  const directory = connection(directoryRoom(WORKSPACE));
  if (proposal) publish(directory, record(FIRST, "decided"));
  const uuid = proposal ? PROPOSAL : FIRST;
  const source = record(uuid, "open", proposal ? FIRST : undefined, blocks);
  publish(directory, source);
  stops.push(watchDocumentStub(source.ydoc, directory.ydoc, uuid));
  return { source, directory, uuid, displayName: "  Current reader  " };
}

function expectUnchanged(input: ReturnType<typeof fixture>, action: "decide" | "reject" | "withdraw" = "decide", reason?: string): void {
  const sourceBefore = Y.encodeStateAsUpdate(input.source.ydoc);
  const directoryBefore = Y.encodeStateAsUpdate(input.directory.ydoc);
  const result = settleDecision({ ...input, action, ...(reason === undefined ? {} : { reason }) });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  expect(Y.encodeStateAsUpdate(input.source.ydoc)).toEqual(sourceBefore);
  expect(Y.encodeStateAsUpdate(input.directory.ydoc)).toEqual(directoryBefore);
}

describe("settling a decision", () => {
  it("decides the first answer with MCP attribution at confirmation time and repairs its directory cache", () => {
    const input = fixture();
    expect(canSettleDecision(input)).toBe(true);
    expect(settlementFailure(input, "decide", input.displayName)).toBeNull();
    vi.setSystemTime("2026-11-02T12:10:00.000Z");
    expect(settleDecision({ ...input, action: "decide" })).toEqual({ ok: true });
    expect(getMeta(input.source.ydoc)).toMatchObject({
      status: "decided", decidedBy: "Current reader", decidedAt: "2026-11-02T12:10:00.000Z",
      decidedWhere: "Uberblick web: Settle decision", agentStance: false,
      approvalFingerprint: decisionApprovalFingerprint(input.source.ydoc),
    });
    expect(decisionApprovalChanged(input.source.ydoc)).toBe(false);
    expect(getDirectoryEntry(input.directory.ydoc, FIRST)).toMatchObject({ status: "decided", decidedBy: "Current reader", approvalChanged: false });
    expect(resolveDecisionTopics(input.directory.ydoc)[0]?.inForce?.uuid).toBe(FIRST);
    expect(canSettleDecision(input)).toBe(false);
  });

  it("puts only the selected proposal in force and supersedes its predecessor", () => {
    const input = fixture(true);
    publish(input.directory, record(OTHER, "open", FIRST));
    expect(settleDecision({ ...input, action: "decide" })).toEqual({ ok: true });
    const topic = resolveDecisionTopics(input.directory.ydoc)[0]!;
    expect(topic.inForce?.uuid).toBe(PROPOSAL);
    expect(topic.superseded.map((entry) => entry.uuid)).toEqual([FIRST]);
    expect(topic.pending.map((entry) => entry.uuid)).toEqual([OTHER]);
    expect(getDirectoryEntry(input.directory.ydoc, OTHER)?.status).toBe("open");
  });

  it("rejects with a trimmed reason and MCP attribution while keeping the current answer in force", () => {
    const input = fixture(true);
    expect(settleDecision({ ...input, action: "reject", reason: "  Keep the existing answer.  " })).toEqual({ ok: true });
    expect(getMeta(input.source.ydoc)).toMatchObject({
      status: "rejected", rejectionReason: "Keep the existing answer.", decidedBy: "Current reader", decidedAt: NOW,
      decidedWhere: "Uberblick web: Settle decision", agentStance: false,
      approvalFingerprint: decisionApprovalFingerprint(input.source.ydoc),
    });
    expect(decisionApprovalChanged(input.source.ydoc)).toBe(false);
    expect(resolveDecisionTopics(input.directory.ydoc)[0]?.inForce?.uuid).toBe(FIRST);
  });

  it("withdraws only the status, without requiring a display name or changing earlier metadata", () => {
    const input = fixture(true);
    getMetaMap(input.source.ydoc).set("decidedBy", "An existing field");
    const before = getMetaMap(input.source.ydoc).toJSON();
    expect(settleDecision({ ...input, action: "withdraw", displayName: "" })).toEqual({ ok: true });
    expect(getMetaMap(input.source.ydoc).toJSON()).toEqual({ ...before, status: "withdrawn" });
    expect(resolveDecisionTopics(input.directory.ydoc)[0]?.inForce?.uuid).toBe(FIRST);
  });

  it("does not offer withdrawal on an answer that is not under review", () => {
    const input = fixture();
    expect(canSettleDecision(input)).toBe(true);
    expect(settlementFailure(input, "withdraw", "")).toMatch(/under review/);
    expectUnchanged(input, "withdraw");
  });

  it.each(["decide", "reject"] as const)("requires a display name for %s", (action) => {
    const input = { ...fixture(true), displayName: " \t " };
    expect(settlementFailure(input, action, input.displayName, "Reason")).toMatch(/display name/);
    expectUnchanged(input, action, "Reason");
  });

  it.each([undefined, "", " \n "])("requires a nonblank rejection reason: %j", (reason) => {
    expectUnchanged(fixture(true), "reject", reason);
  });

  it.each([
    { name: "blank", blocks: [{ type: "paragraph", text: " \n " }], message: /non-blank/ },
    { name: "unsupported block", blocks: [{ type: "heading", text: "Heading" }], message: /paragraphs/ },
    { name: "four blocks", blocks: Array.from({ length: 4 }, () => ({ type: "paragraph", text: "Answer" })), message: /three blocks/ },
  ] satisfies Array<{ name: string; blocks: BlockInput[]; message: RegExp }>)("blocks Decide on a live $name answer while preserving Reject", ({ blocks, message }) => {
    const input = fixture(true, blocks);
    expect(settlementFailure(input, "decide", input.displayName)).toMatch(message);
    expectUnchanged(input);
    expect(settleDecision({ ...input, action: "reject", reason: "This answer is unsuitable." })).toEqual({ ok: true });
  });

  it("checks structured data with the same validator as MCP and leaves it untouched", () => {
    const input = fixture();
    input.source.ydoc.getMap("data").set("unsupported key", { version: 99 });
    expect(settlementFailure(input, "decide", input.displayName)).toMatch(/structured data/);
    expectUnchanged(input);
  });

  it("preserves MCP compatibility with hidden legacy TL;DR when deciding", () => {
    const input = fixture();
    getMetaMap(input.source.ydoc).set("tldr", "Legacy summary");
    expect(settleDecision({ ...input, action: "decide" })).toEqual({ ok: true });
    expect(getMetaMap(input.source.ydoc).get("tldr")).toBe("Legacy summary");
    expect(decisionApprovalChanged(input.source.ydoc)).toBe(false);
  });

  it("rechecks a competing proposal accepted since opening and still permits rejection or withdrawal", () => {
    const input = fixture(true);
    const other = record(OTHER, "open", FIRST);
    publish(input.directory, other);
    expect(settlementFailure(input, "decide", input.displayName)).toBeNull();
    setStatus(other.ydoc, "decided");
    publish(input.directory, other);
    expect(canSettleDecision(input)).toBe(true);
    expect(settlementFailure(input, "decide", input.displayName)).toMatch(/since been replaced/);
    expectUnchanged(input);
    expect(settlementFailure(input, "reject", input.displayName, "Keep the accepted proposal.")).toBeNull();
    expect(settlementFailure(input, "withdraw", "")).toBeNull();
  });

  it("explains when deciding an open predecessor would leave the newer answer in force", () => {
    const input = fixture();
    publish(input.directory, record(PROPOSAL, "decided", FIRST));
    expect(canSettleDecision(input)).toBe(true);
    expect(settlementFailure(input, "decide", input.displayName)).toMatch(/leave a newer answer in force/);
    expectUnchanged(input);
    expect(settlementFailure(input, "reject", input.displayName, "Keep the newer answer.")).toBeNull();
  });

  it.each([
    "source unwritable", "source unsynced", "directory unwritable", "directory unsynced",
    "room settled first", "directory settled first", "record archived", "topic archived", "conflict",
    "room identity changed", "record topic changed",
  ])("refuses every write when live state changed: %s", (change) => {
    const input = fixture(true);
    if (change === "source unwritable") input.source.status.writable = false;
    if (change === "source unsynced") input.source.status.synced = false;
    if (change === "directory unwritable") input.directory.status.writable = false;
    if (change === "directory unsynced") input.directory.status.synced = false;
    if (change === "room settled first") {
      setStatus(input.source.ydoc, "rejected");
      upsertDirectoryEntry(input.directory.ydoc, { ...getDirectoryEntry(input.directory.ydoc, PROPOSAL)!, status: "open" });
    }
    if (change === "directory settled first") upsertDirectoryEntry(input.directory.ydoc, { ...getDirectoryEntry(input.directory.ydoc, PROPOSAL)!, status: "withdrawn" });
    if (change === "record archived") expect(tombstoneDecisionRecord(input.directory.ydoc, PROPOSAL)).toBe(true);
    if (change === "topic archived") tombstoneDirectoryEntry(input.directory.ydoc, FIRST);
    if (change === "conflict") publish(input.directory, record(OTHER, "decided"));
    if (change === "conflict") upsertDirectoryEntry(input.directory.ydoc, { ...getDirectoryEntry(input.directory.ydoc, OTHER)!, topic: FIRST });
    if (change === "room identity changed") getMetaMap(input.source.ydoc).set("uuid", OTHER);
    if (change === "record topic changed") upsertDirectoryEntry(input.directory.ydoc, { ...getDirectoryEntry(input.directory.ydoc, PROPOSAL)!, topic: OTHER });
    expect(canSettleDecision(input)).toBe(false);
    expectUnchanged(input);
    expectUnchanged(input, "reject", "Reason");
    expectUnchanged(input, "withdraw");
  });
});

import {
  decisionApprovalFingerprint,
  decisionDocAnswerFailure,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  isDirectoryEntryArchived,
  parseRoom,
  resolveDecisionTopics,
  setStatus,
} from "@uberblick/schema";
import type { DecisionTopicResolution } from "@uberblick/schema";
import type { RoomConnection } from "./rooms.js";

export interface SettlementSource {
  source: RoomConnection;
  directory: RoomConnection;
  uuid: string;
}

export type SettlementAction = "decide" | "reject" | "withdraw";

interface SettlementInput extends SettlementSource {
  action: SettlementAction;
  displayName: string;
  reason?: string;
}

const answerMessages: Record<NonNullable<ReturnType<typeof decisionDocAnswerFailure>>, string> = {
  decision_answer_empty: "Write a non-blank answer before deciding.",
  decision_block_unsupported: "Use only paragraphs, lists, code blocks or tables in the answer before deciding.",
  decision_answer_too_long: "Shorten the answer to at most three blocks before deciding; adjacent list items count as one block.",
  decision_tldr_unsupported: "Remove the TL;DR before deciding.",
  decision_data_unsupported: "Remove structured data before deciding.",
};

function openRecord(input: SettlementSource): DecisionTopicResolution | string {
  if (!input.source.status.writable || !input.source.status.synced) {
    return "Wait for this record's room to synchronize and become writable.";
  }
  if (!input.directory.status.writable || !input.directory.status.synced) {
    return "Wait for the workspace directory to synchronize and become writable.";
  }
  const room = parseRoom(input.source.room);
  const directoryRoom = parseRoom(input.directory.room);
  const meta = getMeta(input.source.ydoc);
  const record = getDirectoryEntry(input.directory.ydoc, input.uuid);
  if (room.uuid !== input.uuid || meta.uuid !== input.uuid || meta.kind !== "decision" ||
    !directoryRoom.isDirectory || directoryRoom.workspaceId !== room.workspaceId || record?.kind !== "decision" ||
    (meta.topic ?? input.uuid) !== (record.topic ?? input.uuid)) {
    return "This record's room and directory no longer agree. Reopen the record before settling it.";
  }
  if (meta.status !== "open" || record.status !== "open") {
    return "This record is no longer open. Reopen it to see its current state.";
  }
  if (isDirectoryEntryArchived(input.directory.ydoc, input.uuid)) {
    return "This record or its topic is archived. Restore it before settling it.";
  }
  const topic = resolveDecisionTopics(input.directory.ydoc).find((entry) => entry.topic === (meta.topic ?? input.uuid));
  if (topic === undefined) return "This record's topic is no longer available. Reopen the record before settling it.";
  if (topic.conflicts.length > 0) return "This topic has conflicting answers. Resolve the conflict before settling an open record.";
  return topic;
}

export function canSettleDecision(input: SettlementSource): boolean {
  return typeof openRecord(input) !== "string";
}

/** Read live state both for menu explanations and immediately before writing. */
export function settlementFailure(input: SettlementSource, action: SettlementAction, displayName: string, reason?: string): string | null {
  const topic = openRecord(input);
  if (typeof topic === "string") return topic;
  if (action === "withdraw") return topic.inForce === null ? "Only a proposal under review can be withdrawn here." : null;
  if (displayName.trim() === "") return "Set a display name before recording your answer.";
  if (action === "reject") return reason?.trim() ? null : "Give a short reason for rejecting this answer.";
  const answerFailure = decisionDocAnswerFailure(input.source.ydoc);
  if (answerFailure !== null) return answerMessages[answerFailure];
  const decidedTopic = resolveDecisionTopics(topic.allRecords.map((record) => record.uuid === input.uuid
    ? { ...record, status: "decided" } : record)).find((entry) => entry.topic === topic.topic);
  // known limit: concurrent decisions on different proposals can create a conflict; revisit when hub admission can serialize settlement for a topic
  if (decidedTopic?.inForce?.uuid === input.uuid) return null;
  return decidedTopic?.conflicts.length ? "This proposal was made against an answer that has since been replaced. Deciding it would create a conflict."
    : "Deciding this record would leave a newer answer in force. Open the current answer to propose a change.";
}

export function settleDecision(input: SettlementInput): { ok: true } | { ok: false; message: string } {
  const failure = settlementFailure(input, input.action, input.displayName, input.reason);
  if (failure !== null) return { ok: false, message: failure };
  // known limit: concurrent settlement of one record can merge fields from both writes; revisit when hub admission can serialize settlement for a topic
  input.source.ydoc.transact(() => {
    setStatus(input.source.ydoc, input.action === "decide" ? "decided" : input.action === "reject" ? "rejected" : "withdrawn");
    if (input.action === "withdraw") return;
    const meta = getMetaMap(input.source.ydoc);
    meta.set("decidedBy", input.displayName.trim());
    meta.set("decidedAt", new Date(Date.now()).toISOString());
    meta.set("decidedWhere", "Uberblick web: Settle decision");
    meta.set("agentStance", false);
    meta.set("approvalFingerprint", decisionApprovalFingerprint(input.source.ydoc));
    if (input.action === "reject") meta.set("rejectionReason", input.reason?.trim());
  });
  return { ok: true };
}

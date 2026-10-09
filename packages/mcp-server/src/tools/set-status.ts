import { InvalidDocumentLifecycleError, REQUIREMENT_STATUSES, decisionRelations, getMeta, getMetaMap, isDocumentStatusForKind, setKind, setStatus } from "@uberblick/schema";
import type { DocumentKind, DocumentStatus } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { decisionAnswerArg, documentStatusArg, uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";
import { roomStages } from "./helpers.js";

function kindForStatus(status: DocumentStatus): DocumentKind {
  return REQUIREMENT_STATUSES.some((candidate) => candidate === status)
    ? "requirement"
    : "decision";
}

export const inputSchema = strictInput({
  uuid: uuidArg, status: documentStatusArg,
  answer: decisionAnswerArg.optional(),
  reason: z.string().trim().optional().describe("Non-empty reason required when rejecting a proposal."),
});

export const setStatusOperation = documentOperation("set_status", inputSchema, (context, { uuid, status, answer, reason }, _request, replica) => {
  const { replicas, recordAnswer, decisionAuthorityJson } = context;

  const stored = getMeta(replica.doc);
  const kind = stored.kind ?? kindForStatus(status);

  // Validate every authority/lifecycle door before adopting a kind or writing metadata.
  if (!isDocumentStatusForKind(kind, status)) {
    throw new InvalidDocumentLifecycleError(kind, status);
  }
  if (kind !== "decision" && (answer !== undefined || reason !== undefined)) {
    throw new ToolError("decision_transition_invalid", "Only decisions accept a recorded answer or rejection reason.", { uuid, kind, status });
  }
  if (kind === "decision") {
    const invalid = (message: string): never => {
      throw new ToolError("decision_transition_invalid", message, { uuid, kind, status, currentStatus: stored.status ?? null });
    };
    if (stored.status === "rejected" || stored.status === "withdrawn") invalid("Rejected and withdrawn records are final.");
    if (stored.status === "decided" && (status === "open" || status === "withdrawn")) invalid("A decided record cannot reopen or withdraw; create a successor.");
    if (answer !== undefined && status !== "decided" && status !== "rejected") invalid("An answer approves or rejects a proposal; open and withdrawn do not record answers.");
    if (reason !== undefined && status !== "rejected") invalid("A rejection reason is accepted only when rejecting a proposal.");
    if (status === "withdrawn" && stored.status !== "open") invalid("Only an existing open proposal can be withdrawn.");
    if (status === "rejected") {
      const topic = decisionRelations(replicas.directory().doc, uuid).resolution;
      const conflict = topic?.conflicts.some(record => record.uuid === uuid) ?? false;
      if (stored.status !== "open" && !(stored.status === "decided" && (stored.agentStance === true || conflict))) {
        invalid("Only an open proposal, an agent stance or a decided record in conflict can be rejected.");
      }
      if (reason === undefined || reason.trim() === "") {
        throw new ToolError("decision_reason_required", "Rejecting a proposal requires a non-empty reason.", { uuid, kind, status });
      }
      if (answer === undefined) {
        throw new ToolError("decision_answer_required", "Rejecting a proposal requires recording a person's answer (who, when, where).", { uuid, kind, status });
      }
    }
    if (status === "decided" && stored.status !== "decided" && answer === undefined) {
      const first = stored.supersedes === undefined && (stored.topic ?? uuid) === uuid;
      const answered = stored.decidedBy !== undefined || stored.decidedAt !== undefined || stored.decidedWhere !== undefined || stored.approvalFingerprint !== undefined;
      if (!first || answered) {
        throw new ToolError("decision_answer_required", "Deciding this record requires recording a person's answer (who, when, where).", { uuid, kind, status });
      }
    }
  }

  const directory = replicas.directory();
  const { stage } = roomStages(
    replicas,
    "set_status",
    uuid,
    room => room === replica.room ? "document" : room === directory.room ? "directory" : "other",
    (_purpose, failedAt) => failedAt === "directory"
      ? "Restart the MCP server. The document lifecycle is already durable; the next settle repairs the " +
        "directory stub from it, so do not repeat set_status before re-reading."
      : failedAt === "document"
        ? "Restart the MCP server, then re-read the document before calling set_status again. " +
          "The lifecycle update did not reach the document's update log."
        : "Restart the MCP server, then re-read the document with get_doc and its directory stub with list_docs " +
          "before calling set_status again: another room's write failed while this call ran.",
    { kind, status },
  );
  stage("document", replica, () => {
    replica.doc.transact(() => {
      if (stored.kind === undefined) {
        // Adoption is unconditional on the tolerant read. Clear any hidden,
        // incompatible raw pair before writing the derived legal pair; the
        // outer transaction keeps the replacement in one logged update.
        setKind(replica.doc, "");
        setKind(replica.doc, kind);
      }
      setStatus(replica.doc, status);
      if (kind === "decision") {
        if (answer !== undefined) recordAnswer(replica, answer);
        else if (status === "decided" && stored.status !== "decided") getMetaMap(replica.doc).set("agentStance", true);
        if (status === "rejected") getMetaMap(replica.doc).set("rejectionReason", reason);
      }
    });
  });

  return { uuid, kind, status, ...decisionAuthorityJson(replica), };
});

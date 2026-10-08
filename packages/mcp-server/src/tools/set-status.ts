import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InvalidDocumentLifecycleError,
  REQUIREMENT_STATUSES,
  decisionRelations,
  getMeta,
  getMetaMap,
  isDocumentStatusForKind,
  setKind,
  setStatus,
} from "@uberblick/schema";
import type { DocumentKind, DocumentStatus } from "@uberblick/schema";
import { z } from "zod";
import { ToolError, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DECISION_AUTHORITY,
  LIFECYCLE_RECORDS_STATE,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { decisionAnswerArg, documentStatusArg, uuidArg } from "./schemas.js";

function kindForStatus(status: DocumentStatus): DocumentKind {
  return REQUIREMENT_STATUSES.some((candidate) => candidate === status)
    ? "requirement"
    : "decision";
}

export function registerSetStatus(server: McpServer, context: ToolContext): void {
  const {
    toolContract,
    replicas,
    briefing,
    requireWritableDoc,
    recordAnswer,
    decisionAuthorityJson,
    durability,
  } = context;

  server.registerTool(
    "set_status",
    {
      title: "Set a document's lifecycle status",
      description:
        "Record a document's lifecycle status. On an ordinary document this also adopts the kind that owns the " +
        "status; the result names both, so adoption is never silent. A document that already has a kind accepts " +
        "only that kind's statuses. Its kind is fixed through MCP: if it was adopted in error, retrying with the " +
        "other kind's status cannot change it. An open record can be withdrawn without an answer; decided records " +
        "cannot reopen or withdraw. Rejected and withdrawn are final. Rejection requires a non-empty `reason` " +
        "and a recorded person's answer, and applies only to an open proposal, an agent stance or a decided " +
        "record in a conflict. It stores `rejectionReason`. All refusals change nothing.\n\n" +
        DECISION_AUTHORITY +
        "\n\n" +
        LIFECYCLE_RECORDS_STATE +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_status"),
      inputSchema: strictInput({
        uuid: uuidArg, status: documentStatusArg,
        answer: decisionAnswerArg.optional(),
        reason: z.string().trim().optional().describe("Non-empty reason required when rejecting a proposal."),
      }),
    },
    guarded("set_status", async ({ uuid, status, answer, reason }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
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

      const failure = replicas.persistenceError();
      if (failure !== null && failure.room === replicas.directory().room) {
        throw new ToolError(
          "persistence_failed",
          `The lifecycle update is durable in ${replica.room}, but its directory stub could not be updated: ${failure.message}`,
          {
            uuid,
            kind,
            status,
            applied: false,
            partial: true,
            synced: false,
            rolledBack: false,
            completed: [
              { purpose: "document", room: replica.room, applied: true },
            ],
            failed: { purpose: "directory", room: failure.room },
            room: failure.room,
            recoveryClass: "manual",
            recovery:
              "Restart the MCP server. The document lifecycle is already durable; the next settle repairs the " +
              "directory stub from it, so do not repeat set_status before re-reading.",
          },
        );
      }

      return json({ uuid, kind, status, ...decisionAuthorityJson(replica), ...durability(replica) });
    }),
  );
}

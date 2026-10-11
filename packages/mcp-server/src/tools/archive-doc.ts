import { archiveDocument } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { roomStages } from "./helpers.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

const ARCHIVE_RECOVERY: Record<string, string> & { other: string } = {
  directory:
    "Nothing survived: the refused write is the tombstone itself, so the document is still listed and its pin " +
    "state is unchanged. Restart the MCP server — the failure is sticky and every tool refuses until then — " +
    "then call archive_doc again.",
  sidebar:
    "The tombstone is durable, so the document is archived; only the unpin is missing, so any pin it has is " +
    "still there and get_sidebar reports such a pin with `status: \"archived\"`. Restart the MCP server, then " +
    "call unpin_doc with this uuid to finish it. Do NOT call archive_doc again — it is already archived.",
  other:
    "The log refused a write to a room this call does not own — another document syncing while it ran. Restart " +
    "the MCP server, then check with list_docs — `include_deleted: true` — and get_sidebar what the rooms in " +
    "`completed` left behind.",
};

export const inputSchema = strictInput({ uuid: uuidArg });

/**
 * Write only directory and sidebar rooms. Replicas reconciles the index from
 * directory updates on every observing replica; do not mutate the index here.
 */
export const archiveDocOperation = operation("archive_doc", inputSchema, (context, { uuid }, _request) => {
  const { replicas, requireStub, titleFor, durabilityAcross } = context;

  const stub = requireStub(uuid);
  const directory = replicas.directory();
  const sidebarReplica = replicas.sidebar();
  const title = titleFor(uuid, stub);
  const { completed, stage } = roomStages(
    replicas,
    "archive_doc",
    uuid,
    (room) =>
      room === directory.room
        ? "directory"
        : room === sidebarReplica.room
          ? "sidebar"
          : "other",
    (_purpose, failedAt) => ARCHIVE_RECOVERY[failedAt] ?? ARCHIVE_RECOVERY.other,
  );

  const affected = archiveDocument(directory.doc, sidebarReplica.doc, uuid, (purpose, write) => {
    stage(purpose, purpose === "directory" ? directory : sidebarReplica, write);
  });
  return {
    uuid,
    title,
    records: affected,
    archived: true,
    // This reports the local unpin, including absence; unseen pins may surface later.
    unpinned: true,
    // Withdrawal needs no hydration; refused index writes remain queued for retry.
    indexed: affected.every(recordUuid => replicas.indexReconciled(recordUuid)),
    ...durabilityAcross(directory, completed),
  };
});

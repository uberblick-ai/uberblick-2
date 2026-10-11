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
 * Archiving and restoring never write the *document*.
 *
 * Restore writes the directory alone, and reports durability for that room,
 * because that is the room whose update has to reach the hub. Archive writes
 * the sidebar too: a document that has left every other listing is not an
 * entry point, so archiving unpins it and reports both rooms. Restore does
 * not put the pin back — pinning again is a separate, deliberate act.
 *
 * Neither touches the derived index itself: `Replicas` reconciles it from the
 * directory update, which means the index follows an archive on every replica
 * that observes it, not only on the one that called the tool.
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
    // What the call asserts, not what it found: this replica hid every pin
    // it could see, whether or not it was holding one, so there is no
    // "there was no pin to remove" case left to report and this is true
    // whenever the archive completed. It is not a claim about a pin that
    // has not arrived here: that one can still surface afterwards, which
    // is why the description sends the caller to get_sidebar for it.
    unpinned: true,
    // Withdrawing a document needs no copy of it, so hydration cannot make
    // this false — but a store that refused the write can, and then the
    // uuid stays queued for a later retry rather than being reported done.
    indexed: affected.every(recordUuid => replicas.indexReconciled(recordUuid)),
    ...durabilityAcross(directory, completed),
  };
});

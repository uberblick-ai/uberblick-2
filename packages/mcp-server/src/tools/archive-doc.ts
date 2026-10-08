import { resolveDecisionTopics, tombstoneDirectoryEntry, unpinDocIncludingUnseen } from "@uberblick/schema";
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

export const archiveDocOperation = operation("archive_doc", inputSchema, (context, { uuid }, _request) => {
  const { replicas, requireStub, titleFor, durabilityAcross } = context;

  const stub = requireStub(uuid);
  const directory = replicas.directory();
  const sidebarReplica = replicas.sidebar();
  const title = titleFor(uuid, stub);
  const affected = resolveDecisionTopics(directory.doc).find(topic => topic.records.some(record => record.uuid === uuid))?.records.map(record => record.uuid) ?? [uuid];
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

  // The directory first, so a refused append leaves the document listed and
  // pinned rather than unpinned and still listed: an archive nobody can see
  // is worse than a pin the reader can still remove. The unpin follows only
  // once the tombstone is durable.
  stage("directory", directory, () => {
    tombstoneDirectoryEntry(directory.doc, uuid);
  });
  // Unconditionally, and without asking this replica whether it holds a
  // pin: `settle()` is not a promise that the sidebar arrived, so a pin
  // made elsewhere can still be in flight, and skipping the write would let
  // it merge in behind the tombstone and leave the document archived *and*
  // pinned for good. Raising the unpin count past everything this replica
  // can see hides such a pin when it lands, as long as it was stamped at or
  // below that ceiling; one stamped above it — made under an unpin this
  // replica has not received either — still surfaces, which is #969's
  // window and what the description tells the caller to expect. A
  // deliberate `pin_doc` after the archive wins in every case. The sidebar
  // is therefore always a room this call wrote, and `rooms` always names
  // it.
  stage("sidebar", sidebarReplica, () => {
    sidebarReplica.doc.transact(() => {
      for (const recordUuid of affected) unpinDocIncludingUnseen(sidebarReplica.doc, recordUuid);
    });
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveDecisionTopics,
  tombstoneDirectoryEntry,
  unpinDocIncludingUnseen,
} from "@uberblick/schema";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVE_IS_LAST_WRITE_WINS,
  DECISION_TOPIC_LIFECYCLE,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json, roomStages } from "./helpers.js";
import { uuidArg } from "./schemas.js";

/** What to do after a partial archive, by the room whose write the log refused. */
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

export function registerArchiveDoc(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireStub, titleFor, durabilityAcross } = context;

  /**
   * Archiving and restoring never write the *document*.
   *
   * Restore writes the directory alone, and reports durability for that room,
   * because that is the room whose update has to reach the hub. Archive writes
   * the sidebar too (#957): a document that has left every other listing is not
   * an entry point, so archiving unpins it and reports both rooms. Restore does
   * not put the pin back — pinning again is a separate, deliberate act.
   *
   * Neither touches the derived index itself: `Replicas` reconciles it from the
   * directory update, which means the index follows an archive on every replica
   * that observes it, not only on the one that called the tool.
   */
  server.registerTool(
    "archive_doc",
    {
      title: "Archive a document",
      description:
        "Hide a document: tombstones its directory stub, so it leaves list_docs and the search index. " +
        "This is not erasure and not a delete. Every block, mark and annotation stays exactly where it was: get_doc still " +
        "serves the document by uuid, and list_docs with `include_deleted: true` still lists it, flagged `deleted`; " +
        "for a decision, add a matching `kind`, `status` or `tag` predicate. " +
        "There is no tool that erases content, by design.\n\n" +
        "It also leaves the sidebar, because it is unpinned: a document that has left every other listing is not an " +
        "entry point. The unpin is unconditional — it does not first look for a pin, and it hides every pin this " +
        "replica can see — so `unpinned` says what the call asserted, not that a pin was found: it is true whenever " +
        "the archive completed. It is not a cross-replica lock over pinning, any more than the tombstone is over " +
        "writing: a pin made elsewhere that this replica has not received can still merge in behind the archive and " +
        "leave the document archived AND pinned. get_sidebar is where you see that — such a pin lists with " +
        "`status: \"archived\"` — and unpin_doc is what removes it. restore_doc does NOT put a pin back — pin_doc " +
        "is how a restored document becomes an entry point again, and it still wins over this unpin.\n\n" +
        "So this call always writes two independently persisted rooms — the directory and the sidebar — " +
        "and reports them one by one. `rooms` lists every room it touched with its own `applied` and " +
        "`synced`; the top-level `synced` is the AND over them and is never true while one is still pending. It is " +
        "NOT transactional: there is no rollback and no remote atomicity. If the local update log refuses the unpin, " +
        "the call fails with `persistence_failed` carrying the `uuid`, the rooms already `completed`, the `failed` " +
        "room, `rolledBack: false` and a recovery line — never as a completed archive.\n\n" +
        DECISION_TOPIC_LIFECYCLE +
        "\n\n" +
        "What the tombstone does cost is writing: while it stands the document is read-only, and every mutating tool " +
        "refuses it with `doc_archived`. restore_doc is the way back, and the only mutation an archived document " +
        "accepts.\n\n" +
        "`indexed` says this replica's search index has dropped the document. Dropping it needs only its uuid, so " +
        "unlike restore_doc this does not depend on holding the document — it is false only if the index write itself " +
        "failed, and then the document stays queued and a later call retries it. The archive itself is unaffected " +
        "either way: `applied` is the durable half.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("archive_doc"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("archive_doc", async ({ uuid }) => {
      await replicas.settle();
      briefing.require();
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
      return json({
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
      });
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restoreDirectoryEntry } from "@uberblick/schema";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVE_IS_LAST_WRITE_WINS,
  DECISION_TOPIC_LIFECYCLE,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json, roomStages } from "./helpers.js";
import { uuidArg } from "./schemas.js";

export function registerRestoreDoc(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireStub, titleFor, durabilityAcross } = context;

  server.registerTool(
    "restore_doc",
    {
      title: "Restore an archived document",
      description:
        "Lift a document's archive tombstone: it returns to the default list_docs listing unless it is a decision, " +
        "returns to matching filtered listings either way, and returns to the search index, with the " +
        "title and tags the directory recorded for it. It does NOT return to the sidebar: archive_doc unpinned it, " +
        "and putting an entry point back is pin_doc's deliberate act, not a side effect of restoring. " +
        "The counterpart to archive_doc, and the sanctioned way " +
        "back — a rename or a retag from a replica that has seen the archive deliberately cannot revive a document. " +
        "Restoring one that is not archived leaves its archive state alone, but is not quite a no-op: the directory " +
        "entry is a cache of the document's own metadata, and this trues it up, so a stub that had drifted is " +
        "repaired in passing.\n\n" +
        DECISION_TOPIC_LIFECYCLE +
        "\n\n" +
        "Check `indexed`. It is true when this replica holds the document itself and has just re-derived its search " +
        "rows — the usual case. It is false in two: when this replica knows the document only from the directory, and " +
        "when the index write was refused. Either way the restore is real, replicates, and shows immediately in the " +
        "list_docs collection that includes its kind, but SEARCH ON THIS REPLICA will not find the document yet — it " +
        "catches up when the content " +
        "arrives or on a later call, whichever was missing. Offline, content arriving means the hub coming back.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("restore_doc"),
      outputSchema: outputSchemas.restore_doc,
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("restore_doc", async ({ uuid }) => {
      await replicas.settle();
      briefing.require();
      const stub = requireStub(uuid);
      const directory = replicas.directory();
      let affected: string[] = [];
      const { completed, stage } = roomStages(
        replicas, "restore_doc", uuid,
        room => room === directory.room ? "directory" : "other",
        () => "Restart the MCP server, then restore_doc with this UUID again. Read include_deleted listings to verify the topic's visibility.",
      );
      stage("directory", directory, () => {
        directory.doc.transact(() => {
          affected = restoreDirectoryEntry(directory.doc, uuid);
          for (const recordUuid of affected) replicas.republishStub(recordUuid);
        });
      });
      // A rename or a retag that landed while the document was archived never
      // reached its stub for an ordinary document, because repair skips those
      // tombstones. Decision stub fields keep healing while archived. Catch
      // the directory up here, or the document comes back under the metadata it
      // was archived with while search answers from the newer.
      //
      // Hydration is what makes re-indexing possible; it is not proof that it
      // happened. Both have to hold, and the store gets the last word — read
      // after the republish, whose own directory write reconciles again.
      return json({
        uuid,
        title: titleFor(uuid, stub),
        records: affected,
        archived: false,
        indexed: affected.every(recordUuid => replicas.hydrated(recordUuid) && replicas.indexReconciled(recordUuid)),
        ...durabilityAcross(directory, completed),
      });
    }),
  );
}

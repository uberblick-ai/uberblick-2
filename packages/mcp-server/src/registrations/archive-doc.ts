import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVE_IS_LAST_WRITE_WINS, DECISION_TOPIC_LIFECYCLE, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, archiveDocOperation } from "../tools/archive-doc.js";

export function registerArchiveDoc(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("archive_doc", {
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
    outputSchema: outputSchemas.archive_doc,
    inputSchema,
  }, guarded("archive_doc", context, archiveDocOperation));
}

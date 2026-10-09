import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, archiveDocOperation } from "../tools/archive-doc.js";

export function registerArchiveDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("archive_doc", {
    title: "Archive a document",
    description:
      "Archive a document or every record in a decision topic: tombstone directory entries, drop local search " +
      "rows and unconditionally unpin without erasing content. Reads by UUID remain available. unpinned reports " +
      "the asserted unpin, not whether a pin was found. An unseen concurrent pin can survive with archived " +
      "status; use get_sidebar then unpin_doc to remove it. This writes directory and sidebar rooms " +
      "independently, without rollback or remote atomicity. The answer reports rooms; partial " +
      "persistence_failed carries uuid, completed/failed rooms, rolledBack: false and recovery. Follow recovery " +
      "to finish. indexed is false only on index-write failure; the archive remains applied and a later call " +
      "retries indexing. Restoration uses restore_doc; pin_doc deliberately places the restored document back " +
      "in navigation." +
      helpPointer("archive_doc"),
    outputSchema: outputSchemas.archive_doc,
    inputSchema,
  }, guarded("archive_doc", context, archiveDocOperation));
}

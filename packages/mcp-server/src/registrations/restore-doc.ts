import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, restoreDocOperation } from "../tools/restore-doc.js";

export function registerRestoreDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("restore_doc", {
    title: "Restore an archived document",
    description:
      "Restore a document or decision topic's directory visibility and search indexing, using its recorded " +
      "title and tags. It never restores a sidebar pin; use pin_doc for placement. On an already live document " +
      "it can repair a drifted directory stub. Check indexed: false means this replica lacks the content or its " +
      "index write failed. The restore still applies and replicates; search catches up when content arrives or " +
      "a later call retries. Offline content arrival requires hub recovery." +
      helpPointer("restore_doc"),
    outputSchema: outputSchemas.restore_doc,
    inputSchema,
  }, guarded("restore_doc", context, restoreDocOperation));
}

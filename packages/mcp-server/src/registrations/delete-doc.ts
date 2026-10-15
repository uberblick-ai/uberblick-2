import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, deleteDocOperation } from "../tools/delete-doc.js";

export function registerDeleteDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("delete_doc", {
    title: "Permanently delete an archived document",
    description: "Permanently delete an archived regular document, including content, comments, data and history. " +
      "Only its UUID and permanent deletion mark remain. Replicas remove their copies when they learn the mark; " +
      "the hub refuses later room updates. This cannot be undone, including by an offline restore. " +
      "Live documents refuse with doc_not_archived; deleted UUIDs refuse with doc_deleted; decision records refuse. " +
      "Links stored in other documents stay unchanged. Directory and sidebar writes report independent durability." +
      helpPointer("delete_doc"),
    outputSchema: outputSchemas.delete_doc,
    inputSchema,
  }, guarded("delete_doc", context, deleteDocOperation));
}

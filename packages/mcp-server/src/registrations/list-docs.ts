import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, listDocsOperation } from "../tools/list-docs.js";

export function registerListDocs(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("list_docs", {
    title: "List documents",
    description:
      "List workspace documents from directory stubs without opening document rooms. The unfiltered listing " +
      "omits decisions; a kind, status or tag predicate includes its exact matches. kind: decision returns one " +
      "row per topic: the record in force, else pending, else first, plus pending/conflicting records. Status " +
      "and tag may match different live records of a topic; resolution still uses its whole graph. " +
      "include_superseded returns records with per-record predicates. include_deleted admits archived topics " +
      "but is not a predicate, so archived decisions also require a matching predicate. Filters combine; " +
      "unknown catalog tags refuse. Rows carry cached description, canonical tag identities, lifecycle and " +
      "authority metadata, sidebar-derived pinned and approximate optional epoch timestamps. A fresh replica " +
      "can discover the corpus once its directory room has synced." +
      helpPointer("list_docs"),
    outputSchema: outputSchemas.list_docs,
    inputSchema,
  }, guarded("list_docs", context, listDocsOperation));
}

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
      "List synced directory stubs without opening document rooms. Unfiltered listing omits decisions; " +
      "kind, status, tag or has_open_threads predicates include matching decisions. Topic rows present the " +
      "record in force, else pending, else first, plus pending/conflicting records. Predicates may match " +
      "different live records; resolution uses the whole graph. include_superseded applies predicates per " +
      "record. include_deleted admits archived topics but is not a predicate. Filters combine; unknown tags " +
      "refuse. has_open_threads accepts only true: known openThreadCount >= 1; false refuses. Every entry, " +
      "including inForce, pending and conflicts, caches its document's openThreadCount: threads whose " +
      "resolved is not true, including deleted anchors; absent means unknown. A matching topic's " +
      "representative may have zero or unknown count. Use include_superseded: true with has_open_threads " +
      "to find each matching document, then get_doc for threads and annotate to reply or resolve. " +
      "Rows carry cached description, tags, lifecycle/authority metadata, sidebar-derived pinned and optional " +
      "approximate timestamps. Decision rows have no TL;DR; answerPreview is the first answer paragraph/list, null for none; " +
      "discussion is its explicit RFC UUID, null for none, distinct from curated links and recorded answer. " +
      "Both are absent when unknown. get_doc marks related or linked topics." +
      helpPointer("list_docs"),
    outputSchema: outputSchemas.list_docs,
    inputSchema,
  }, guarded("list_docs", context, listDocsOperation));
}

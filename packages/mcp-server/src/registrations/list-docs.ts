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
      "List synced directory stubs without opening rooms. Unfiltered omits decisions; " +
      "kind/status/tag/has_open_threads predicates include them. Topics present in-force, else pending, else " +
      "first record, plus pending/conflicts. Predicates may match different live records; resolution uses " +
      "the whole graph. include_superseded applies predicates per record. include_deleted admits archived, " +
      "never permanently deleted UUIDs; it is no predicate. Filters combine; unknown tags refuse. " +
      "has_open_threads accepts only true (known openThreadCount >= 1); false refuses. Every entry, including " +
      "inForce/pending/conflicts, caches openThreadCount: threads not resolved, including deleted anchors; " +
      "absent means unknown. A representative may have zero/unknown count. Use include_superseded with " +
      "has_open_threads for every matching document, get_doc for threads, annotate to reply/resolve. Regular " +
      "code_check cache: latest repository/commit/checked_at/result per repository, [] if never checked, absent " +
      "if uncached. Results: matches (agrees), ahead (intentionally undelivered), drift (unintended " +
      "disagreement); content edits preserve checks. Decisions omit code_check/TL;DR; answerPreview: first " +
      "answer paragraph/list or null; discussion: RFC UUID/null, apart from curated links/recorded answer; " +
      "both absent if unknown. Rows cache description/tags/lifecycle/authority metadata, sidebar-derived " +
      "pinned, approximate timestamps. get_doc marks related/linked topics." +
      helpPointer("list_docs"),
    outputSchema: outputSchemas.list_docs,
    inputSchema,
  }, guarded("list_docs", context, listDocsOperation));
}

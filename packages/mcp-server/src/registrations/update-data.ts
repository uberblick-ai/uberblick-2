import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, updateDataOperation } from "../tools/update-data.js";

export function registerUpdateData(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("update_data", {
    title: "Update document data",
    description:
      "Apply one validated batch through applyDocData, naming each touched collection once. " +
      "Within each collection, set `schema`, optionally `replaceRecords`, then `deleteRecords`, then `upsert` " +
      "whole `{id, value}` records. `deleteCollection: true` excludes other changes. Schema and value JSON " +
      "reach validation unaltered; unsupported schemas and invalid retained records refuse before mutation. " +
      "The batch is one local transaction; identical refreshes return `changed: false` without an update. " +
      "The result summarizes touched collection names, counts and deletion with durability, without values.\n\n" +
      "Refresh producer-owned collections by upsert or full-set replacement. Keep human " +
      "dispositions in a separate collection keyed by producer record ids. Split changes above the 1 MiB " +
      "schema/value budget across calls; they are not atomic together and supply no CAS or distributed lock. " +
      "Read with get_data; get_doc summarizes collections. " +
      "Decisions refuse data with decision_data_unsupported; decided records " +
      "keep decision_read_only, and legacy data stays readable. Decision answer guidance is in lifecycle's " +
      "Decision answers and topics section. Their " +
      "directory answerPreview uses legacy TL;DR or the first paragraph/list; get_doc page " +
      "decisions are marked related or linked. Recorded attribution {who, when, where} is separate from " +
      "the answer's content blocks." +
      helpPointer("update_data"),
    outputSchema: outputSchemas.update_data,
    inputSchema,
  }, guarded("update_data", context, updateDataOperation));
}

import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, getDataOperation } from "../tools/get-data.js";

export function registerGetData(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("get_data", {
    title: "Read document data",
    description:
      "Read a document's structured data without changing it, including merged invalidity and diagnostics. Omit " +
      "collection for an area summary with no schemas or values, or data: null when absent. Name a collection " +
      "for its raw schema and a detached page in Unicode code-point id order; an unknown collection refuses. " +
      "after is an exclusive cursor; ids optionally filters it and reports missing_ids. limit: 0 reads only the " +
      "schema. max_bytes bounds canonical JSON of the page's id/value array, excluding schemas, diagnostics and " +
      "formatting; a positive-limit page includes its first remaining record even over budget. It does not " +
      "bound the whole response or token count. Follow next_after until complete; schema-only reads do not " +
      "advance, and pages are not snapshots." +
      helpPointer("get_data"),
    outputSchema: outputSchemas.get_data,
    inputSchema,
  }, guarded("get_data", context, getDataOperation));
}

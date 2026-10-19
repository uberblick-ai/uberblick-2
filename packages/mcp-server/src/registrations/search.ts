import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, searchOperation } from "../tools/search.js";

export function registerSearch(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("search", {
    title: "Search documents",
    description:
      "Find live documents containing any query word in titles, descriptions, content or assigned tag names. " +
      "English word forms match; case and accents fold, underscore groups match adjacent words and a trailing * " +
      "matches prefixes. Punctuation or emoji alone matches nothing. Results use title-weighted bm25 relevance, " +
      "without a strict title-first or matched-word-count order. Optional kind narrows to regular documents or " +
      "decision records. Optional tag accepts one catalog id or current name (case ignored), or a list: any listed tag " +
      "matches and more listed tags boost relevance; unknown tags refuse. Every hit includes kind and canonical " +
      "tags; decision hits include current record state, including superseded and conflict. No hits does not " +
      "prove the index is empty or the replica complete." +
      helpPointer("search"),
    outputSchema: outputSchemas.search,
    inputSchema,
  }, guarded("search", context, searchOperation));
}

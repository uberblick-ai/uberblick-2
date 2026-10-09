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
      "Search document titles, descriptions and block text in this replica's derived FTS5 index. Every " +
      "searchable query term must occur in the same document. Punctuation or emoji alone matches nothing; " +
      "underscore groups match adjacent words, case and accents fold, and words are not stemmed. A trailing * " +
      "enables a prefix match. Hits include description and canonical tag assignments. Optional tag accepts a " +
      "catalog id or exact current name; an unknown value refuses. No hits means no indexed document matches " +
      "all terms, without proving the index is empty or the replica complete." +
      helpPointer("search"),
    outputSchema: outputSchemas.search,
    inputSchema,
  }, guarded("search", context, searchOperation));
}

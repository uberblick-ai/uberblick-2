import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, findDecisionsOperation } from "../tools/find-decisions.js";

export function registerFindDecisions(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("find_decisions", {
    title: "Find decisions linking a GitHub item",
    description:
      "Find live decision records whose prose links one GitHub issue or PR, using this replica's derived index " +
      "without opening document rooms or calling GitHub. Only external link hrefs in prose count; labels, " +
      "unlinked text and source blocks do not. Pass github_ref as owner/repo#n or an http(s) github.com " +
      "/issues/n or /pull/n URL. Equivalent case/path spellings and suffixes normalize to the same identity; " +
      "bare #n and other hosts refuse with invalid_github_reference. Returns every indexed live matching record " +
      "once, ordered by title under SQLite binary collation then UUID, without pagination or topic resolution. " +
      "Archived records are omitted. Results may lag unseen or unindexed content; an empty array does not prove " +
      "replica completeness." +
      helpPointer("find_decisions"),
    outputSchema: outputSchemas.find_decisions,
    inputSchema,
  }, guarded("find_decisions", context, findDecisionsOperation));
}

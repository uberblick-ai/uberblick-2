import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, listTagsOperation } from "../tools/list-tags.js";

export function registerListTags(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("list_tags", {
    title: "List assignable tags",
    description:
      "The existing workspace tag catalog, in deterministic name order. Each entry carries the stable canonical " +
      "`id` documents store, its display `name` and its optional one-line `description`. " +
      "MCP cannot create, describe or delete catalog tags.\n\n" +
      "`complete` says whether the initial catalog synchronization has completed. It is false while a configured hub has " +
      "not delivered the catalog room to this replica: what is listed is then a local copy that may be missing " +
      "curated entries, and a tag value this replica has never seen is refused rather than assigned. `hub` says " +
      "where that connection stands." +
      helpPointer("list_tags"),
    outputSchema: outputSchemas.list_tags,
    inputSchema,
  }, guarded("list_tags", context, listTagsOperation));
}

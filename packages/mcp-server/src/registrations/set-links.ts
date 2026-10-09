import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setLinksOperation } from "../tools/set-links.js";

export function registerSetLinks(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_links", {
    title: "Set a document's outbound links",
    description:
      "Replace the document's curated outbound link set. Values are target document UUIDs — never paths, never " +
      "titles. The backlinks index follows immediately.\n\n" +
      "Passing get_doc's effective links back stores derived governs and supersedes UUIDs in the curated array " +
      "too; get_doc deduplicates the resulting edges." +
      helpPointer("set_links"),
    outputSchema: outputSchemas.set_links,
    inputSchema,
  }, guarded("set_links", context, setLinksOperation));
}

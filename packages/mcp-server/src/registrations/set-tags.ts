import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setTagsOperation } from "../tools/set-tags.js";

export function registerSetTags(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_tags", {
    title: "Set a document's tags",
    description:
      "Replace the document's complete tag assignment set with catalog ids or exact active names. Names resolve " +
      "to canonical ids before storage. An existing retired or unresolved assignment may be preserved by " +
      "passing the id returned by get_doc; it may be removed, but cannot be newly added. Any unknown or newly " +
      "assigned retired value refuses the whole mutation before the document, directory stub or index changes " +
      "and names every invalid value; call list_tags for the active vocabulary. This is the tool the `tagHint` " +
      "on an untagged write points at." +
      helpPointer("set_tags"),
    outputSchema: outputSchemas.set_tags,
    inputSchema,
  }, guarded("set_tags", context, setTagsOperation));
}

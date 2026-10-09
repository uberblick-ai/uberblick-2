import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setMetadataOperation } from "../tools/set-metadata.js";

export function registerSetMetadata(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_metadata", {
    title: "Set document metadata together",
    description:
      "Set any non-empty subset of `title`, `description`, `tldr`, `tags` and curated `links` in one call; " +
      "omitted fields keep their values. All named fields are validated before any write, so a refusal " +
      "changes nothing and a field-specific failure names `field`. The answer returns all five fields as " +
      "get_doc would read them, with write durability and no TL;DR review reminder.\n\n" +
      "Title and description must be nonempty and cannot be cleared; `tldr: null` clears the person-facing " +
      "summary. Tags and links each replace their complete curated set, and `[]` clears one. Tag selectors " +
      "are active catalog ids or exact names from list_tags; already assigned retired or unresolved ids " +
      "can be preserved. Newly added link UUIDs must be known to this replica's directory; archived targets " +
      "are accepted, and existing curated targets may be passed back unchanged.\n\n" +
      "A decided record refuses any call naming title or tldr, while description, tags and links remain " +
      "writable. Archived documents refuse every metadata field; status changes use set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

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
      "Set a non-empty subset of `title`, `description`, `tldr`, `tags` and curated `links`; omitted fields " +
      "keep their values. All named fields validate before writes; refusals change nothing and field failures " +
      "name `field`. The answer returns all five fields with durability and no TL;DR review reminder.\n\n" +
      "Title and description must be nonempty and cannot be cleared; `tldr: null` clears the person-facing " +
      "summary. Tags and links replace complete curated sets; `[]` clears one. list_tags supplies active ids " +
      "or exact names; assigned retired or unresolved ids can be preserved. New link UUIDs must be known " +
      "to this replica's directory; archived targets and unchanged existing targets are accepted.\n\n" +
      "An open decision refuses non-null tldr with decision_tldr_unsupported; null clears a legacy TL;DR. " +
      "A decided record refuses any call naming title or tldr, while description, tags and links remain " +
      "writable. Decisions hold one to three short answer blocks with a brief reason; guidance belongs on " +
      "the related regular page and discussion in an RFC. Their derived directory answerPreview uses legacy " +
      "TL;DR or the first paragraph/list. Page get_doc reads mark topics related or linked; answer blocks " +
      "differ from recorded answer attribution {who, when, where}. Archived documents refuse every metadata " +
      "field; status changes use set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

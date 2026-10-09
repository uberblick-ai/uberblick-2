import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DESCRIPTION_IS_FOR_CHOOSING, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, setDescriptionOperation } from "../tools/set-description.js";

export function registerSetDescription(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("set_description", {
    title: "Set a document's description",
    description:
      "Replace the document's description wholesale. A description is rewritten rather than patched, so there is " +
      "nothing to splice here and no `old_text` to assert. The directory stub follows immediately, the way it " +
      "does for a rename, so the next list_docs, search and backlinks answer with it.\n\n" +
      DESCRIPTION_IS_FOR_CHOOSING +
      "\n\n" +
      "This is the tool the `descriptionHint` on a write points at: a document created in the web UI has no " +
      "description, and an agent that has just worked inside one is the party who can write it.\n\n" +
      "There is no way to clear a description from here: the empty string, and a string of nothing but " +
      "whitespace, are both refused. Removing one is a schema-level operation, not a tool — a document that " +
      "advertises nothing is a gap to fill rather than a state to ask for. Replace a description you dislike " +
      "with a better one.\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("set_description"),
    outputSchema: outputSchemas.set_description,
    inputSchema,
  }, guarded("set_description", context, setDescriptionOperation));
}

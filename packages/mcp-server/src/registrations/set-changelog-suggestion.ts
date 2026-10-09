import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, setChangelogSuggestionOperation } from "../tools/set-changelog-suggestion.js";

export function registerSetChangelogSuggestion(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("set_changelog_suggestion", {
    title: "Set a document's changelog suggestion",
    description:
      "Record one sentence of draft release-note copy for the work this document describes — what a reader of a " +
      "changelog would want to know, in simple English about the user-visible outcome. Write it when delivered " +
      "work makes you update the document; nothing generates, publishes or asks for one, and nothing renders it " +
      "yet.\n\n" +
      "It is document metadata beside the description, not prose in the document: writing it leaves the title, " +
      "description, tags, links, kind and status exactly where they were, and get_doc answers with it as " +
      "`changelogSuggestion`.\n\n" +
      "Three states, and they are different answers. No `changelogSuggestion` at all means nobody has written " +
      "one. `null` means this work deliberately needs no user-facing entry — say it, so an internal-only change " +
      "does not read as unfinished. A non-empty string is the suggestion itself. The empty string — or any " +
      "string that is only whitespace, since the argument is trimmed first — is not a fourth state: it takes " +
      "the stored value back to the first one.\n\n" +
      "That clear is the one answer whose concurrency guarantee is weaker, and it is local: it takes back only " +
      "the value this replica has already seen, so a concurrent `null` or sentence from another writer outlives " +
      "it and the field converges on theirs. Writing `null` or a sentence competes normally — concurrent " +
      "writers converge on one of the two. If a clear must stick, read the document back with get_doc.\n\n" +
      "The directory stub does not cache it and the search index does not carry it, so list_docs and search " +
      "neither answer with it nor match on it.\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("set_changelog_suggestion"),
    outputSchema: outputSchemas.set_changelog_suggestion,
    inputSchema,
  }, guarded("set_changelog_suggestion", context, setChangelogSuggestionOperation));
}

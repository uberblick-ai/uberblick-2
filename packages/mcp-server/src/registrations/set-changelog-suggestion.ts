import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setChangelogSuggestionOperation } from "../tools/set-changelog-suggestion.js";

export function registerSetChangelogSuggestion(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_changelog_suggestion", {
    title: "Set a document's changelog suggestion",
    description:
      "Set one sentence of draft release-note copy in document metadata; get_doc returns changelogSuggestion. " +
      "It does not publish or render anything. An absent field means unwritten, null deliberately needs no " +
      "user-facing entry, and a nonempty string is the suggestion. Input is trimmed; empty or whitespace-only " +
      "input clears the value. Clearing removes only locally observed values: a concurrent sentence or null can " +
      "survive, so re-read with get_doc if the clear must stick. Other document metadata and prose are " +
      "untouched; directory stubs and search do not carry the suggestion." +
      helpPointer("set_changelog_suggestion"),
    outputSchema: outputSchemas.set_changelog_suggestion,
    inputSchema,
  }, guarded("set_changelog_suggestion", context, setChangelogSuggestionOperation));
}

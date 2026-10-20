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
      "Set title/description/tldr/tags/links/code_check or decision discussion; require one. Omissions stay; " +
      "refusals write nothing and field failures name field. " +
      "Title/description cannot be cleared. tldr: null clears but preserves deliberate absence; replacing a marked TL;DR requires tldr_opt_in: true with non-null tldr. Tags/links " +
      "replace; [] clears. list_tags active ids/names (case ignored); assigned retired/unresolved ids stay. New " +
      "links: directory-known; archived/unchanged accepted. Regular-only code_check replaces one repository's entry " +
      "(case-insensitive); {repository, commit, result, rev, paths?}. rev must match get_doc's page rev; on refusal reread and compare before recording. paths are hints, not complete dependencies. Writer sets UTC checked_at. Content edits preserve checks; " +
      "decisions refuse. Only open decisions accept discussion: live, readable non-decision RFC UUID/null. " +
      "Reuse/create RFC first; RFC/page/approval untouched. " +
      "Separate from curated links/recorded answer; fixed after open. Decisions have no TL;DR; non-null refuses " +
      "decision_tldr_unsupported, open null accepted. Decided records refuse tldr/discussion. " +
      "Title on any live record renames its decision topic; successors inherit it. Title renames preserve approval. " +
      "answerPreview: first answer paragraph/list; get_doc marks related/linked. " +
      "See lifecycle's Decision answers and topics section. " +
      "Archived metadata refuses; lifecycle: set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

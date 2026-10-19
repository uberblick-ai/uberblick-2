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
      "refusals write nothing and field failures name field. Metadata/durability; no TL;DR hint/mark. " +
      "Title/description cannot be empty/cleared. tldr: null clears, preserving the mark; marked pages refuse " +
      "with tldr_opted_out unless tldr_opt_in: true accompanies non-null tldr. MCP cannot mark pages. Tags/links " +
      "replace; [] clears. list_tags active ids/names (case ignored); assigned retired/unresolved ids stay. New " +
      "links must be directory-known; archived/unchanged accepted. Regular-only code_check: {repository, commit, " +
      "result}; replaces that case-insensitive repository's entry, writer stamps UTC checked_at. Results: matches " +
      "(agrees), ahead (intentionally undelivered), drift (unintended disagreement). Content edits preserve checks; " +
      "decisions refuse. Only open decisions accept discussion: live, readable non-decision RFC UUID/null. " +
      "Reuse/create RFC first; no creation/RFC/page edits/tags or approvalFingerprint/approvalChanged change. " +
      "Distinct from curated links/recorded answer; fixed on settling. Decisions have no TL;DR; non-null refuses " +
      "decision_tldr_unsupported, open null accepted. Decided records refuse tldr/discussion. Title renames preserve " +
      "approval. See lifecycle's Decision answers and topics section; answerPreview: first answer paragraph/list; " +
      "get_doc marks related/linked. Archived metadata refuses; lifecycle: set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

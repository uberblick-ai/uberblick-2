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
      "Set title, description, tldr, tags, curated links or decision discussion; name at least one. " +
      "Omitted fields stay unchanged. Refusals write nothing; field failures name field. Returns metadata/durability, " +
      "no TL;DR hint/mark. Title/description cannot be empty/cleared. tldr: null clears while preserving the mark; " +
      "marked pages refuse a summary with tldr_opted_out unless tldr_opt_in: true accompanies non-null tldr. " +
      "MCP cannot mark pages. Tags/links replace sets; [] clears. Use list_tags active ids/exact names; assigned " +
      "retired/unresolved ids may remain. New links must be directory-known; archived/unchanged targets accepted. " +
      "Only open decisions accept discussion: a live, locally readable non-decision RFC UUID or null. Reuse/create " +
      "RFC first; no document creation, RFC/page edits or tags, or approvalFingerprint/approvalChanged changes. " +
      "Discussion is separate from curated links/recorded answer, fixed after settling. Decisions refuse non-null " +
      "tldr with decision_tldr_unsupported; open records accept null. Decisions have no TL;DR; metadata returns tldr: null. Decided records refuse tldr/discussion; " +
      "title/description/tags/links writable. Title renames preserve approval. See lifecycle's Decision answers and topics section. " +
      "Stub answerPreview uses the first answer paragraph/list; " +
      "get_doc marks related or linked topics. Recorded answer {who, when, where} is attribution. Archived " +
      "documents refuse metadata; lifecycle uses set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

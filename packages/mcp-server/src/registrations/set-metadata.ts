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
      "Set supplied metadata; omitted fields stay unchanged except confirmed-deleted tag references cleaned " +
      "by a permitted write. All validate before writes; refusals change nothing and field failures name field. " +
      "Return metadata with durability and no TL;DR reminder. Title/description cannot be empty or " +
      "cleared; tldr: null clears the person-facing summary. Tags replace existing assignments; [] clears them. " +
      "Use list_tags ids/exact names; references awaiting catalog sync stay stored. " +
      "Links replace the curated set; [] clears it. New link UUIDs must be " +
      "directory-known; archived or unchanged targets are accepted. Only an open decision accepts discussion: " +
      "a live, locally readable non-decision RFC UUID or null. Reuse/create the RFC first. Separate from curated " +
      "links and answer, it is fixed once settled. No RFC/page edits or tags, " +
      "document creation, or approvalFingerprint/approvalChanged change. Open decisions refuse non-null " +
      "tldr with decision_tldr_unsupported; null clears legacy TL;DR. Decided records refuse title/tldr/discussion; " +
      "description/tags/links stay writable. Decision answers use one to three short answer blocks with a brief " +
      "reason; guidance on the related page, discussion in an RFC. Stub answerPreview uses legacy TL;DR/first " +
      "paragraph/list; page get_doc marks related or linked topics. Answer blocks differ from recorded answer " +
      "{who, when, where}. Archived documents refuse all metadata; lifecycle uses set_status." +
      helpPointer("set_metadata"),
    outputSchema: outputSchemas.set_metadata,
    inputSchema,
  }, guarded("set_metadata", context, setMetadataOperation));
}

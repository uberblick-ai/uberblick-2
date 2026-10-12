import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, getDocOperation } from "../tools/get-doc.js";

export function registerGetDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("get_doc", {
    title: "Read a document",
    description:
      "Read metadata, blocks and annotation threads with lifecycle and decision context. Decisions hold one " +
      "to three short answer blocks; related pages hold guidance, RFCs discussion. Regular pages mark related " +
      "topics first, then topics linked by any record. Decision metadata returns discussion: RFC UUID or null; " +
      "entries cache it, null for none and absent if unknown. This derived link is separate from curated links " +
      "and recorded answer. An RFC marks its topic linked unless also related. Cached answerPreview: legacy " +
      "TL;DR, else first paragraph/list, at most 300 characters. Missing description and TL;DR are null. " +
      "Data summaries name collections and record counts; get_data reads schemas/values. Blocks include rev. " +
      "Tables use canonical GFM; cards return button: [Text](destination) lines after footer in authored order. " +
      "Nonempty plain labels; destinations are https or claude://code/new, claude-cli://open, codex://new, with " +
      "optional ?query. Style outline/filled and color neutral/blue/green/violet default to outline neutral; " +
      "output puts style before color and omits defaults. Card rev includes every button and formatting; table " +
      "rev includes formatting. Other " +
      "text is plain; rev ignores marks. Prose doc_links expose character ranges; table and card links " +
      "have no block-level ranges. Card annotation ranges name their part. Reading eligible guidance counts " +
      "toward this process's briefing. Edit with the returned text and rev." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

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
      "Read metadata, blocks and annotation threads with lifecycle and decision context. " +
      "Decisions hold one to three short answer blocks with a brief reason; related pages hold guidance, " +
      "RFCs discussion. Regular pages return live related topics first, then topics linked by any record, " +
      "with relations marked. Decision metadata returns discussion: connected RFC UUID or null; every " +
      "decision entry caches it, null for none and absent if unknown. Discussion is a derived effective link, " +
      "separate from curated links and recorded answer. The RFC returns its topic marked linked unless it is " +
      "also the related page; rename or archive preserves the reference. Cached answerPreview when known: " +
      "legacy TL;DR, else the first paragraph or list shortened to 300 characters. " +
      "Missing description and TL;DR return null. Structured data is summarized by collection names and record " +
      "counts; use get_data for schemas and values. Blocks include rev for edit assertions. Table text is " +
      "canonical GFM; card text is canonical container content. Both have formatting-sensitive rev; other " +
      "text is plain and rev ignores marks. Prose doc_links expose character ranges; table and card links " +
      "have no block-level ranges. Card annotation ranges name their part. Reading eligible guidance counts " +
      "toward this process's briefing, with best-effort bookkeeping that never fails the read. Read before " +
      "editing and use the returned text and rev." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

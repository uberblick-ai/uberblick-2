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
      "Read one document's metadata, blocks and annotation threads, including lifecycle and decision context. " +
      "Missing description and TL;DR return null. Structured data is summarized by collection names and record " +
      "counts; use get_data for schemas and values. Blocks include rev for edit assertions. Table text is " +
      "canonical GFM with formatting-sensitive rev; other text is plain and rev ignores marks. Prose doc_links " +
      "expose character ranges; table cell links have no block-level ranges. Reading eligible guidance counts " +
      "toward this process's briefing, with best-effort bookkeeping that never fails the read. Read before " +
      "editing and use the returned text and rev." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

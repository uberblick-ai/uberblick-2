import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, exportMarkdownOperation } from "../tools/export-markdown.js";

export function registerExportMarkdown(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("export_markdown", {
    title: "Export a document as markdown",
    description:
      "Render the document as markdown, including fenced code, mermaid, terminal and chart blocks. A chart " +
      "exports its JSON mapping in a chart fence, without record values. Tables export as GFM padded to their " +
      "widest row, with cell formatting as inline markdown and literal cell punctuation escaped. Structured " +
      "document data is omitted; documents holding data include an omission notice. Export only: markdown is " +
      "never the storage format, and there is no import tool." +
      helpPointer("export_markdown"),
    outputSchema: outputSchemas.export_markdown,
    inputSchema,
  }, guarded("export_markdown", context, exportMarkdownOperation));
}

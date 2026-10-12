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
      "Render a Markdown projection: code, mermaid, terminal and chart retain literal source fences; tables " +
      "write padded GFM with inline cell marks. Cards export separate :::card containers, optional button " +
      "after footer and inline-Markdown prose. Figma exports :::figma containers, separate from source fences, " +
      "with url, optional literal title and height in that order, a blank line and marked caption. It writes " +
      "the normalized HTTPS www.figma.com link: accepted design/file/proto/board/slides or community/file " +
      "path, key/id, optional name and only node-id, starting-point-node-id, version-id. Other query values " +
      "and fragments were dropped at save. Absent keys are omitted; title newlines fold to spaces and lines " +
      "starting ::: are escaped. Markdown import restores caption marks and separate adjacent containers; " +
      "invalid or unclosed containers remain literal paragraphs with delimiters. MCP writes refuse invalid " +
      "Figma content with invalid_figma; get_doc additionally derives kind/file/fileName/node. Read markdown " +
      "help for height 240–960, accepted links and refusals. Export contacts no Figma service. Chart/data " +
      "records are omitted with a notice; Markdown is never storage and MCP has no import tool." +
      helpPointer("export_markdown"),
    outputSchema: outputSchemas.export_markdown,
    inputSchema,
  }, guarded("export_markdown", context, exportMarkdownOperation));
}

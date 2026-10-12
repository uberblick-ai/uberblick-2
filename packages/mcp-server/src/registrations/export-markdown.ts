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
      "Render a Markdown projection: code, mermaid, terminal and chart keep source fences; tables write " +
      "padded GFM with inline cell marks. Cards export separate :::card containers with inline-Markdown " +
      "prose and button: [Text](destination) lines after footer in authored order. Each exported " +
      "button's plain label links to https or exact claude://code/new, claude-cli://open, codex://new, " +
      "optionally with ?query. Style outline/filled and color neutral/blue/green/violet default to " +
      "outline neutral; export writes style before color and omits defaults. Import restores buttons " +
      "and appearances. Figma exports separate :::figma containers: url, optional literal title and " +
      "height, blank line and marked caption. Normalized HTTPS www.figma.com links retain " +
      "design/file/proto/board/slides/community/file path, key/id, optional name and node-id, " +
      "starting-point-node-id, version-id; other query values and fragments were dropped at save. " +
      "Absent keys are omitted; header newlines fold to spaces and prose lines starting ::: are " +
      "escaped. Import restores caption marks and adjacent containers; invalid/unclosed containers " +
      "remain literal paragraphs. MCP refuses bad Figma content with invalid_figma; get_doc derives " +
      "kind/file/fileName/node. Markdown help owns height 240–960 and accepted links. Export contacts " +
      "no Figma service. Chart/data records are omitted with a notice; Markdown is never storage and " +
      "MCP has no import tool." +
      helpPointer("export_markdown"),
    outputSchema: outputSchemas.export_markdown,
    inputSchema,
  }, guarded("export_markdown", context, exportMarkdownOperation));
}

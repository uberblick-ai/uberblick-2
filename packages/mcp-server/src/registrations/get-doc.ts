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
      "Read metadata, blocks, threads. Regular pages return related then linked decision topics; " +
      "decision discussion: RFC UUID/null, separate from curated links and recorded answer. " +
      "Decisions have no TL;DR: tldr is null. Entries cache discussion (absent if unknown) and answerPreview (" +
      "first paragraph/list, max 300 chars). Missing description/TL;DR is null; data lists " +
      "collections/counts for get_data. Blocks include rev. Tables return canonical GFM; cards return " +
      "button: [Text](destination) lines after footer in authored order. Plain labels link to https or " +
      "exact claude://code/new, claude-cli://open, codex://new, optionally with ?query. Style " +
      "outline/filled and color neutral/blue/green/violet default to outline neutral; output puts style " +
      "before color and omits defaults. Figma returns :::figma content without delimiters: normalized " +
      "url, optional plain title and height, blank line and marked caption. Read-only figma: kind " +
      "(frame, file, prototype, board, slides or community file), file, optional decoded fileName " +
      "(dashes as spaces) and optional node (12:345 form). Tables/cards/Figma have formatting-sensitive " +
      "rev, including every button's text, destination, appearance and order; other rev ignores marks. " +
      "Prose doc_links has ranges; container links have none. Card thread ranges name their part; Figma " +
      "ranges name caption with caption-text offsets. No Figma request; eligible guidance counts toward " +
      "this process's briefing." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

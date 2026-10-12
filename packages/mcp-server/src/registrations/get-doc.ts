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
      "Read metadata, blocks and threads before editing. Regular pages return related then linked decision " +
      "topics; decisions return discussion (RFC UUID or null), separately from curated links and " +
      "recorded answer attribution. Entries cache discussion (absent if unknown) and answerPreview (legacy TL;DR or first " +
      "paragraph/list, shortened to 300 characters). Missing description/TL;DR returns null; data lists " +
      "collection names/counts for deliberate get_data reads. Blocks include rev. Tables return canonical " +
      "GFM; cards return container content with optional button after footer. Figma returns :::figma content " +
      "without delimiters: normalized url, optional plain title and height, blank line and marked caption. " +
      "The read-only figma object has kind (frame, file, prototype, board, slides or community file), file, " +
      "optional fileName (decoded, dashes as spaces) and optional node (12:345 form). Saving retained only " +
      "Figma view paths and node-id, starting-point-node-id, version-id on https://www.figma.com; markdown " +
      "help specifies accepted links, keys and invalid_figma refusals. Tables/cards/Figma have formatting-sensitive " +
      "rev; other rev ignores marks. Prose doc_links has ranges; container links have none. Card thread " +
      "ranges name their part; Figma ranges name caption with caption-text offsets. This read makes no " +
      "Figma request; eligible guidance counts toward this process's briefing." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

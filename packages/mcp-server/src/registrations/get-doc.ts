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
      "Read metadata, blocks/rev and threads. Regular pages return related then linked decision topics; " +
      "code_check is [] or latest repository/commit/checked_at/result entries: matches (agrees), ahead " +
      "(intentionally undelivered), drift (unintended disagreement). Content edits preserve checks; decisions " +
      "omit them. Decision discussion: RFC UUID/null, apart from curated links and recorded answer. Decisions " +
      "have no TL;DR (tldr: null); entries cache discussion and answerPreview (first paragraph/list, max 300 " +
      "chars), absent if unknown. Unset description/TL;DR: null; data lists collections/counts for get_data. " +
      "Tables: canonical GFM. Cards: button: [Text](destination) after footer, authored order; plain labels " +
      "link to https or exact claude://code/new, claude-cli://open, codex://new, optionally ?query. Style " +
      "outline/filled, color neutral/blue/green/violet; default outline neutral omitted, style before color. " +
      "Figma: :::figma content, no delimiters, normalized url, optional plain title/height, blank line, marked " +
      "caption; read-only kind (frame/file/prototype/board/slides/community file), file, optional decoded " +
      "fileName (dashes as spaces), node (12:345). Tables/cards/Figma rev includes formatting and button " +
      "values/order; other rev ignores marks. Prose doc_links has ranges; containers have none. Card thread " +
      "ranges name part; Figma uses caption offsets. No Figma request; eligible guidance counts toward this " +
      "process's briefing." +
      helpPointer("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

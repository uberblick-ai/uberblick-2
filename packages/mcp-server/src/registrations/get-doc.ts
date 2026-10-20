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
      "Read metadata, blocks/rev and threads; page rev equals the web status row's revision. Regular pages return related then linked decision topics; " +
      "code_check is [] or latest repository/commit/checked_at/result plus recorded rev/paths when known; paths are hints, not complete dependencies. Results: matches (agrees), ahead " +
      "(intentionally undelivered), drift (unintended disagreement). Content edits preserve checks; decisions " +
      "omit them. Decision discussion: RFC UUID/null, apart from curated links and recorded answer. Decisions " +
      "have no TL;DR (tldr: null); entries cache discussion and answerPreview (first paragraph/list, max 300 " +
      "chars), absent if unknown. Unset description/TL;DR: null; data lists collections/counts for get_data. " +
      "Tables: canonical GFM. Cards: canonical content with ordered button lines after footer; see get_help for link/style/color syntax. " +
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

import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, insertBlockOperation } from "../tools/insert-block.js";

export function registerInsertBlock(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("insert_block", {
    title: "Insert a block",
    description:
      "Insert one block after after_block_id, or at the top when omitted; lists use adjacent list-item " +
      "blocks. Tables take one GFM table or invalid_table refuses. Cards take :::card content without " +
      "delimiters: nonempty title, optional label/footer, repeated button: [Text](destination) lines " +
      "and inline-Markdown prose. Button labels are plain text; destinations are https or exact " +
      "claude://code/new, claude-cli://open, codex://new, optionally with ?query. Style outline/filled " +
      "and color neutral/blue/green/violet may follow in either order; defaults are outline neutral. " +
      "Output keeps authored order, writes style before color and omits defaults. Bad cards refuse with " +
      "invalid_card. Figma takes :::figma content without delimiters: required url, optional plain " +
      "one-line title and height 240–960, blank line and marked caption. HTTPS figma.com/www.figma.com " +
      "design/file/proto/board/slides/community/file links retain the key/id, optional name and " +
      "node-id, starting-point-node-id, version-id on www.figma.com; other query fields and fragments " +
      "disappear. invalid_figma refuses bad headers, paths or height without writing; other sites " +
      "require a plain link. Document targets must be known locally or doclink_target_not_known_locally " +
      "refuses. get_doc derives Figma kind/file/fileName/node; this tool contacts no Figma service. " +
      "Other text is plain or literal source; chart source maps document data." +
      helpPointer("insert_block"),
    outputSchema: outputSchemas.insert_block,
    inputSchema,
  }, guarded("insert_block", context, insertBlockOperation));
}

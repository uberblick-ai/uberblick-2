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
      "Insert one block after after_block_id, or at the top when omitted; lists use adjacent list-item blocks. " +
      "Tables take one GFM table with parsed cell marks or refuse with invalid_table. Cards take the :::card " +
      "body: required title, optional label/footer/button and inline-Markdown prose; invalid_card refuses bad " +
      "headers or buttons. Figma takes the :::figma body without delimiters: required url, optional plain " +
      "one-line title and height 240–960, then a blank line and marked caption. HTTPS figma.com/www.figma.com " +
      "links accept design, file, proto, board, slides or community/file, a key/id and optional name. Saving " +
      "keeps these path parts and node-id, starting-point-node-id, version-id on https://www.figma.com; other " +
      "parameters and fragments disappear. Invalid Figma headers, paths or height refuse with invalid_figma " +
      "and no write; other hosts or HTTP give: figma blocks take figma.com links only; use a plain link for " +
      "other sites. Caption links require locally known targets; unknown document targets refuse with " +
      "doclink_target_not_known_locally. get_doc derives Figma kind, file, fileName and node. Other text is " +
      "plain or literal source; chart source maps this document's data. Nothing here contacts Figma; its web " +
      "document stays read-only until the viewer is supported." +
      helpPointer("insert_block"),
    outputSchema: outputSchemas.insert_block,
    inputSchema,
  }, guarded("insert_block", context, insertBlockOperation));
}

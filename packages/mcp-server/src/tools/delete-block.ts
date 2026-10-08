import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteBlock } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DECIDED_IS_READ_ONLY,
  SYNCED_IS_ACKNOWLEDGED,
  TLDR_AFTER_CONTENT_CHANGE,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

export function registerDeleteBlock(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, contentDurability } = context;

  server.registerTool(
    "delete_block",
    {
      title: "Delete a block",
      description:
        "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for new content, " +
        "and never delete-and-reinsert to re-type, which churns the block id and orphans its annotations.\n\n" +
        DECIDED_IS_READ_ONLY +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        "\n\n" +
        TLDR_AFTER_CONTENT_CHANGE +
        toolContract("delete_block"),
      outputSchema: outputSchemas.delete_block,
      inputSchema: strictInput({ uuid: uuidArg, block_id: z.string().min(1) }),
    },
    guarded("delete_block", async ({ uuid, block_id }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid, true);
      deleteBlock(replica.doc, block_id);
      return json({ uuid, blockId: block_id, ...contentDurability(replica) });
    }, context.work),
  );
}

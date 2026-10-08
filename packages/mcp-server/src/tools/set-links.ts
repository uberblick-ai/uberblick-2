import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setLinks } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolContext } from "./context.js";
import { ARCHIVED_IS_READ_ONLY, DECISION_EDGES, SYNCED_IS_ACKNOWLEDGED } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

const linkArg = z
  .uuid("a link is a target document UUID, never a path or a title")
  .describe("Target document UUID.");

export function registerSetLinks(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, durability } = context;

  server.registerTool(
    "set_links",
    {
      title: "Set a document's outbound links",
      description:
        "Replace the document's curated outbound link set. Values are target document UUIDs — never paths, never titles. " +
        DECISION_EDGES +
        " " +
        "The backlinks index follows immediately.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_links"),
      inputSchema: strictInput({ uuid: uuidArg, links: z.array(linkArg) }),
    },
    guarded("set_links", async ({ uuid, links }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
      setLinks(replica.doc, links);
      return json({ uuid, links, ...durability(replica) });
    }),
  );
}

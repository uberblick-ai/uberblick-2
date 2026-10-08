import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_TLDR_LENGTH, setTldr } from "@uberblick/schema";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DECIDED_IS_READ_ONLY,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { tldrArg, uuidArg } from "./schemas.js";

export function registerSetTldr(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, durability } = context;

  server.registerTool(
    "set_tldr",
    {
      title: "Set or clear a document's TL;DR",
      description:
        "Replace the person-facing TL;DR wholesale with one or two sentences of plain English, or pass null to " +
        "clear it. It is independent of the agent-facing description: writing either leaves the other untouched. " +
        "The value lives in document metadata; decision stubs also cache it as the decision line for discovery. " +
        "Ordinary document stubs, search and Markdown do not carry it.\n\n" +
        "An empty or whitespace-only string is refused rather than treated as a clear, and an overlong value is " +
        `refused rather than truncated. The shared limit is ${MAX_TLDR_LENGTH} characters.\n\n` +
        DECIDED_IS_READ_ONLY +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_tldr"),
      outputSchema: outputSchemas.set_tldr,
      inputSchema: strictInput({ uuid: uuidArg, tldr: tldrArg }),
    },
    guarded("set_tldr", async ({ uuid, tldr }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid, true);
      setTldr(replica.doc, tldr);
      return json({ uuid, tldr, ...durability(replica) });
    }, context.work),
  );
}

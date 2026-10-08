import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setDescription } from "@uberblick/schema";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import {
  ARCHIVED_IS_READ_ONLY,
  DESCRIPTION_IS_FOR_CHOOSING,
  SYNCED_IS_ACKNOWLEDGED,
} from "./descriptions.js";
import { json } from "./helpers.js";
import { descriptionArg, uuidArg } from "./schemas.js";

export function registerSetDescription(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, durability } = context;

  server.registerTool(
    "set_description",
    {
      title: "Set a document's description",
      description:
        "Replace the document's description wholesale. A description is rewritten rather than patched, so there is " +
        "nothing to splice here and no `old_text` to assert. The directory stub follows immediately, the way it " +
        "does for a rename, so the next list_docs, search and backlinks answer with it.\n\n" +
        DESCRIPTION_IS_FOR_CHOOSING +
        "\n\n" +
        "This is the tool the `descriptionHint` on a write points at: a document created in the web UI has no " +
        "description, and an agent that has just worked inside one is the party who can write it.\n\n" +
        "There is no way to clear a description from here: the empty string, and a string of nothing but " +
        "whitespace, are both refused. Removing one is a schema-level operation, not a tool — a document that " +
        "advertises nothing is a gap to fill rather than a state to ask for. Replace a description you dislike " +
        "with a better one.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_description"),
      outputSchema: outputSchemas.set_description,
      inputSchema: strictInput({ uuid: uuidArg, description: descriptionArg }),
    },
    guarded("set_description", async ({ uuid, description }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
      setDescription(replica.doc, description);
      return json({ uuid, description, ...durability(replica) });
    }, context.work),
  );
}

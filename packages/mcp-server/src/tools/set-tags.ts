import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assignDocumentTags } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { resolveTagSelectors } from "../tag-catalog.js";
import type { ToolContext } from "./context.js";
import { ARCHIVED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

export function registerSetTags(server: McpServer, context: ToolContext): void {
  const {
    toolContract,
    replicas,
    briefing,
    requireWritableDoc,
    documentTags,
    tagCatalog,
    durability,
  } = context;

  server.registerTool(
    "set_tags",
    {
      title: "Set a document's tags",
      description:
        "Replace the document's complete tag assignment set with catalog ids or exact active names. Names resolve " +
        "to canonical ids before storage. An existing retired or unresolved assignment may be preserved by passing " +
        "the id returned by get_doc; it may be removed, but cannot be newly added. Any unknown or newly assigned " +
        "retired value refuses the whole mutation before the document, directory stub or index changes and names " +
        "every invalid value; call list_tags for the active vocabulary. This is the tool the `tagHint` on an " +
        "untagged write points at.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_tags"),
      inputSchema: strictInput({ uuid: uuidArg, tags: z.array(z.string().min(1)) }),
    },
    guarded("set_tags", async ({ uuid, tags }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
      const tagIds = resolveTagSelectors(
        replicas,
        tags,
        documentTags(replica),
      );
      assignDocumentTags(replica.doc, tagCatalog(), tagIds);
      return json({ uuid, tags: documentTags(replica), ...durability(replica) });
    }),
  );
}

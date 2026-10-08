import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setTitle } from "@uberblick/schema";
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
import { titleArg, uuidArg } from "./schemas.js";

export function registerSetTitle(server: McpServer, context: ToolContext): void {
  const { toolContract, replicas, briefing, requireWritableDoc, durability } = context;

  server.registerTool(
    "set_title",
    {
      title: "Rename a document",
      description:
        "Replace the document's title. A title is rewritten rather than patched, so there is nothing to splice " +
        "here and no `old_text` to assert. Identity is the uuid and a rename never touches it, so every link, " +
        "backlink and annotation survives one.\n\n" +
        "`meta.title` in the document is authoritative and the directory stub caches it. This writes the " +
        "document and the stub follows in the same call, so the next search and get_sidebar answer with the new " +
        "title without opening a single document room. list_docs does too; for a decision, pass a matching `kind`, " +
        "`status` or `tag` predicate.\n\n" +
        "An empty title, and a title of nothing but whitespace, are both refused: a document nobody can name is " +
        "a document nobody can pick out of a listing.\n\n" +
        DECIDED_IS_READ_ONLY +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        toolContract("set_title"),
      outputSchema: outputSchemas.set_title,
      inputSchema: strictInput({ uuid: uuidArg, title: titleArg }),
    },
    guarded("set_title", async ({ uuid, title }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid, true);
      setTitle(replica.doc, title);
      return json({ uuid, title, ...durability(replica) });
    }, context.work),
  );
}

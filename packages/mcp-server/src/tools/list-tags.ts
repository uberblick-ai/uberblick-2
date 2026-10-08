import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { failureContract, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import { activeTagCatalog, tagCatalogComplete } from "../tag-catalog.js";
import type { ToolContext } from "./context.js";
import { json } from "./helpers.js";

export function registerListTags(server: McpServer, context: ToolContext): void {
  const { replicas, tagCatalog } = context;

  server.registerTool(
    "list_tags",
    {
      title: "List assignable tags",
      description:
        "The active workspace tag catalog, in deterministic name order. Each entry carries the stable " +
        "canonical `id` documents store and its current display `name`. Retired entries are absent here but remain " +
        "visible, marked retired, on documents that still carry them. MCP cannot curate this catalog.\n\n" +
        "`complete` says whether this is the whole workspace vocabulary. It is false while a configured hub has not " +
        "delivered the catalog room to this replica: what is listed is then a local copy that may be missing curated " +
        "entries, and a tag value this replica has never seen is refused rather than assigned. `hub` says where that " +
        "connection stands." +
        failureContract("list_tags"),
      outputSchema: outputSchemas.list_tags,
      inputSchema: strictInput({}),
    },
    guarded("list_tags", async () => {
      await replicas.settle();
      return json({
        workspace: replicas.config.workspaceId,
        complete: tagCatalogComplete(replicas),
        tags: activeTagCatalog(tagCatalog()).map(({ id, name }) => ({ id, name })),
        hub: replicas.sync.state(),
      });
    }),
  );
}

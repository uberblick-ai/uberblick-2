/** MCP resource registration for replica-local guidance. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { exportMarkdown } from "@uberblick/schema";
import { GUIDANCE_INSTRUCTIONS } from "./briefing.js";
import type { GuidanceBriefing } from "./briefing.js";
import type { Replicas } from "./replica.js";
import type { ServerWork } from "./server-work.js";
import { ClientSafeResourceError, guardedResource } from "./resource-adapter.js";

export { GuidanceBriefing, GUIDANCE_INSTRUCTIONS } from "./briefing.js";

export function registerGuidanceResources(
  server: McpServer,
  replicas: Replicas,
  briefing: GuidanceBriefing,
  work: ServerWork,
): void {
  server.registerResource(
    "guidance",
    new ResourceTemplate("uberblick://doc/{uuid}", {
      list: guardedResource(() => {
        work.assertOpen();
        replicas.refresh();
        return {
          resources: briefing.documents().map(({ uuid, title }) => ({
            uri: `uberblick://doc/${uuid}`,
            name: uuid,
            title,
            mimeType: "text/markdown",
            description: "Current replica-local guidance. Read with get_doc to satisfy the briefing.",
          })),
        };
      }),
    }),
    { title: "Workspace guidance", mimeType: "text/markdown", description: GUIDANCE_INSTRUCTIONS },
    guardedResource((uri: URL, { uuid }: { uuid?: string | string[] }) => {
      work.assertOpen();
      replicas.refresh();
      if (typeof uuid !== "string" || !briefing.documents().some((doc) => doc.uuid === uuid)) {
        throw new ClientSafeResourceError(ErrorCode.InvalidParams, "No locally readable guidance at this URI; list resources again.");
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: exportMarkdown(replicas.replica(uuid).doc, { tagCatalog: replicas.settings().doc, directory: replicas.directory().doc }),
        }],
      };
    }),
  );
}

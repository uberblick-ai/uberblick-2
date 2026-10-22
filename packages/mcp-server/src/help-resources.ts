/** SDK adapter for bundled resources and help captured from tool registrations. */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { parseWithCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { HelpCatalog, ToolHelp } from "./help.js";
import type { ServerWork } from "./server-work.js";
import { ClientSafeResourceError, guardedResource } from "./resource-adapter.js";

/** Render the schemas as tools/list advertises them, and refuse an example they reject. */
export function captureTool(help: HelpCatalog, entry: ToolHelp, tool: RegisteredTool): void {
  const input = normalizeObjectSchema(tool.inputSchema);
  const output = normalizeObjectSchema(tool.outputSchema);
  if (input === undefined || output === undefined || tool.title === undefined || tool.description === undefined) {
    throw new Error(`Help requires the full registered contract for ${entry.name}`);
  }
  parseWithCompat(input, entry.example);
  help.addTool(entry, { title: tool.title, description: tool.description });
}

export function registerHelpResources(server: McpServer, help: HelpCatalog, work: ServerWork): void {
  server.registerResource(
    "help",
    new ResourceTemplate("uberblick://help/{topic}", {
      list: guardedResource(() => {
        work.assertOpen();
        return { resources: help.list().map(({ id, ...entry }) => ({ ...entry, name: id, mimeType: "text/markdown" })) };
      }),
    }),
    { title: "Product help", description: "Bundled, version-matched, workspace-agnostic product help.", mimeType: "text/markdown" },
    guardedResource((uri: URL, { topic }: { topic?: string | string[] }) => {
      work.assertOpen();
      const found = typeof topic === "string" ? help.get(topic) : undefined;
      if (found === undefined) {
        // MCP 2025-11-25 specifies resource-not-found; SDK 1.32.1 has no named constant.
        throw new ClientSafeResourceError(-32002, `Resource not found: ${uri.href}`, { uri: uri.href });
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: found.text }] };
    }),
  );
}

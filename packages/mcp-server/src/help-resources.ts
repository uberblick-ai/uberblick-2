/** SDK adapter for bundled resources and help captured from tool registrations. */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat, parseWithCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { toolHelpEntries } from "./help-examples.js";
import type { HelpCatalog } from "./help.js";
import type { ServerWork } from "./server-work.js";

/** Registrations need only this public SDK method, allowing help to capture its result. */
export type ToolRegistrar = Pick<McpServer, "registerTool">;

function captureTool(help: HelpCatalog, name: string, tool: RegisteredTool): void {
  const entry = toolHelpEntries[name as keyof typeof toolHelpEntries];
  if (entry === undefined) throw new Error(`No help example and related topics for registered tool: ${name}`);
  const input = normalizeObjectSchema(tool.inputSchema);
  const output = normalizeObjectSchema(tool.outputSchema);
  if (input === undefined || output === undefined || tool.title === undefined || tool.description === undefined) {
    throw new Error(`Help requires the full registered contract for ${name}`);
  }
  parseWithCompat(input, entry.example);
  help.addTool(name, {
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: "input" }),
    outputSchema: toJsonSchemaCompat(output, { strictUnions: true, pipeStrategy: "output" }),
  });
}

export function createToolRegistrar(server: McpServer, help: HelpCatalog): ToolRegistrar {
  const sdkRegisterTool = server.registerTool.bind(server);
  return {
    registerTool: (name, config, handler) => {
      const tool = sdkRegisterTool(name, config, handler);
      captureTool(help, name, tool);
      return tool;
    },
  };
}

export function registerHelpResources(server: McpServer, help: HelpCatalog, work: ServerWork): void {
  server.registerResource(
    "help",
    new ResourceTemplate("uberblick://help/{topic}", {
      list: () => {
        work.assertOpen();
        return { resources: help.list().map(({ id, ...entry }) => ({ ...entry, name: id, mimeType: "text/markdown" })) };
      },
    }),
    { title: "Product help", description: "Bundled, version-matched, workspace-agnostic product help.", mimeType: "text/markdown" },
    (uri, { topic }) => {
      work.assertOpen();
      const found = typeof topic === "string" ? help.get(topic) : undefined;
      if (found === undefined) {
        // MCP 2025-11-25 specifies resource-not-found; SDK 1.31 has no named constant.
        throw new McpError(-32002, `Resource not found: ${uri.href}`, { uri: uri.href });
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: found.text }] };
    },
  );
}

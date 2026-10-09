import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import { guarded } from "../tool-adapter.js";
import type { ToolContext } from "../tools/context.js";
import { inputSchema, getHelpOperation } from "../tools/get-help.js";

export function registerGetHelp(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("get_help", {
    title: "Read product help",
    description:
      "Read bundled, version-matched product help by topic or exact registered tool name. Omit topic to list " +
      "every topic with its id, title, description and URI. The returned text is the same Markdown as " +
      "uberblick://help/{topic}. Help is workspace-agnostic, needs no guidance briefing and never opens or " +
      "settles a replica; it remains available offline and while the replica store is quarantined. " +
      "Unknown topics refuse with unknown_help_topic and list valid topic ids; choose one and retry." +
      helpPointer("get_help"),
    inputSchema,
    outputSchema: outputSchemas.get_help,
  }, guarded("get_help", context, getHelpOperation));
}

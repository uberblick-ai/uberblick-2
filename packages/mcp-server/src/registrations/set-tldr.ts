import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { MAX_TLDR_LENGTH } from "@uberblick/schema";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setTldrOperation } from "../tools/set-tldr.js";

export function registerSetTldr(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_tldr", {
    title: "Set or clear a document's TL;DR",
    description:
      "Replace the person-facing TL;DR wholesale with one or two sentences of plain English, or pass null to " +
      "clear it. It is independent of the agent-facing description: writing either leaves the other untouched. " +
      "The value lives in document metadata; decision stubs also cache it as the decision line for discovery. " +
      "Ordinary document stubs, search and Markdown do not carry it.\n\n" +
      `An empty or whitespace-only string is refused rather than treated as a clear, and an overlong value is refused rather than truncated. The shared limit is ${MAX_TLDR_LENGTH} characters.` +
      helpPointer("set_tldr"),
    outputSchema: outputSchemas.set_tldr,
    inputSchema,
  }, guarded("set_tldr", context, setTldrOperation));
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "./tool-table.js";
import type { OperationRequest } from "./tools/operation.js";
import type { ToolContext } from "./tools/context.js";
import { toFailure } from "./failures.js";

/** Both wire answers use the same JSON serialization; failures stay text-only. */
export function toolResult(payload: object, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? {} : { structuredContent: { ...payload } }),
  };
}

/** Socket diagnostics belong to client readings, not the MCP hub contract. */
function mcpPayload(payload: object): object {
  if (!("hub" in payload) || payload.hub === null || typeof payload.hub !== "object") {
    return payload;
  }
  const hub: Record<string, unknown> = { ...payload.hub };
  delete hub.cause;
  delete hub.detail;
  return { ...payload, hub };
}

/**
 * Workspace operations await only their opening settle, then read and write
 * synchronously: another await could interleave writes to the same Y.Doc.
 * handler-invariants checks registered operations and collectSyncStatus's
 * delegated settle; static get_help never settles.
 */
export function guarded(
  tool: Pick<Tool, "name" | "output" | "operation" | "writes">,
  context: ToolContext,
): (args: Record<string, unknown>, extra: Pick<OperationRequest, "signal" | "_meta">) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      const payload = mcpPayload(await context.work.run(() => tool.operation(context, args, {
        signal: extra.signal,
        ...(extra._meta === undefined ? {} : { _meta: extra._meta }),
        ...(extra._meta?.progressToken === undefined ? {} : { progressToken: extra._meta.progressToken }),
      })));
      const parsed = tool.output.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Output validation failed for ${tool.name}: ${parsed.error.message}`);
      }
      return toolResult(payload);
    } catch (error) {
      const failure = toFailure(tool, error);
      return toolResult(mcpPayload(failure.payload), failure.isError);
    }
  };
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "./tool-table.js";
import type { OperationRequest } from "./tools/operation.js";
import type { ToolContext } from "./tools/context.js";
import { toFailure } from "./failures.js";
import { writeAcknowledgement } from "./write-acknowledgement.js";
import { ImageResult } from "./tools/image-result.js";

/**
 * Both wire answers carry the same JSON; failures stay text-only. The text copy
 * is compact because clients that show both pay for it twice.
 */
export function toolResult(payload: object, isError = false, image?: ImageResult["image"]): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) },
      ...(!isError && image ? [{ type: "image" as const, ...image }] : [])],
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
 * Workspace writes stay synchronous after opening settle so another await
 * cannot interleave writes to the same Y.Doc. Hub revision requests may await
 * detached reads or hub-only naming, without mutating a local Y.Doc. handler-invariants checks these boundaries;
 * static get_help never settles. Hosted replies may await acknowledgement once
 * the complete synchronous write phase has finished.
 */
export function guarded(
  tool: Pick<Tool, "name" | "output" | "operation" | "writes">,
  context: ToolContext,
  waitForWriteAcknowledgement = false,
  assertWriteScope?: () => void,
): (args: Record<string, unknown>, extra: Pick<OperationRequest, "signal" | "_meta">) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      return await context.work.run(async () => {
        const acknowledgement = waitForWriteAcknowledgement && tool.writes !== null
          ? writeAcknowledgement(context) : null;
        let payload: object;
        let image: ImageResult["image"] | undefined;
        let isError = false;
        try {
          const result = await tool.operation(acknowledgement?.context ?? context, args, {
            signal: extra.signal,
            ...(assertWriteScope === undefined ? {} : { assertWriteScope }),
            ...(extra._meta === undefined ? {} : { _meta: extra._meta }),
            ...(extra._meta?.progressToken === undefined ? {} : { progressToken: extra._meta.progressToken }),
          });
          payload = result instanceof ImageResult ? result.payload : result;
          image = result instanceof ImageResult ? result.image : undefined;
        } catch (error) {
          const failure = toFailure(tool, error);
          payload = failure.payload;
          isError = failure.isError;
        }
        if (acknowledgement !== null) payload = await acknowledgement.finish(payload);
        payload = mcpPayload(payload);
        if (!isError) {
          const parsed = tool.output.safeParse(payload);
          if (!parsed.success) {
            throw new Error(`Output validation failed for ${tool.name}: ${parsed.error.message}`);
          }
        }
        return toolResult(payload, isError, image);
      });
    } catch (error) {
      const failure = toFailure(tool, error);
      return toolResult(mcpPayload(failure.payload), failure.isError);
    }
  };
}

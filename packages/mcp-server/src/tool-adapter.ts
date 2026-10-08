import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Operation, OperationRequest } from "./tools/operation.js";
import type { ToolContext } from "./tools/context.js";
import { toFailure } from "./failures.js";
import { outputSchemas } from "./outputs.js";

/** Both wire answers use the same JSON serialization; failures stay text-only. */
export function toolResult(payload: object, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? {} : { structuredContent: { ...payload } }),
  };
}

/** Validate inside the failure boundary; mismatches are logged text-only internal errors. */
export function guarded<Args>(
  tool: keyof typeof outputSchemas,
  context: ToolContext,
  call: Operation<Args>,
): (args: Args, extra: Pick<OperationRequest, "signal" | "_meta">) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      const payload = await call(context, args, {
        signal: extra.signal,
        ...(extra._meta === undefined ? {} : { _meta: extra._meta }),
        ...(extra._meta?.progressToken === undefined ? {} : { progressToken: extra._meta.progressToken }),
      });
      const parsed = outputSchemas[tool].safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Output validation failed for ${tool}: ${parsed.error.message}`);
      }
      return toolResult(payload);
    } catch (error) {
      const failure = toFailure(tool, error);
      return toolResult(failure.payload, failure.isError);
    }
  };
}

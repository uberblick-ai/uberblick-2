import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setStatusOperation } from "../tools/set-status.js";

export function registerSetStatus(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_status", {
    title: "Set a document's lifecycle status",
    description:
      "Record a document's lifecycle status. On an ordinary document this also adopts the kind that owns the " +
      "status; the result names both, so adoption is never silent. A document that already has a kind accepts " +
      "only that kind's statuses. Its kind is fixed through MCP: if it was adopted in error, retrying with the " +
      "other kind's status cannot change it. An open record can be withdrawn without an answer; decided records " +
      "cannot reopen or withdraw. Rejected and withdrawn are final. Rejection requires a non-empty `reason` and " +
      "a recorded person's answer, and applies only to an open proposal, an agent stance or a decided record in " +
      "a conflict. It stores `rejectionReason`. Validation refusals change nothing." +
      helpPointer("set_status"),
    outputSchema: outputSchemas.set_status,
    inputSchema,
  }, guarded("set_status", context, setStatusOperation));
}

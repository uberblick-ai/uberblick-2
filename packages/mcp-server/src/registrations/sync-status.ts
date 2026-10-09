import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, syncStatusOperation } from "../tools/sync-status.js";

export function registerSyncStatus(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("sync_status", {
    title: "Sync status",
    description:
      "Inspect local replica state, pending rooms and hub connection/acknowledgements. hub.status distinguishes " +
      "disabled, retryable hub-down, auth-failed requiring action, and update-required protocol mismatch. " +
      "hub.recoveryClass, authRecovery and reason explain recovery; protocolVersion and hubProtocolVersion " +
      "identify the incompatible side. Tools still work locally. unsyncedChanges counts durable pending rooms; " +
      "inFlightUpdates counts provider sync messages on the current connection, resetting on reconnect. " +
      "lastSync is this machine's stored UTC time when its full replica caught up, or null; it never moves " +
      "backwards across processes. persistence diagnoses a failed log append and remains readable when ordinary " +
      "replica tools are quarantined until restart. See this tool's help for counter units and lastSync " +
      "conditions." +
      helpPointer("sync_status"),
    outputSchema: outputSchemas.sync_status,
    inputSchema,
  }, guarded("sync_status", context, syncStatusOperation));
}

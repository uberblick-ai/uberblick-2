import type { ToolRegistrar } from "../help-resources.js";
import { failureContract } from "../failures.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { SYNCED_MEANS } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, syncStatusOperation } from "../tools/sync-status.js";

export function registerSyncStatus(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("sync_status", {
    title: "Sync status",
    description:
      "What this replica holds and what the hub has acknowledged.\n\n" +
      "`hub.status` distinguishes `hub-down`, a retryable connection or renewal failure, from `auth-failed`, " +
      "an authentication problem that needs human action. `disabled` means sync is disabled, so this server is local-only. " +
      "Every reading carries `hub.recoveryClass`: `retry` means a missing room can still arrive as the connection " +
      "recovers; `manual` means a person must act before sync can resume. This also applies to shared-secret " +
      "readings. `hub.authRecovery`, when present on `auth-failed`, distinguishes `sign-in-required`, " +
      "`no-workspace-access`, `credential-store` and `renewal-unavailable`; `hub.reason` gives the needed action. " +
      "`update-required` is the third kind: this replica and the hub speak different sync protocol versions, so " +
      "the hub refuses the connection outright. `hub.protocolVersion` is this replica's and " +
      "`hub.hubProtocolVersion` the hub's, and `hub.reason` says which side is older; nothing syncs until that " +
      "side is updated, and no amount of waiting changes it. Every tool still works locally throughout.\n\n" +
      "The two counts here are in different units, so they are not expected to agree. `unsyncedChanges` counts " +
      "ROOMS, not updates: the rooms holding local changes the hub has not acknowledged, the ones `pendingRooms` " +
      "names. It is read from the durable pending set, so it survives a restart and is non-zero in local-only " +
      "mode: work that never left this machine is unsynced, whether or not a connection was ever attempted. " +
      "`inFlightUpdates` counts provider SYNC MESSAGES awaiting acknowledgement on the current connection, " +
      "which is not a count of Yjs updates: the provider merges a batch of updates into one message, counts a " +
      "message before it goes out, and resets the backlog to the single sync-handshake message on every " +
      "reconnect — so it can read 1 for a whole document's worth of unsent work. It is in memory and resets " +
      "with the connection. The web client's status line shows the same counter for the room it has open, " +
      "labelled `N sync messages unacked`.\n\n" +
      "`lastSync` is the stored time this machine last found its full replica caught up: connected to the hub, " +
      "no pending room or attach drain, and every attached room acknowledged with no unapplied database changes. " +
      "It is UTC ISO 8601 to the second, or null when no time is stored. It records acknowledgement by the hub, " +
      "not storage there. Each process records it after settling, at most once every five seconds; `ub open` " +
      "also checks while idle. The value never moves backwards across processes.\n\n" +
      `${SYNCED_MEANS} The same holds for \`rooms[].synced\` below and for \`unsyncedChanges: 0\`: both are ` +
      "statements about acknowledgement, so a hub that dies inside the debounce comes back missing updates " +
      "this tool has already reported as synced, until a replica holding them reconnects and re-sends.\n\n" +
      "`persistence` is null unless an update failed to reach the log, in which case every other tool refuses " +
      "to serve until the server is restarted." +
      failureContract("sync_status"),
    outputSchema: outputSchemas.sync_status,
    inputSchema,
  }, guarded("sync_status", context, syncStatusOperation));
}

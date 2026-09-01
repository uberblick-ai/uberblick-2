/** The facts-only General page for workspace settings. */

import type { ReactElement, ReactNode } from "react";
import { directoryRoom, listDirectory } from "@uberblick/schema";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { useRoomStatus } from "./hooks.js";
import type { Workspace } from "./route.js";
import { statusReading } from "./status-reading.js";
import { formatBytes, useLocalCacheSize } from "./UserMenu.js";

/** What a SyncPanel-style fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="ub-panel-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * State the shell already holds, presented without another persistence or RPC
 * path. The directory room is the connection reading because it is the room
 * every workspace page has, including this one.
 */
export function WorkspaceSettings({
  workspace,
  endpoint,
  connection,
  agentSessions,
}: {
  workspace: Workspace;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  agentSessions: number;
}): ReactElement {
  const status = useRoomStatus(connection);
  const state = useCalmSyncState(rawSyncState(status));
  const reading = statusReading(status, state);
  const cache = useLocalCacheSize(true);
  const directoryAnswered =
    connection !== null &&
    connection.room === directoryRoom(workspace.uuid) &&
    connection.status.localReplicaLoaded;
  const documents = directoryAnswered ? listDirectory(connection.ydoc).length : null;

  return (
    <section className="ub-pane ub-settings-page" aria-labelledby="ub-settings-title">
      <div className="ub-settings-column">
        <h1 id="ub-settings-title">General</h1>
        <div className="ub-settings-card">
          <dl className="ub-panel-facts ub-settings-facts">
            <Fact label="Workspace UUID">{workspace.uuid}</Fact>
            <Fact label="Address segment">{workspace.segment}</Fact>
            <Fact label="Documents">{documents ?? UNKNOWN}</Fact>
            <Fact label="Hub">{endpoint?.url ?? UNKNOWN}</Fact>
            <Fact label="Source">
              {endpoint === null ? UNKNOWN : endpointSourceLabel(endpoint.source)}
            </Fact>
            <Fact label="Connection">
              <span>{reading.word}</span>
              {reading.detail !== null && (
                <span className="ub-settings-fact-detail"> {reading.detail}</span>
              )}
            </Fact>
            {cache !== null && (
              <Fact label="Local cache (all workspaces)">{formatBytes(cache)}</Fact>
            )}
            <Fact label="MCP connections">{agentSessions}</Fact>
          </dl>
        </div>
      </div>
    </section>
  );
}

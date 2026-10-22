/** Observe document changes separately from the calm status presentation. */

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RoomConnection, RoomStatus } from "../../collab/rooms.js";
import { refused } from "../../collab/rooms.js";

export interface DocumentSyncActivity {
  lastConfirmedAt: number | null;
  /** A monotonically increasing animation key; handshakes never increment it. */
  pulse: number;
  /** False while a newer local change still lacks a fresh upstream answer. */
  confirmed: boolean;
}

const EMPTY: DocumentSyncActivity = {
  lastConfirmedAt: null,
  pulse: 0,
  confirmed: false,
};

interface HubEvidence {
  localServer: boolean;
  acked: boolean | null | undefined;
  sampledAt: number | null;
}

function admitted(status: RoomStatus): boolean {
  return status.connected && status.writable && !refused(status);
}

/**
 * Provider acknowledgements include reconnect handshakes, so only Y.Doc
 * updates arm a pulse. A local server's acknowledgement proves local saving;
 * a later upstream sample is needed before calling that change hub-confirmed.
 */
export function useDocumentSyncActivity(
  connection: RoomConnection | null,
  hubAcked: boolean | null | undefined,
  rawHubAcked: boolean | null | undefined = hubAcked,
  sampledAt: number | null = null,
): DocumentSyncActivity {
  const [reading, setReading] = useState<{
    connection: RoomConnection;
    value: DocumentSyncActivity;
  } | null>(null);
  const refresh = useRef<(evidence?: HubEvidence) => void>(() => {});
  const upstream = useEffectEvent(() => ({
    localServer: hubAcked !== undefined,
    acked: rawHubAcked,
    sampledAt,
  }));

  useEffect(() => {
    if (connection === null) return;
    let value = { ...EMPTY };
    let status = connection.status;
    let changed = false;
    let savedAfter: number | null = null;

    const publish = (next: DocumentSyncActivity): void => {
      if (next.confirmed === value.confirmed &&
        next.lastConfirmedAt === value.lastConfirmedAt && next.pulse === value.pulse) return;
      value = next;
      setReading({ connection, value });
    };

    const read = (evidence?: HubEvidence): void => {
      const current = evidence ?? upstream();
      const saved = admitted(status) && status.synced && status.unsyncedChanges === 0;
      if (!saved) {
        savedAfter = null;
        publish({ ...value, confirmed: false });
        return;
      }
      if (changed && savedAfter === null) savedAfter = Date.now();
      const fresh = !changed || (current.sampledAt !== null &&
        savedAfter !== null && current.sampledAt > savedAfter);
      const confirmed = !current.localServer || current.acked === true && fresh;
      if (!confirmed) {
        publish({ ...value, confirmed: false });
        return;
      }
      const pulse = value.pulse + (changed ? 1 : 0);
      const lastConfirmedAt = !value.confirmed || changed
        ? current.localServer ? current.sampledAt ?? Date.now() : Date.now()
        : value.lastConfirmedAt;
      changed = false;
      savedAfter = null;
      publish({ lastConfirmedAt, pulse, confirmed: true });
    };

    const onUpdate = (_update: Uint8Array, origin: unknown): void => {
      if (origin === connection.provider) {
        // Initial and reconnect state applies before the provider raises synced.
        if (!admitted(status) || !status.synced) return;
        const current = upstream();
        if (!current.localServer) {
          publish({ ...value, pulse: value.pulse + 1, lastConfirmedAt: Date.now() });
          return;
        }
      }
      changed = true;
      savedAfter = null;
      publish({ ...value, confirmed: false });
      read();
    };

    refresh.current = read;
    connection.ydoc.on("update", onUpdate);
    const stop = connection.onStatusChange((next) => {
      status = next;
      read();
    });
    return () => {
      refresh.current = () => {};
      connection.ydoc.off("update", onUpdate);
      stop();
    };
  }, [connection]);

  useEffect(() => {
    refresh.current({ localServer: hubAcked !== undefined, acked: rawHubAcked, sampledAt });
  }, [hubAcked, rawHubAcked, sampledAt]);

  return reading?.connection === connection ? reading.value : EMPTY;
}

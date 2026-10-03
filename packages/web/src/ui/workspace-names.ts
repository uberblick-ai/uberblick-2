/** Shared names are room state; labels never borrow an address or user name. */
import { useEffect, useState } from "react";
import { getWorkspaceName, settingsRoom } from "@uberblick/schema";
import { acquireRoom } from "../collab/rooms.js";
import type { RoomConnection } from "../collab/rooms.js";
import type { AwarenessUser } from "../collab/identity.js";
import type { Workspace } from "./route.js";
import { useRoomStatus } from "./hooks.js";

export function useWorkspaceName(connection: RoomConnection | null): string | null {
  const [reading, setReading] = useState<{
    connection: RoomConnection;
    name: string | null;
  } | null>(null);
  useEffect(() => {
    if (connection === null) return;
    const read = (): void => setReading({ connection, name: getWorkspaceName(connection.ydoc) });
    read();
    connection.ydoc.on("update", read);
    return () => connection.ydoc.off("update", read);
  }, [connection]);
  if (connection === null) return null;
  return reading?.connection === connection ? reading.name : getWorkspaceName(connection.ydoc);
}

/** Only the open menu needs other workspaces' small settings rooms. */
export function useWorkspaceNames(
  workspaces: readonly Workspace[],
  currentUuid: string | null,
  connection: RoomConnection | null,
  identity: AwarenessUser,
  menuOpen: boolean,
): ReadonlyMap<string, string | null> {
  const currentName = useWorkspaceName(connection);
  const status = useRoomStatus(connection);
  const [otherNames, setOtherNames] = useState<ReadonlyMap<string, string | null>>(new Map());
  const otherUuids = workspaces.filter((workspace) => workspace.uuid !== currentUuid).map((workspace) => workspace.uuid).join(",");
  useEffect(() => {
    if (!menuOpen || otherUuids === "") return;
    const stops = otherUuids.split(",").map((uuid) => {
      const handle = acquireRoom(settingsRoom(uuid), identity, { presence: false });
      const room = handle.connection;
      const read = (): void => {
        const name = room.status.hasReceivedServerState ? getWorkspaceName(room.ydoc) : null;
        setOtherNames((previous) => {
          if (previous.has(uuid) && previous.get(uuid) === name) return previous;
          return new Map(previous).set(uuid, name);
        });
      };
      room.ydoc.on("update", read);
      const stopStatus = room.onStatusChange(read);
      read();
      return () => {
        stopStatus();
        room.ydoc.off("update", read);
        handle.release();
      };
    });
    return () => { for (const stop of stops) stop(); };
  }, [menuOpen, otherUuids, identity]);
  const names = new Map(otherNames);
  if (currentUuid !== null) {
    names.set(currentUuid, connection?.room === settingsRoom(currentUuid) && status.hasReceivedServerState ? currentName : null);
  }
  return names;
}

/** A stable short identifier distinguishes unnamed entries without a full UUID. */
export function workspaceLabel(
  workspace: Workspace,
  names: ReadonlyMap<string, string | null>,
  workspaces: readonly Workspace[],
): string {
  const name = names.get(workspace.uuid);
  if (name !== null && name !== undefined) return name;
  const shortId = workspace.uuid.slice(0, 8);
  const collisions = workspaces.filter((other) => other.uuid.slice(0, 8) === shortId);
  const suffix = collisions.length > 1 ? ` (${collisions.findIndex((other) => other.uuid === workspace.uuid) + 1})` : "";
  return `Unnamed workspace · ${shortId}${suffix}`;
}

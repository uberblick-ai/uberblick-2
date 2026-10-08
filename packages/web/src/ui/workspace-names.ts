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

/** Local menus use replica snapshots; direct hubs read settings only while open. */
export function useWorkspaceNames(
  workspaces: readonly Workspace[],
  currentUuid: string | null,
  connection: RoomConnection | null,
  identity: AwarenessUser,
  menuOpen: boolean,
  recordedNames: ReadonlyMap<string, string | null> | null = null,
): ReadonlyMap<string, string | null> {
  const currentName = useWorkspaceName(connection);
  const status = useRoomStatus(connection);
  const [otherNames, setOtherNames] = useState<ReadonlyMap<string, string | null>>(new Map());
  const localMenu = recordedNames !== null;
  const otherUuids = workspaces.filter((workspace) => workspace.uuid !== currentUuid).map((workspace) => workspace.uuid).join(",");
  useEffect(() => {
    if (localMenu || !menuOpen || otherUuids === "") return;
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
  }, [localMenu, menuOpen, otherUuids, identity]);
  const currentReceived = currentUuid !== null && connection?.room === settingsRoom(currentUuid) && status.hasReceivedServerState;
  useEffect(() => {
    if (!localMenu || !currentReceived || currentUuid === null) return;
    setOtherNames(previous => previous.has(currentUuid) && previous.get(currentUuid) === currentName
      ? previous : new Map(previous).set(currentUuid, currentName));
  }, [localMenu, currentReceived, currentUuid, currentName]);
  const names = new Map(recordedNames ?? []);
  for (const [uuid, name] of otherNames) names.set(uuid, name);
  if (currentUuid !== null) {
    names.set(currentUuid, currentReceived ? currentName : localMenu ? names.get(currentUuid) ?? null : null);
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

/** Shared names are room state; labels never borrow an address or user name. */
import { useEffect, useState } from "react";
import { getWorkspaceName, settingsRoom } from "@uberblick/schema";
import { acquireRoom } from "../collab/rooms.js";
import type { RoomConnection } from "../collab/rooms.js";
import type { AwarenessUser } from "../collab/identity.js";
import type { Workspace } from "./route.js";
import { useRoomStatus } from "./hooks.js";
import { useWorkspaceSetting } from "./workspace-setting.js";

export function useWorkspaceName(connection: RoomConnection | null): string | null {
  return useWorkspaceSetting(connection, getWorkspaceName);
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
      let stopReading = (): void => {};
      const bind = (room: RoomConnection): void => {
        stopReading();
        const ydoc = room.ydoc;
        const read = (): void => {
          if (!room.status.hasReceivedServerState) return;
          const name = getWorkspaceName(ydoc);
          setOtherNames((previous) => {
            if (previous.has(uuid) && previous.get(uuid) === name) return previous;
            return new Map(previous).set(uuid, name);
          });
        };
        ydoc.on("update", read);
        const stopStatus = room.onStatusChange(read);
        read();
        stopReading = () => { stopStatus(); ydoc.off("update", read); };
      };
      bind(handle.connection);
      const stopReplacement = handle.onReplace?.(bind);
      return () => {
        stopReplacement?.();
        stopReading();
        handle.release();
      };
    });
    return () => { for (const stop of stops) stop(); };
  }, [localMenu, menuOpen, otherUuids, identity]);
  const currentReceived = currentUuid !== null && connection?.room === settingsRoom(currentUuid) && status.hasReceivedServerState;
  useEffect(() => {
    if (!currentReceived || currentUuid === null) return;
    setOtherNames(previous => previous.has(currentUuid) && previous.get(currentUuid) === currentName
      ? previous : new Map(previous).set(currentUuid, currentName));
  }, [currentReceived, currentUuid, currentName]);
  const names = new Map(recordedNames ?? []);
  for (const [uuid, name] of otherNames) names.set(uuid, name);
  if (currentUuid !== null && currentReceived) names.set(currentUuid, currentName);
  return names;
}

/** Only names already read from offered workspaces can establish a duplicate. */
export function workspaceLabel(
  workspace: Workspace,
  names: ReadonlyMap<string, string | null>,
  workspaces: readonly Workspace[],
): string {
  const name = names.get(workspace.uuid) ?? "Unnamed workspace";
  const duplicates = workspaces.filter((other) => names.has(other.uuid)
    && (names.get(other.uuid) ?? "Unnamed workspace") === name);
  if (!names.has(workspace.uuid) || duplicates.length < 2) return name;
  const shortId = workspace.uuid.slice(0, 8);
  const collisions = duplicates.filter((other) => other.uuid.slice(0, 8) === shortId);
  const suffix = collisions.length > 1 ? ` (${collisions.findIndex((other) => other.uuid === workspace.uuid) + 1})` : "";
  return `${name} · ${shortId}${suffix}`;
}

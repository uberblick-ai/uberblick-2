import { getWorkspaceMainRepository } from "@uberblick/schema";
import type { RoomConnection } from "../../collab/rooms.js";
import { useWorkspaceSetting } from "../workspace-setting.js";

export function useWorkspaceMainRepository(connection: RoomConnection | null): string | null {
  return useWorkspaceSetting(connection, getWorkspaceMainRepository);
}

import { useEffect, useState } from "react";
import { getWorkspaceMainRepository } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";

export function useWorkspaceMainRepository(connection: RoomConnection | null): string | null {
  const [reading, setReading] = useState<{
    connection: RoomConnection;
    repository: string | null;
  } | null>(null);
  useEffect(() => {
    if (connection === null) return;
    const read = (): void => setReading({ connection, repository: getWorkspaceMainRepository(connection.ydoc) });
    read();
    connection.ydoc.on("update", read);
    return () => connection.ydoc.off("update", read);
  }, [connection]);
  if (connection === null) return null;
  return reading?.connection === connection ? reading.repository : getWorkspaceMainRepository(connection.ydoc);
}

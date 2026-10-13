import { useEffect, useState } from "react";
import type { Doc } from "yjs";
import type { RoomConnection } from "../collab/rooms.js";

export function useWorkspaceSetting(
  connection: RoomConnection | null,
  read: (doc: Doc) => string | null,
): string | null {
  const [reading, setReading] = useState<{
    connection: RoomConnection;
    read: (doc: Doc) => string | null;
    value: string | null;
  } | null>(null);
  useEffect(() => {
    if (connection === null) return;
    const update = (): void => setReading({ connection, read, value: read(connection.ydoc) });
    update();
    connection.ydoc.on("update", update);
    return () => connection.ydoc.off("update", update);
  }, [connection, read]);
  if (connection === null) return null;
  return reading?.connection === connection && reading.read === read ? reading.value : read(connection.ydoc);
}

/** Live reads over the workspace-curated tag catalog. */

import { useEffect, useState } from "react";
import { isTagCatalogSeeded, listTagCatalog, migrateTagCatalog } from "@uberblick/schema";
import type { TagCatalogEntry } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";

export interface TagCatalogReading {
  connection: RoomConnection;
  entries: TagCatalogEntry[];
  seeded: boolean;
}

/** Read one catalog Y.Doc, updating for local and remote changes alike. */
export function useTagCatalog(
  connection: RoomConnection | null,
): TagCatalogReading | null {
  const [reading, setReading] = useState<TagCatalogReading | null>(null);
  useEffect(() => {
    if (connection === null) return;
    const read = (): void => {
      if (connection.status.synced && connection.status.hasReceivedServerState && connection.status.writable) {
        migrateTagCatalog(connection.ydoc);
      }
      setReading({
        connection,
        entries: listTagCatalog(connection.ydoc),
        seeded: isTagCatalogSeeded(connection.ydoc),
      });
    };
    read();
    connection.ydoc.on("update", read);
    const stop = connection.onStatusChange(read);
    return () => { connection.ydoc.off("update", read); stop(); };
  }, [connection]);
  if (connection === null) return null;
  return reading?.connection === connection
    ? reading
    : {
        connection,
        entries: listTagCatalog(connection.ydoc),
        seeded: isTagCatalogSeeded(connection.ydoc),
      };
}

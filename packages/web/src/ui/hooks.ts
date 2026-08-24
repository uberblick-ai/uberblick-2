/**
 * React glue. Yjs types are observable, so every view here is derived from an
 * observer rather than from local state — a remote change and a local change
 * take the same path to the screen.
 */

import { useCallback, useEffect, useState } from "react";
import * as Y from "yjs";
import {
  getBlocksFragment,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  listDirectory,
} from "@uberblick/schema";
import type { DirectoryEntry, DocMeta } from "@uberblick/schema";
import { acquireRoom } from "../collab/rooms.js";
import type { RoomConnection, RoomStatus } from "../collab/rooms.js";
import { AWARENESS_FALLBACK_COLOR } from "../collab/identity.js";
import type { AwarenessUser } from "../collab/identity.js";
import { findForeignBlocks } from "../editor/palette.js";
import type { ForeignBlock } from "../editor/palette.js";
import { blockText, plainText } from "../editor/ytext.js";
import { observeOutline } from "./outline.js";
import type { OutlineEntry } from "./outline.js";
import { observeThreads } from "./threads.js";
import type { ThreadView } from "./threads.js";

/** Acquire a shared room connection for as long as the component needs it. */
export function useRoom(
  room: string | null,
  identity: AwarenessUser,
): RoomConnection | null {
  const [connection, setConnection] = useState<RoomConnection | null>(null);
  useEffect(() => {
    if (room === null) {
      setConnection(null);
      return;
    }
    const handle = acquireRoom(room, identity);
    setConnection(handle.connection);
    return () => {
      setConnection(null);
      handle.release();
    };
  }, [room, identity]);
  return connection;
}

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
};

export function useRoomStatus(connection: RoomConnection | null): RoomStatus {
  const [status, setStatus] = useState<RoomStatus>(OFFLINE);
  useEffect(() => {
    if (connection === null) {
      setStatus(OFFLINE);
      return;
    }
    return connection.onStatusChange(setStatus);
  }, [connection]);
  return status;
}

/** Directory entries, live. Discovery is a synced doc, so this is just an observer. */
export function useDirectory(connection: RoomConnection | null): DirectoryEntry[] {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  useEffect(() => {
    if (connection === null) {
      setEntries([]);
      return;
    }
    const { ydoc } = connection;
    const map = getDirectoryMap(ydoc);
    const read = (): void => setEntries(listDirectory(ydoc));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [connection]);
  return entries;
}

export function useDocMeta(connection: RoomConnection | null): DocMeta | null {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  useEffect(() => {
    if (connection === null) {
      setMeta(null);
      return;
    }
    const { ydoc } = connection;
    const map = getMetaMap(ydoc);
    const read = (): void => setMeta(getMeta(ydoc));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [connection]);
  return meta;
}

/**
 * Top-level blocks the editor palette cannot render, live.
 *
 * This is the palette gate: while it is non-empty the app must not bind
 * ProseMirror to the fragment, because y-prosemirror deletes elements whose
 * node name its schema does not know. Observed (not read once) so a foreign
 * block arriving mid-session unbinds the editor instead of losing the block.
 *
 * Deep, not shallow: foreign content can arrive *inside* a known block (a nested
 * element, an undeclared mark), which a shallow observer never sees — and then
 * the guard would tear the editor down with nothing rendered in its place.
 */
export function useForeignBlocks(
  connection: RoomConnection | null,
): ForeignBlock[] {
  const [foreign, setForeign] = useState<ForeignBlock[]>([]);
  useEffect(() => {
    if (connection === null) {
      setForeign([]);
      return;
    }
    const fragment = getBlocksFragment(connection.ydoc);
    const read = (): void => setForeign(findForeignBlocks(fragment));
    read();
    fragment.observeDeep(read);
    return () => fragment.unobserveDeep(read);
  }, [connection]);
  return foreign;
}

/** A peer in the presence strip. `clientId` is its stable key: names collide. */
export interface Peer extends AwarenessUser {
  clientId: number;
}

/** Awareness states other than our own, for the presence strip. */
export function usePeers(connection: RoomConnection | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const awareness = connection?.provider.awareness ?? null;
    if (awareness === null) {
      setPeers([]);
      return;
    }
    const read = (): void => {
      const out: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: Partial<AwarenessUser> }).user;
        if (user === undefined) return;
        out.push({
          clientId,
          name: typeof user.name === "string" ? user.name : `client ${clientId}`,
          color: typeof user.color === "string" ? user.color : AWARENESS_FALLBACK_COLOR,
        });
      });
      setPeers(out);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [connection]);
  return peers;
}

/**
 * The plain-text rendering used by the read-only fallback when the palette gate
 * is closed. Deliberately does not go through `getBlocks()`, which reads an
 * unknown node name as a paragraph — the fallback exists to make the unknown
 * visible, not to normalise it away.
 */
export function useRawBlocks(
  connection: RoomConnection | null,
): Array<{ nodeName: string; id: string | null; text: string }> {
  const [blocks, setBlocks] = useState<
    Array<{ nodeName: string; id: string | null; text: string }>
  >([]);
  useEffect(() => {
    if (connection === null) {
      setBlocks([]);
      return;
    }
    const fragment = getBlocksFragment(connection.ydoc);
    const read = (): void => {
      setBlocks(
        fragment.toArray().map((child) => {
          if (!(child instanceof Y.XmlElement)) {
            return { nodeName: "#text", id: null, text: String(child) };
          }
          return {
            nodeName: child.nodeName,
            id: child.getAttribute("id") ?? null,
            text: plainText(blockText(child)),
          };
        }),
      );
    };
    read();
    fragment.observeDeep(read);
    return () => fragment.unobserveDeep(read);
  }, [connection]);
  return blocks;
}

/**
 * The open document's heading outline, live. Same shape as every other view
 * here: an observer over the document, not local state — so a heading a remote
 * client renames redraws the outline.
 */
export function useOutline(connection: RoomConnection | null): OutlineEntry[] {
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  useEffect(() => {
    if (connection === null) {
      setOutline([]);
      return;
    }
    return observeOutline(connection.ydoc, setOutline);
  }, [connection]);
  return outline;
}

/**
 * The open document's comment threads, live. Two observers under the hood (the
 * annotations map and the blocks fragment), so a thread an agent creates and a
 * range a human deletes both reach the rail the same way.
 */
export function useThreads(connection: RoomConnection | null): ThreadView[] {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  useEffect(() => {
    if (connection === null) {
      setThreads([]);
      return;
    }
    return observeThreads(connection.ydoc, setThreads);
  }, [connection]);
  return threads;
}

/**
 * A stable per-tab identity. `useState`'s lazy initializer, not `useMemo` with
 * an empty dependency list: React guarantees the initializer runs exactly once,
 * where a memo is free to recompute and would hand out a second identity.
 */
export function useIdentity(factory: () => AwarenessUser): AwarenessUser {
  const [identity] = useState(factory);
  return identity;
}

/**
 * A boolean that survives a reload. Storage can be unavailable (private
 * windows, blocked third-party contexts), and a UI preference is never worth an
 * exception, so both directions fall back to the in-memory value.
 */
export function useStoredFlag(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "true";
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Preference stays for this tab only.
      }
    },
    [key],
  );
  return [value, set];
}

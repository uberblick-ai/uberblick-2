/**
 * Derive shared views from Yjs observers so local and remote writes follow
 * the same rendering path.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import * as Y from "yjs";
import {
  decisionTopicArchived,
  getBlocksFragment,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  listDirectory,
  normalizeLegacyTables,
  repairDuplicateBlocks,
  tableText,
  readSidebar,
} from "@uberblick/schema";
import type { DirectoryEntry, DocMeta, SidebarGroup } from "@uberblick/schema";
import { acquireRoom } from "../collab/rooms.js";
import type { RoomConnection, RoomStatus } from "../collab/rooms.js";
import { resolveClientConfig } from "../config.js";
import { getSetting, subscribeSettings } from "../settings.js";
import type { Settings } from "../settings.js";
import { parseRemoteAwareness } from "../collab/remote-awareness.js";
import type { AwarenessUser } from "../collab/identity.js";
import type { Awareness } from "y-protocols/awareness";
import { agentCursorAwareness } from "../editor/collaboration.js";
import { findForeignBlocks, findLinkConflicts } from "../editor/palette.js";
import type { ForeignBlock, LinkConflict } from "../editor/palette.js";
import { blockText, plainText } from "../editor/ytext.js";
import { groupAgentPresence, observeDocRev, presenceKey, readPresence, samePresence } from "./doc-chrome.js";
import type { RemotePresence } from "./doc-chrome.js";
import { observeOutline } from "./outline.js";
import type { OutlineEntry } from "./outline.js";
import { observeThreads } from "./threads.js";
import type { ThreadView } from "./threads.js";

/**
 * Resolve configuration before acquiring any room: the first connect fixes
 * the shared socket endpoint and the same fetch supplies workspaces. Hub
 * release bundles have no endpoint fallback; invalid or absent endpoints keep
 * the gate closed instead of treating an empty URL as page origin.
 */
export function useHubEndpoint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void resolveClientConfig().then((config) => {
      if (live) setReady(config.hubUrl !== "");
    });
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/**
 * Acquire a refcounted connection only for the requested room. Return null
 * during the effect lag on a room change so stale content and writes never
 * target the old Y.Doc.
 */
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
  return connection !== null && connection.room === room ? connection : null;
}

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  hasReceivedServerState: false,
  hasAnswered: false,
  writable: false,
  storeRefused: false,
  unsyncedChanges: 0,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

/** A status snapshot and the exact connection that supplied it. */
interface RoomStatusReading {
  connection: RoomConnection;
  status: RoomStatus;
}

/**
 * Use the current connection's seed before subscribing, and pair later
 * snapshots with their source. Directory consumers use OFFLINE without a
 * connection; document surfaces suppress it until their room has a reading.
 */
export function useRoomStatus(connection: RoomConnection | null): RoomStatus {
  const [reading, setReading] = useState<RoomStatusReading | null>(null);
  useEffect(() => {
    if (connection === null) return;
    return connection.onStatusChange((status) => setReading({ connection, status }));
  }, [connection]);
  if (connection === null) return OFFLINE;
  return reading?.connection === connection ? reading.status : connection.status;
}

/** Stable empty lists while a connection has not supplied a reading. */
const EMPTY_ARRAY: never[] = [];

type ConnectionObserver<T> = (
  connection: RoomConnection,
  emit: (value: T) => void,
) => () => void;

/**
 * Keep a subscription's reading paired with its exact source. State lags a
 * changed connection by one effect, so even a direct replacement (including
 * the same room on a new provider) returns the empty value on its first render.
 * The observer is part of the source too: directory filtering can change it.
 */
function useConnectionReading<T>(
  connection: RoomConnection | null,
  empty: T,
  observe: ConnectionObserver<T>,
  same: (previous: T, next: T) => boolean = Object.is,
): [T, (value: T) => void] {
  const [stored, setStored] = useState<{
    connection: RoomConnection;
    observe: ConnectionObserver<T>;
    value: T;
  } | null>(null);
  const emit = useCallback(
    (value: T): void => {
      if (connection === null) return;
      setStored((previous) =>
        previous?.connection === connection &&
        previous.observe === observe &&
        same(previous.value, value)
          ? previous
          : { connection, observe, value },
      );
    },
    [connection, observe, same],
  );
  useEffect(() => {
    if (connection === null) {
      setStored(null);
      return;
    }
    return observe(connection, emit);
  }, [connection, observe, emit]);
  return [
    stored !== null &&
    stored.connection === connection &&
    stored.observe === observe
      ? stored.value
      : empty,
    emit,
  ];
}

/**
 * Omit tombstones from ordinary listings; UUID-based pinned readers include
 * them to retain archived titles. Entries carry deleted for rendering.
 */
export function useDirectory(
  connection: RoomConnection | null,
  includeDeleted = false,
): DirectoryEntry[] {
  const observe = useCallback((current: RoomConnection, emit: (value: DirectoryEntry[]) => void) => {
    const { ydoc } = current;
    const map = getDirectoryMap(ydoc);
    const read = (): void => emit(listDirectory(ydoc, { includeDeleted }).map(
      (entry) => entry.kind === "decision"
        ? { ...entry, deleted: decisionTopicArchived(ydoc, entry.uuid) }
        : entry,
    ));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [includeDeleted]);
  return useConnectionReading(connection, EMPTY_ARRAY, observe)[0];
}

/**
 * Observe the whole sidebar document: groups add nested pin arrays
 * dynamically, so per-type listeners would miss remotely created groups. The
 * update event covers all its shared types.
 */
export function useSidebar(connection: RoomConnection | null): SidebarGroup[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observeSidebar)[0];
}

function observeSidebar(
  connection: RoomConnection,
  emit: (value: SidebarGroup[]) => void,
): () => void {
  const { ydoc } = connection;
  const read = (): void => emit(readSidebar(ydoc));
  read();
  ydoc.on("update", read);
  return () => ydoc.off("update", read);
}

/**
 * Decisions use only their topic's first-record directory tombstone, including
 * partial writes; other documents use their own. Unknown UUIDs are not archived.
 * Read synchronously during render with useSyncExternalStore so an archive
 * never paints an editable first frame or route-switch frame.
 */
export function useArchived(
  directory: RoomConnection | null,
  uuid: string | null,
): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (directory === null) return () => {};
      const map = getDirectoryMap(directory.ydoc);
      map.observe(onChange);
      return () => map.unobserve(onChange);
    },
    [directory],
  );
  const read = useCallback(() => {
    if (directory === null || uuid === null) return false;
    return decisionTopicArchived(directory.ydoc, uuid);
  }, [directory, uuid]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * Null means unread, while empty DocMeta means an answered room lacks this
 * document. Return null on every new connection, including direct
 * replacements, so stale titles never appear under a new address.
 */
export function useDocMeta(connection: RoomConnection | null): DocMeta | null {
  return useConnectionReading<DocMeta | null>(connection, null, observeDocMeta)[0];
}

function observeDocMeta(
  connection: RoomConnection,
  emit: (value: DocMeta | null) => void,
): () => void {
  const { ydoc } = connection;
  const map = getMetaMap(ydoc);
  const read = (): void => emit(getMeta(ydoc));
  read();
  map.observe(read);
  return () => map.unobserve(read);
}

/**
 * Observe foreign content deeply, including nested elements and marks. Never
 * bind while the palette gate is nonempty: y-prosemirror deletes unknown
 * nodes. Mid-session arrivals must unbind and render the fallback.
 */
export function useForeignBlocks(
  connection: RoomConnection | null,
): ForeignBlock[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observeForeignBlocks)[0];
}

function observeForeignBlocks(
  connection: RoomConnection,
  emit: (value: ForeignBlock[]) => void,
): () => void {
  const fragment = getBlocksFragment(connection.ydoc);
  const read = (): void => {
    if (connection.status.writable && connection.status.synced) {
      repairDuplicateBlocks(connection.ydoc);
      normalizeLegacyTables(connection.ydoc);
    }
    emit(findForeignBlocks(fragment));
  };
  read();
  fragment.observeDeep(read);
  const stopStatus = connection.onStatusChange(read);
  return () => { fragment.unobserveDeep(read); stopStatus(); };
}

/**
 * Scan conflicts separately: the palette gate stops at one reason per block
 * and may hide a later conflict. Observe deeply; refresh after a refused
 * repair because live state can change in the click's task.
 */
export function useLinkConflicts(connection: RoomConnection | null): {
  conflicts: LinkConflict[];
  refresh: () => void;
} {
  const [conflicts, emit] = useConnectionReading(
    connection, EMPTY_ARRAY, observeLinkConflicts,
  );
  const refresh = useCallback((): void => {
    if (connection !== null) {
      emit(findLinkConflicts(getBlocksFragment(connection.ydoc)));
    }
  }, [connection, emit]);
  return { conflicts, refresh };
}

function observeLinkConflicts(
  connection: RoomConnection,
  emit: (value: LinkConflict[]) => void,
): () => void {
  const fragment = getBlocksFragment(connection.ydoc);
  const read = (): void => emit(findLinkConflicts(fragment));
  read();
  fragment.observeDeep(read);
  return () => fragment.unobserveDeep(read);
}

/** A mention candidate. `clientId` distinguishes peers whose names collide. */
export interface Peer {
  clientId: number;
  name: string;
}

/** Only the identity and name matter to the editor's mention candidates. */
function samePeerNames(previous: Peer[], next: Peer[]): boolean {
  if (previous.length !== next.length) return false;
  const names = new Map(next.map((peer) => [peer.clientId, peer.name]));
  return previous.every((peer) => names.get(peer.clientId) === peer.name);
}

/** Awareness names other than our own, stable through caret/colour changes. */
export function usePeers(connection: RoomConnection | null): Peer[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observePeers, samePeerNames)[0];
}

function observePeers(
  connection: RoomConnection,
  emit: (value: Peer[]) => void,
): () => void {
  const awareness = connection.provider.awareness ?? null;
  if (awareness === null) return () => {};
  const read = (): void => {
    const out: Peer[] = [];
    awareness.getStates().forEach((state, clientId) => {
      const peer = parseRemoteAwareness(awareness, clientId, state);
      if (peer === null || !peer.hasUser) return;
      out.push({ clientId, name: peer.name });
    });
    emit(out);
  };
  read();
  awareness.on("change", read);
  return () => awareness.off("change", read);
}

/**
 * Count agents only when awareness publishes both user and AGENT_CLIENT.
 * Marker absence cannot infer an agent; unset connectivity probes count
 * nobody. Read workspace totals in the directory room, which every session
 * joins.
 */
export function useAgentSessions(connection: RoomConnection | null): number {
  return useConnectionReading(connection, 0, observeAgentSessions)[0];
}

function observeAgentSessions(
  connection: RoomConnection,
  emit: (value: number) => void,
): () => void {
  const awareness = connection.provider.awareness ?? null;
  if (awareness === null) return () => {};
  const read = (): void => {
    let agents = 0;
    awareness.getStates().forEach((state, clientId) => {
      const peer = parseRemoteAwareness(awareness, clientId, state);
      if (peer?.hasUser && peer.kind === "agent") agents += 1;
    });
    emit(agents);
  };
  read();
  awareness.on("change", read);
  return () => awareness.off("change", read);
}

/** Nobody else here. One frozen instance, so an empty room never re-renders. */
const NOBODY: readonly RemotePresence[] = [];

/**
 * Return only this connection's live roster; compare visible fields before
 * storing to avoid redraws for equivalent awareness changes. Observe caret
 * awareness and shallow fragment shape: inserting blocks renumbers stationary
 * carets, while text edits do not.
 */
export function usePresence(
  connection: RoomConnection | null,
): readonly RemotePresence[] {
  return useConnectionReading(connection, NOBODY, observePresence, samePresence)[0];
}

/** The title roster, including agents whose named cursor is in departure grace. */
export function useTitlePresence(
  connection: RoomConnection | null,
): readonly RemotePresence[] {
  return useConnectionReading(connection, NOBODY, observeTitlePresence, samePresence)[0];
}

function observePresence(
  connection: RoomConnection,
  emit: (value: readonly RemotePresence[]) => void,
): () => void {
  const awareness = connection.provider.awareness ?? null;
  if (awareness === null) return () => {};
  return observeRoomPresence(connection, awareness, emit);
}

function observeTitlePresence(
  connection: RoomConnection,
  emit: (value: readonly RemotePresence[]) => void,
): () => void {
  const awareness = connection.provider.awareness ?? null;
  if (awareness === null) return () => {};
  const view = agentCursorAwareness(awareness);
  const order = new Map<string, number>();
  return observeRoomPresence(connection, view, (presence) => {
    const grouped = groupAgentPresence(presence);
    const keys = new Set(grouped.map(presenceKey));
    for (const key of order.keys()) {
      if (!keys.has(key)) order.delete(key);
    }
    for (const peer of grouped) {
      const key = presenceKey(peer);
      if (!order.has(key)) order.set(key, peer.clientId);
    }
    // Keep a session's first position until its live and retained states vanish.
    grouped.sort((a, b) =>
      (order.get(presenceKey(a)) ?? a.clientId) -
      (order.get(presenceKey(b)) ?? b.clientId)
    );
    emit(grouped);
  }, view.isDeparted);
}

function observeRoomPresence(
  connection: RoomConnection,
  awareness: Awareness,
  emit: (value: readonly RemotePresence[]) => void,
  isDeparted?: (clientId: number) => boolean,
): () => void {
  const fragment = getBlocksFragment(connection.ydoc);
  const read = (): void => emit(readPresence(connection.ydoc, awareness, isDeparted));
  // Subscribe before reading: this seeds the shared view with live cursors.
  awareness.on("change", read);
  read();
  fragment.observe(read);
  return () => {
    awareness.off("change", read);
    fragment.unobserve(read);
  };
}

/**
 * Subscribe to the per-block revision cache; each keystroke must not reread
 * and rehash the whole document for eight characters of chrome.
 */
export function useDocRev(connection: RoomConnection | null): string | null {
  return useConnectionReading<string | null>(
    connection, null, observeConnectionDocRev,
  )[0];
}

function observeConnectionDocRev(
  connection: RoomConnection,
  emit: (value: string | null) => void,
): () => void {
  return observeDocRev(connection.ydoc, emit);
}

type RawBlock = { nodeName: string; id: string | null; text: string };

/**
 * Read raw blocks for the fallback: getBlocks normalizes unknown names to
 * paragraphs and would hide the content this screen must expose.
 */
export function useRawBlocks(connection: RoomConnection | null): RawBlock[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observeRawBlocks)[0];
}

function observeRawBlocks(
  connection: RoomConnection,
  emit: (value: RawBlock[]) => void,
): () => void {
  const fragment = getBlocksFragment(connection.ydoc);
  const read = (): void => emit(fragment.toArray().map((child) => {
    if (!(child instanceof Y.XmlElement)) {
      return { nodeName: "#text", id: null, text: String(child) };
    }
    return {
      nodeName: child.nodeName,
      id: child.getAttribute("id") ?? null,
      text: child.nodeName === "table" && child.firstChild instanceof Y.XmlElement ? tableText(child) : plainText(blockText(child)),
    };
  }));
  read();
  fragment.observeDeep(read);
  return () => fragment.unobserveDeep(read);
}

/** Observe heading blocks so remote renames update the outline. */
export function useOutline(connection: RoomConnection | null): OutlineEntry[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observeConnectionOutline)[0];
}

function observeConnectionOutline(
  connection: RoomConnection,
  emit: (value: OutlineEntry[]) => void,
): () => void {
  return observeOutline(connection.ydoc, emit);
}

/**
 * Observe annotations and blocks together so remote thread creation and range
 * deletion both update the rail.
 */
export function useThreads(connection: RoomConnection | null): ThreadView[] {
  return useConnectionReading(connection, EMPTY_ARRAY, observeConnectionThreads)[0];
}

function observeConnectionThreads(
  connection: RoomConnection,
  emit: (value: ThreadView[]) => void,
): () => void {
  return observeThreads(connection.ydoc, emit);
}

/**
 * Use a lazy useState initializer for one per-tab identity; useMemo may
 * recompute and create a second identity. Configuration can later supply the
 * served name.
 */
export function useIdentity(factory: () => AwarenessUser, defaultName: string | null = null): AwarenessUser {
  const [identity] = useState(factory);
  return useMemo(() => defaultName === null ? identity : { ...identity, name: defaultName }, [identity, defaultName]);
}

/**
 * Unavailable browser storage keeps this UI preference in memory; neither
 * read nor write may throw.
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

/**
 * Subscribe to the settings module so every reader sees the same string-or-
 * null value without another cache.
 */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  const read = useCallback(() => getSetting(key), [key]);
  return useSyncExternalStore(subscribeSettings, read, read);
}

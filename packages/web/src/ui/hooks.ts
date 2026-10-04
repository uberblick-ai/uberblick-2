/**
 * React glue. Yjs types are observable, so every view here is derived from an
 * observer rather than from local state — a remote change and a local change
 * take the same path to the screen.
 */

import {
  useCallback,
  useEffect,
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
import { findForeignBlocks, findLinkConflicts } from "../editor/palette.js";
import type { ForeignBlock, LinkConflict } from "../editor/palette.js";
import { blockText, plainText } from "../editor/ytext.js";
import { observeDocRev, readPresence, samePresence } from "./doc-chrome.js";
import type { RemotePresence } from "./doc-chrome.js";
import { observeOutline } from "./outline.js";
import type { OutlineEntry } from "./outline.js";
import { observeThreads } from "./threads.js";
import type { ThreadView } from "./threads.js";

/**
 * Whether the client configuration — the hub endpoint and the workspaces — is
 * known yet.
 *
 * The gate every `useRoom` call sits behind. Resolution is one same-origin
 * `fetch`, so it does not hold up the render — but it must hold up the first
 * *connect*: a room acquired before it settles dials whatever the fallback is
 * and stays there for the session, since the shared socket is built once. It
 * also gates the *workspaces*, which come out of the same read: they say which
 * rooms there are to join at all.
 *
 * Development/client fallbacks become ready after resolution. Hub release
 * bundles have no endpoint fallback: an absent or invalid served endpoint
 * keeps this gate closed, so WebSocket never interprets an empty URL as the
 * page's own origin.
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
 * Acquire a shared room connection for as long as the component needs it.
 *
 * Never returns a connection to a room other than the one asked for. That is
 * not a nicety: `connection` is state, so it lags `room` by one effect, and on
 * the render right after the caller changes rooms it still holds the previous
 * one. Handing that back would let a caller render the document it just
 * navigated away from — its editor, its outline, its threads — under the new
 * document's address, and would aim a write at the wrong Y.Doc. Callers see
 * `null` for that single render and show their own not-ready state instead.
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
 * The current connection's status, never a snapshot retained from another one.
 *
 * A connection already carries a seeded status and immediately supplies it to
 * a subscriber. Returning that seed on the render before the effect subscribes
 * avoids inventing an `offline` transition, while pairing later snapshots with
 * their source keeps a room or replacement connection from inheriting its
 * predecessor's reading.
 *
 * `OFFLINE` remains the no-connection answer for directory-level consumers.
 * Document status surfaces suppress that value while their requested room has
 * no connection, so an absent reading occupies its fixed slot without making a
 * claim (#606).
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
 * Directory entries, live. Discovery is a synced doc, so this is just an
 * observer.
 *
 * Tombstoned stubs are left out by default, because the listings this feeds are
 * about the documents the workspace *has*. A reader that names documents by
 * uuid rather than by listing them — the sidebar's pins — asks for them
 * instead: it has to say what an archived pin is called, and a stub filtered
 * out of the reading is a title it cannot see (#287). Entries carry `deleted`,
 * so the two are told apart at the point of rendering.
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
 * The sidebar's groups and their pinned uuids, live — the `_sidebar` doc as
 * `readSidebar` reports it (#115).
 *
 * Subscribed on the *document* rather than on a type, which is the one place
 * here that does that. The sidebar's state is spread over three top-level types
 * and one nested array per group (see `packages/schema/src/sidebar.ts`), so a
 * per-type observer would have to be torn down and rebuilt every time a group
 * was created — and a group created remotely would arrive with nobody watching
 * its pins. The doc's `update` event covers all of it, local and remote alike,
 * and the read behind it is a walk over a handful of uuids.
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
 * Whether the directory archives this document, live. For decisions, only the
 * topic's first-record tombstone has authority, including partial writes.
 *
 * The directory stub is the source of the archived flag — the document itself
 * holds no such state — so this reads the same entry `list_docs` and
 * `archive_doc` read, over the same observer every other view here uses. That
 * is what makes the transition live in both directions: a doc archived from an
 * agent or from another tab flips this without a reload, and so does a restore.
 *
 * A uuid the directory has never seen is not archived. Silence is not a
 * tombstone: an unsynced deep link resolves into itself when it arrives, and
 * calling it archived in the meantime would offer Restore for a document
 * nobody deleted.
 *
 * `useSyncExternalStore` rather than the state-and-effect shape the hooks
 * around it use, and the difference is the whole point: those hold values that
 * may lag by a render harmlessly, while this one gates whether the pane will
 * take a write. Read into state, the first render of a deep link to an archived
 * document — and every route switch from a live one — would say "not archived"
 * until a passive effect corrected it, which is a committed, painted frame with
 * an editable title and an editable editor on screen. The snapshot is read
 * during render instead, so read-only is true from the first one.
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
 * The open document's metadata, live — or null while none has been *read yet*.
 *
 * Null is "not known", never "empty": a room that has genuinely answered with
 * nothing in it reads as a `DocMeta` whose `uuid` is `""`. Callers depend on
 * that difference to tell "this replica has not answered about this address
 * yet" from "it has answered, and the document is not here" — the second earns
 * a waiting screen, the first earns silence (see `RoutePane`).
 *
 * The shared connection guard returns null before reading any new connection,
 * including a direct replacement without null between. A previous document's
 * title can never appear under the new document's address.
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
 * The conflicting link ranges the fallback offers a repair for, live.
 *
 * A second scan beside {@link useForeignBlocks}, not a slice of it: the gate
 * reports one reason per block and stops, so a conflict standing behind another
 * foreign reason in the same block never reaches that list (`palette.ts` says
 * why). Observed deep for the same reason the gate is — a remote replica can
 * repair or create one of these under an open pane.
 *
 * `refresh` is what an activation that wrote nothing calls: the write is a
 * no-op precisely when live state has moved, and the offered list has to say so
 * even when the move arrived in the same tick as the click.
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
 * How many agent sessions are in this room right now (#74).
 *
 * A **conjunction, and a positive one** (#494): a session counts only where it
 * publishes both a `user` and the agent marker an MCP session stamps its
 * presence with (`AGENT_CLIENT`, `mcp-server/src/replica.ts`). Neither half is
 * redundant.
 *
 * The marker is what makes this a claim rather than an inference. Until #494
 * this was an *absence* test — "not a web client, therefore an agent" — which
 * counted a browser tab running a bundle from before #267 as an MCP connection
 * until that tab reloaded. The remaining skew runs the other way and shrinks
 * rather than grows: an agent on a build from before the marker is now not
 * counted, until that server restarts.
 *
 * A state with no `user` is nobody: the MCP server's connectivity probe opens
 * rooms with its awareness deliberately unset, and it must not read as a
 * session (see `mcp-server/src/remote.ts`). The marker is withdrawn with the
 * `user` it belongs to, so a leftover cannot answer for a presence that ended.
 *
 * The room to ask is the workspace's directory — every session joins it, agents
 * included, whatever document it is working on.
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
 * Every remote session in the room, live.
 *
 * Read once by the shell and handed down: the document status line and sync
 * panel are two views of this one snapshot, so there is one subscription
 * rather than one per reader.
 *
 * Never returns a reading made in another room — `useRoom`'s guard, for the
 * same reason: the stored reading is state, so it lags `connection` by one
 * effect, and the shell reads over `doc ?? directory`. Without the check, the
 * first painted frame after a document opens would draw the directory's roster
 * — every session in the workspace — as this document's. Callers see `NOBODY`
 * for that single render instead.
 *
 * The reading is compared before it is stored, and that is the point rather
 * than an optimisation: awareness fires `change` on every caret movement, so a
 * peer typing a sentence produces dozens of readings that all say the same
 * thing. Storing them by identity would redraw the panel once per keystroke.
 *
 * Two subscriptions, because each entry names a block *number* and there are
 * two ways for that number to become wrong: the caret moves, or blocks are
 * inserted or removed above a caret that has not moved at all. The second
 * observer is shallow on purpose — it is the fragment's *shape* that renumbers
 * blocks, and a deep one would re-read every awareness state on every keystroke
 * in the document to learn nothing.
 */
export function usePresence(
  connection: RoomConnection | null,
): readonly RemotePresence[] {
  return useConnectionReading(connection, NOBODY, observePresence, samePresence)[0];
}

function observePresence(
  connection: RoomConnection,
  emit: (value: readonly RemotePresence[]) => void,
): () => void {
  const awareness = connection.provider.awareness ?? null;
  if (awareness === null) return () => {};
  const fragment = getBlocksFragment(connection.ydoc);
  const read = (): void => emit(readPresence(connection.ydoc, awareness));
  read();
  awareness.on("change", read);
  fragment.observe(read);
  return () => {
    awareness.off("change", read);
    fragment.unobserve(read);
  };
}

/**
 * The open document's rev, live — or null while there is no document.
 *
 * The derivation keeps its own per-block cache (`observeDocRev`), so this is a
 * subscription rather than a read-on-every-change: eight characters of chrome
 * must not cost a re-read of the document per keystroke.
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
 * The plain-text rendering used by the read-only fallback when the palette gate
 * is closed. Deliberately does not go through `getBlocks()`, which reads an
 * unknown node name as a paragraph — the fallback exists to make the unknown
 * visible, not to normalise it away.
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

/**
 * The open document's heading outline, live. Same shape as every other view
 * here: an observer over the document, not local state — so a heading a remote
 * client renames redraws the outline.
 */
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
 * The open document's comment threads, live. Two observers under the hood (the
 * annotations map and the blocks fragment), so a thread an agent creates and a
 * range a human deletes both reach the rail the same way.
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

/**
 * One local setting, live: the value now, and a re-render when it changes.
 *
 * `useSyncExternalStore` over the settings module's own subscription, so the
 * dialog that wrote a value and any other reader of it are looking at one
 * source. Every field is a string or null, so the snapshot compares by value
 * and there is no cache to keep — see settings.ts.
 */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  const read = useCallback(() => getSetting(key), [key]);
  return useSyncExternalStore(subscribeSettings, read, read);
}

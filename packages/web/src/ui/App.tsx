/**
 * The app shell. Two rooms at a time: the workspace directory, and whichever
 * document is open.
 *
 * Which document that is comes from the address bar and nowhere else (#68) —
 * see route.ts. The sidebar, Back/Forward and a pasted link are then the same
 * gesture, and there is no second copy of the selection to drift out of step
 * with the URL.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  appendBlock,
  directoryRoom,
  getMeta,
  getMetaMap,
  initDoc,
  restoreDirectoryEntry,
  roomForDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import { CONFIGURED_WORKSPACE } from "../config.js";
import { acquireRoom } from "../collab/rooms.js";
import { randomIdentity } from "../collab/identity.js";
import type { RoomConnection } from "../collab/rooms.js";
import { DocList } from "./DocList.js";
import { EditorPane, PaneNotice, StatusLine } from "./EditorPane.js";
import { OutlinePane } from "./OutlinePane.js";
import { ThreadsPane } from "./ThreadsPane.js";
import { focusThread } from "./threads.js";
import type { ThreadFocus } from "./threads.js";
import {
  canonicalPath,
  docIsHydrated,
  docPath,
  parseRoute,
  replicaHasAnswered,
  useRoutePath,
} from "./route.js";
import type { Route } from "./route.js";
import {
  useArchived,
  useDirectory,
  useDocMeta,
  useHubEndpoint,
  useIdentity,
  useRoom,
  useRoomStatus,
  useStoredFlag,
} from "./hooks.js";

/** Sidebar preference, persisted per browser. */
const SIDEBAR_COLLAPSED_KEY = "uberblick.sidebar.collapsed";

/**
 * What the address resolves to on screen.
 *
 * The three non-document branches are states, never errors to be swallowed: a
 * link is worth telling the truth about. A well-formed uuid this replica has
 * not seen is explicitly *not* one of them — it is a document that has not
 * arrived, and it resolves into itself when it does.
 */
export function RoutePane({
  route,
  connection,
  meta,
  author,
  archived,
  onRestore,
  onSelectThread,
}: {
  route: Route;
  /**
   * The connection to the room `route` names, or null while there is none —
   * `useRoom` withholds a connection that belongs to a different room, so this
   * is null for one render after the address changes.
   */
  connection: RoomConnection | null;
  /**
   * That room's metadata, or null while it has not been read yet. The
   * difference carries a decision: unread is silence, read-and-not-this-document
   * is the waiting screen — and an *empty* meta is only the second of those once
   * the room's local replica has been applied. See {@link replicaHasAnswered}.
   */
  meta: DocMeta | null;
  author: string;
  /** Whether the directory tombstones this document — see `useArchived`. */
  archived: boolean;
  /** Lift that tombstone. The only action an archived document offers. */
  onRestore: () => void;
  onSelectThread: (threadId: string) => void;
}): ReactElement {
  // Before the branches: a hook may not sit behind an early return. Only
  // `localReplicaLoaded` is read here — it is what tells the empty document a
  // freshly opened room holds apart from an answer that the document is absent.
  const { localReplicaLoaded } = useRoomStatus(connection);

  if (route.kind === "no-workspace") {
    return (
      <PaneNotice>
        <p className="ub-notice">
          <strong>No workspace.</strong> This address names none, and this client
          was built without one to fall back to. Open a document link — they look
          like <code>/&lt;workspace&gt;/&lt;uuid&gt;</code> — or run{" "}
          <code>ub status</code> to find your workspace id.
        </p>
      </PaneNotice>
    );
  }

  if (route.kind === "invalid") {
    return (
      <PaneNotice>
        <p className="ub-notice">
          <strong>Not a document link.</strong> {route.reason} A document link
          looks like <code>/&lt;workspace&gt;/&lt;uuid&gt;</code>.
        </p>
      </PaneNotice>
    );
  }

  if (route.kind === "doc") {
    // Nothing is known about this address yet: the room has not been joined, or
    // it has but nothing has been read out of it — no metadata at all, or the
    // empty metadata of a replica that is still being loaded. All of those last
    // a render or two, and all keep the frame while saying nothing. Drawing
    // "waiting for sync" from ignorance would flash those words across the pane
    // every time a reader moves between two documents they already have.
    if (connection === null || !replicaHasAnswered(meta, localReplicaLoaded)) {
      return <PaneNotice>{null}</PaneNotice>;
    }

    if (!docIsHydrated(route.uuid, meta)) {
      return (
        <PaneNotice>
          {/* The live sync state, so a link that is waiting says what it is
              waiting on rather than looking stuck. */}
          <StatusLine connection={connection} segment={route.workspace.segment} />
          <p className="ub-notice">
            <strong>Waiting for sync.</strong> Document <code>{route.uuid}</code>{" "}
            has not reached this replica yet. It opens here as soon as it arrives.
          </p>
        </PaneNotice>
      );
    }
  }

  return (
    <EditorPane
      connection={connection}
      // Only `list` and `doc` reach here; both carry the workspace the address
      // spelled, which is what a copied link has to keep.
      segment={route.workspace.segment}
      author={author}
      archived={archived}
      onRestore={onRestore}
      onSelectThread={onSelectThread}
    />
  );
}

export function App(): ReactElement {
  const identity = useIdentity(randomIdentity);
  const [path, navigate] = useRoutePath();
  const route = parseRoute(path, CONFIGURED_WORKSPACE);
  // The address names the workspace — this client is configured for none and
  // cannot enumerate them. Null only where the address named none it could use,
  // and then there are no rooms to join at all.
  const workspace = route.kind === "no-workspace" ? null : route.workspace;
  const selected = route.kind === "doc" ? route.uuid : null;
  const [collapsed, setCollapsed] = useStoredFlag(SIDEBAR_COLLAPSED_KEY, false);
  /**
   * The thread the reader is looking at. It lives here because the two ends of
   * the link are in different panes: a highlight in the editor and a card in the
   * rail focus each other through this one value.
   */
  const [focusedThread, setFocusedThread] = useState<ThreadFocus | null>(null);
  const onFocusThread = useCallback((threadId: string) => {
    setFocusedThread((previous) => focusThread(previous, threadId));
  }, []);

  // No room before the hub endpoint is known (#91): the shared websocket is
  // built from the first room acquired, so one acquired early would pin the
  // session to the build-time fallback.
  const hubReady = useHubEndpoint();
  const directory = useRoom(
    hubReady && workspace !== null ? directoryRoom(workspace.uuid) : null,
    identity,
  );
  const doc = useRoom(
    hubReady && workspace !== null && selected !== null
      ? roomForDoc(workspace.uuid, selected)
      : null,
    identity,
  );
  const entries = useDirectory(directory);
  const meta = useDocMeta(doc);
  const archived = useArchived(directory, selected);

  /**
   * Lift the tombstone — the same schema call `restore_doc` makes, against the
   * same directory document, so a restore from here and a restore from an agent
   * are one operation with two front doors.
   */
  const onRestore = useCallback(() => {
    if (directory === null || selected === null) return;
    restoreDirectoryEntry(directory.ydoc, selected);
  }, [directory, selected]);

  /**
   * Normalise the address to the one form the app hands out: `/` becomes the
   * build's workspace, a trailing slash or a shouted uuid becomes the canonical
   * spelling. The workspace segment itself is left exactly as typed — the slug
   * is display, and rewriting somebody's spelling of their own workspace is a
   * later question (#160 leaves it alone deliberately). `replace`, never
   * `push` — a redirect the reader did not ask for must not become a history
   * entry that Back bounces off.
   */
  useEffect(() => {
    const canonical = canonicalPath(parseRoute(path, CONFIGURED_WORKSPACE));
    if (canonical !== null && canonical !== path) navigate(canonical, "replace");
  }, [path, navigate]);

  /** Opening a document is navigating to it. There is nothing else to update. */
  const segment = workspace?.segment ?? null;
  const onSelect = useCallback(
    (uuid: string) => {
      if (segment !== null) navigate(docPath(segment, uuid));
    },
    [navigate, segment],
  );

  /**
   * A create needs the new document's Y.Doc *before* React has mounted the
   * editor pane for it, so the handle is held here until `useRoom` has acquired
   * the same room. Room connections are refcounted and keyed by room name, so
   * this handle and the pane's are the same connection — and handing over as
   * soon as the pane has it is what keeps navigating away from actually closing
   * the connection instead of leaving it publishing stale awareness.
   */
  const pending = useRef<{ room: string; release: () => void } | null>(null);
  useEffect(() => () => pending.current?.release(), []);

  useEffect(() => {
    const held = pending.current;
    if (held === null || doc === null || doc.room !== held.room) return;
    pending.current = null;
    held.release();
  }, [doc]);

  const onCreate = useCallback(() => {
    if (directory === null || workspace === null) return;
    const uuid = crypto.randomUUID();
    const room = roomForDoc(workspace.uuid, uuid);
    const handle = acquireRoom(room, identity);
    initDoc(handle.connection.ydoc, { uuid, title: "" });
    // A document with no blocks has nowhere to put the caret, so seed one.
    appendBlock(handle.connection.ydoc, { type: "paragraph", text: "" });
    upsertDirectoryEntry(directory.ydoc, { uuid, title: "" });
    pending.current?.release();
    pending.current = { room, release: handle.release };
    onSelect(uuid);
  }, [directory, identity, onSelect, workspace]);

  /**
   * The directory stub is a cache; `meta.title` in the document is
   * authoritative. Repair the stub whenever the open document's title changes,
   * which is the "repaired on write/connect" half of that invariant.
   */
  useEffect(() => {
    if (doc === null || directory === null) return;
    const meta = getMetaMap(doc.ydoc);
    const repair = (): void => {
      const current = getMeta(doc.ydoc);
      if (current.uuid === "") return;
      upsertDirectoryEntry(directory.ydoc, {
        uuid: current.uuid,
        title: current.title,
        tags: current.tags,
      });
    };
    repair();
    meta.observe(repair);
    return () => meta.unobserve(repair);
  }, [doc, directory]);

  return (
    <main className="ub-app">
      <header className="ub-header">
        {/* Lives in the header so it stays visible while the sidebar is gone. */}
        <button
          type="button"
          className="ub-sidebar-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show document list" : "Hide document list"}
          title={collapsed ? "Show document list" : "Hide document list"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? "»" : "«"}
        </button>
        <span className="ub-brand">uberblick</span>
        {/* As the address spells it: the slug is what a person reads. */}
        <span className="ub-muted">
          {workspace === null ? "no workspace" : `workspace ${workspace.segment}`}
        </span>
        <span className="ub-me" style={{ borderColor: identity.color }}>
          {identity.name}
        </span>
      </header>
      <div className="ub-body">
        {!collapsed && (
          <DocList
            connection={directory}
            entries={entries}
            selected={selected}
            onSelect={onSelect}
            onCreate={onCreate}
          />
        )}
        <RoutePane
          route={route}
          connection={doc}
          meta={meta}
          author={identity.name}
          archived={archived}
          onRestore={onRestore}
          onSelectThread={onFocusThread}
        />
        {/* The outline and the threads rail stack in one right column. Both
            sections render nothing when they have nothing to show, so the rail
            hides itself when it is empty (`.ub-rail:empty`) rather than leaving
            a blank gutter. */}
        <aside className="ub-rail">
          <OutlinePane connection={doc} />
          <ThreadsPane
            connection={doc}
            focused={focusedThread}
            author={identity.name}
            readOnly={archived}
            onFocus={onFocusThread}
          />
        </aside>
      </div>
    </main>
  );
}

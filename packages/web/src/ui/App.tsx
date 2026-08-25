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
  roomForDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { WORKSPACE } from "../config.js";
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
  docIsPresent,
  docPath,
  parseRoute,
  useRoutePath,
} from "./route.js";
import type { Route } from "./route.js";
import {
  useDirectory,
  useDocMeta,
  useIdentity,
  useRoom,
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
  present,
  author,
  onSelectThread,
}: {
  route: Route;
  connection: RoomConnection | null;
  /** Whether this replica holds the document `route` names — see docIsPresent. */
  present: boolean;
  author: string;
  onSelectThread: (threadId: string) => void;
}): ReactElement {
  if (route.kind === "unknown-workspace") {
    return (
      <PaneNotice>
        <p className="ub-notice">
          <strong>Unknown workspace.</strong> This client is configured for{" "}
          <code>{WORKSPACE}</code>; the link names <code>{route.workspaceId}</code>.
        </p>
      </PaneNotice>
    );
  }

  if (route.kind === "invalid") {
    return (
      <PaneNotice>
        <p className="ub-notice">
          <strong>Not a document link.</strong> {route.reason} A document link
          looks like <code>/{WORKSPACE}/&lt;uuid&gt;</code>.
        </p>
      </PaneNotice>
    );
  }

  if (route.kind === "doc" && !present) {
    return (
      <PaneNotice>
        {/* The live sync state, so a link that is waiting says what it is
            waiting on rather than looking stuck. */}
        {connection !== null && <StatusLine connection={connection} />}
        <p className="ub-notice">
          <strong>Waiting for sync.</strong> Document <code>{route.uuid}</code>{" "}
          has not reached this replica yet. It opens here as soon as it arrives.
        </p>
      </PaneNotice>
    );
  }

  return (
    <EditorPane
      connection={connection}
      author={author}
      onSelectThread={onSelectThread}
    />
  );
}

export function App(): ReactElement {
  const identity = useIdentity(randomIdentity);
  const [path, navigate] = useRoutePath();
  const route = parseRoute(path, WORKSPACE);
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

  const directory = useRoom(directoryRoom(WORKSPACE), identity);
  const doc = useRoom(
    selected === null ? null : roomForDoc(WORKSPACE, selected),
    identity,
  );
  const entries = useDirectory(directory);
  const meta = useDocMeta(doc);
  const present = selected !== null && docIsPresent(selected, meta, entries);

  /**
   * Normalise the address to the one form the app hands out: `/` becomes
   * `/<workspace>`, a trailing slash or a shouted uuid becomes the canonical
   * spelling. `replace`, never `push` — a redirect the reader did not ask for
   * must not become a history entry that Back bounces off.
   */
  useEffect(() => {
    const canonical = canonicalPath(parseRoute(path, WORKSPACE), WORKSPACE);
    if (canonical !== null && canonical !== path) navigate(canonical, "replace");
  }, [path, navigate]);

  /** Opening a document is navigating to it. There is nothing else to update. */
  const onSelect = useCallback(
    (uuid: string) => navigate(docPath(WORKSPACE, uuid)),
    [navigate],
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
    if (directory === null) return;
    const uuid = crypto.randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    const handle = acquireRoom(room, identity);
    initDoc(handle.connection.ydoc, { uuid, title: "" });
    // A document with no blocks has nowhere to put the caret, so seed one.
    appendBlock(handle.connection.ydoc, { type: "paragraph", text: "" });
    upsertDirectoryEntry(directory.ydoc, { uuid, title: "" });
    pending.current?.release();
    pending.current = { room, release: handle.release };
    onSelect(uuid);
  }, [directory, identity, onSelect]);

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
        <span className="ub-muted">workspace {WORKSPACE}</span>
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
          present={present}
          author={identity.name}
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
            onFocus={onFocusThread}
          />
        </aside>
      </div>
    </main>
  );
}

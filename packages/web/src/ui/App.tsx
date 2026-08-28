/**
 * The app shell. Two rooms at a time: the workspace directory, and whichever
 * document is open.
 *
 * Which document that is comes from the address bar and nowhere else (#68) —
 * see route.ts. The sidebar, Back/Forward and a pasted link are then the same
 * gesture, and there is no second copy of the selection to drift out of step
 * with the URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  appendBlock,
  directoryRoom,
  initDoc,
  restoreDirectoryEntry,
  roomForDoc,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import { configuredWorkspaces, hubEndpoint } from "../config.js";
import { acquireRoom } from "../collab/rooms.js";
import { watchDocumentStub } from "../collab/directory-stub.js";
import { randomIdentity } from "../collab/identity.js";
import type { RoomConnection } from "../collab/rooms.js";
import { DocChrome } from "./DocChrome.js";
import { Sidebar, togglePin } from "./Sidebar.js";
import { EditorPane, PaneNotice, StatusLine } from "./EditorPane.js";
import { OutlinePane } from "./OutlinePane.js";
import { SyncPanel } from "./SyncPanel.js";
import { ThreadsPane } from "./ThreadsPane.js";
import { workspaceTags } from "./tags.js";
import { focusThread } from "./threads.js";
import type { SelectThread, ThreadFocus } from "./threads.js";
import { DocumentList } from "../shell/DocumentList.js";
import {
  allPath,
  canonicalPath,
  docIsHydrated,
  docPath,
  parseRoute,
  replicaHasAnswered,
  useRoutePath,
  workspaceList,
} from "./route.js";
import type { Route } from "./route.js";
import {
  useAgentSessions,
  useArchived,
  useDirectory,
  useDocMeta,
  useHubEndpoint,
  useIdentity,
  usePresence,
  useRoom,
  useRoomStatus,
  useSetting,
  useSidebar,
  useStoredFlag,
  useThreads,
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
  configured = true,
  connection,
  meta,
  author,
  knownTags,
  archived,
  onRestore,
  onSelectThread,
}: {
  route: Route;
  /**
   * Whether the client configuration has been read yet.
   *
   * Only the no-workspace branch cares. Until the read settles this client
   * knows of no workspaces, which is indistinguishable from having none — and
   * "No workspace" is a notice about a *misconfiguration*, so flashing it
   * across the pane for the length of one same-origin fetch would accuse a
   * perfectly configured deployment of being broken.
   */
  configured?: boolean;
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
  /** The workspace's tags, for the identity line's add field (#122). */
  knownTags: readonly string[];
  /** Whether the directory tombstones this document — see `useArchived`. */
  archived: boolean;
  /** Lift that tombstone. The only action an archived document offers. */
  onRestore: () => void;
  onSelectThread: SelectThread;
}): ReactElement {
  // Before the branches: a hook may not sit behind an early return. Only
  // `localReplicaLoaded` is read here — it is what tells the empty document a
  // freshly opened room holds apart from an answer that the document is absent.
  const { localReplicaLoaded } = useRoomStatus(connection);

  if (route.kind === "no-workspace") {
    // Nothing is known yet — keep the frame, say nothing, as everywhere else
    // here that ignorance would otherwise read as an answer.
    if (!configured) return <PaneNotice>{null}</PaneNotice>;
    return (
      <PaneNotice>
        <p className="ub-notice">
          <strong>No workspace.</strong> This address names none, and{" "}
          {route.reason === "invalid" ? (
            <>
              this client is configured with <code>{route.configured}</code>, which
              is not a workspace id.
            </>
          ) : (
            <>this client is configured with none to fall back to.</>
          )}{" "}
          Open a document link — they look like{" "}
          <code>/&lt;workspace&gt;/&lt;uuid&gt;</code> — or run{" "}
          <code>ub status</code> to find your workspace id, and{" "}
          <code>ub init</code> if this machine has none yet.
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
      // Only `doc` reaches here — the shell renders the corpus journey itself
      // (#406) — and it carries the workspace the address spelled, which is
      // what a copied link has to keep.
      segment={route.workspace.segment}
      author={author}
      knownTags={knownTags}
      archived={archived}
      onRestore={onRestore}
      onSelectThread={onSelectThread}
    />
  );
}

export function App(): ReactElement {
  const identity = useIdentity(randomIdentity);
  const [path, navigate] = useRoutePath();
  // No room before the client configuration is known (#91): the shared
  // websocket is built from the first room acquired, so one acquired early
  // would pin the session to the build-time fallback. The workspaces come out
  // of that same read, and are empty until it settles — which is also what
  // re-renders this component with them.
  const hubReady = useHubEndpoint();
  const configured = hubReady ? configuredWorkspaces() : [];
  /**
   * Which hub every "synced" in this window is about (#362) — read once here
   * and handed to both surfaces that assert sync state, so the pill's hover and
   * the panel's rows can never name different hubs.
   */
  const endpoint = hubReady ? hubEndpoint() : null;
  /** The one that answers `/`, the address that names no workspace. */
  const defaultWorkspace = configured[0] ?? null;
  const route = parseRoute(path, defaultWorkspace);
  // The address names the workspace — this client is configured for none and
  // cannot enumerate them. Null only where the address named none it could use,
  // and then there are no rooms to join at all.
  const workspace = route.kind === "no-workspace" ? null : route.workspace;
  const selected = route.kind === "doc" ? route.uuid : null;
  // Both addresses that name the workspace render the document list, so the
  // sidebar's entry for it is the current page at either one.
  const listing = route.kind === "all" || route.kind === "list";
  const [collapsed, setCollapsed] = useStoredFlag(SIDEBAR_COLLAPSED_KEY, false);
  /**
   * The thread the reader is looking at. It lives here because the two ends of
   * the link are in different panes: a highlight in the editor and a card in the
   * rail focus each other through this one value.
   */
  const [focusedThread, setFocusedThread] = useState<ThreadFocus | null>(null);
  /**
   * Whether the rail is open as an overlay drawer (#101). It only means anything
   * below 1100px, where the stylesheet has hidden the rail: above that width the
   * rail is a column and `.ub-rail-open` declares nothing.
   */
  const [threadsOpen, setThreadsOpen] = useState(false);
  /** Whether the sync detail panel is open (#72) — the connection pill's state. */
  const [syncOpen, setSyncOpen] = useState(false);
  /**
   * What opened the drawer, so closing it can hand focus back there. Closing
   * *hides* the rail below 1100px, and focus inside a hidden panel is focus
   * nobody has — the reader would be back at the top of the page.
   */
  const threadsOpener = useRef<HTMLElement | null>(null);

  /** Close the drawer, and give focus back to whatever opened it. */
  const closeThreads = useCallback(() => {
    setThreadsOpen(false);
    const opener = threadsOpener.current;
    threadsOpener.current = null;
    // Only when the focus is in the rail that is about to go. A reader whose
    // focus is somewhere else did not ask to be moved, and Escape is a key they
    // may well have meant for something on screen.
    const inRail = document.activeElement?.closest(".ub-rail") ?? null;
    if (inRail === null) return;
    // The highlight the reader came from, if ProseMirror has not redrawn it
    // since; the handle otherwise, which is always somewhere to stand.
    const back =
      opener?.isConnected === true
        ? opener
        : document.querySelector<HTMLElement>(".ub-threads-toggle");
    back?.focus();
  }, []);

  const onToggleSync = useCallback(() => setSyncOpen((open) => !open), []);

  /**
   * Close the panel, and give focus back to the pill that opened it.
   *
   * Only when the focus is inside the panel that is about to go — its own ×,
   * usually — because focus on a detached element is focus nobody has, and the
   * reader would be returned to the top of the page. A click on the pill needs
   * no repair: focus is already there.
   */
  const closeSync = useCallback(() => {
    setSyncOpen(false);
    const inPanel = document.activeElement?.closest(".ub-sync-panel") ?? null;
    if (inPanel === null) return;
    document.querySelector<HTMLElement>(".ub-sync-toggle")?.focus();
  }, []);

  const onFocusThread = useCallback<SelectThread>((threadId, viaKeyboard) => {
    setFocusedThread((previous) =>
      focusThread(previous, threadId, viaKeyboard === true),
    );
    // The highlight is still what holds focus here — the card takes it a commit
    // later, from the rail's own effect — so this is the reader's way back.
    if (viaKeyboard === true && document.activeElement instanceof HTMLElement) {
      threadsOpener.current = document.activeElement;
    }
    // Selecting a thread is asking to read it, so the drawer opens whether the
    // reader got here from a highlight or from the toggle. On a wide window this
    // is a state change nothing renders.
    setThreadsOpen(true);
  }, []);

  const onToggleThreads = useCallback(() => {
    if (threadsOpen) {
      closeThreads();
      return;
    }
    // The click has already put focus on the handle, which is where closing
    // should leave it.
    threadsOpener.current = null;
    setThreadsOpen(true);
  }, [threadsOpen, closeThreads]);

  /** Escape closes the drawer — the way out of an overlay. */
  useEffect(() => {
    if (!threadsOpen) return;
    const close = (event: KeyboardEvent): void => {
      // A control inside the rail may have handled this Escape already — a
      // reply form cancelling, say, which preventDefaults it. Dismissing the
      // form and closing the drawer out from under it are two gestures, and the
      // reader made one.
      if (event.key === "Escape" && !event.defaultPrevented) closeThreads();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [threadsOpen, closeThreads]);

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
  const sidebar = useRoom(
    hubReady && workspace !== null ? sidebarRoom(workspace.uuid) : null,
    identity,
  );
  const entries = useDirectory(directory);
  /**
   * The curated sidebar (#115), live — the same reading a second browser and an
   * agent's `get_sidebar` produce, because all three are `readSidebar` over the
   * one synced document.
   */
  const sidebarGroups = useSidebar(sidebar);
  /** Whether the open document is pinned — what the header's Pin control shows. */
  const pinned =
    selected !== null && sidebarGroups.some((group) => group.docs.includes(selected));
  /**
   * The workspace's tags, from the directory stubs alone — the suggestions the
   * open document's tag strip offers. Derived here because the listing is
   * already here, and reading it a second time would be a second observer over
   * the same map.
   */
  const knownTags = useMemo(() => workspaceTags(entries), [entries]);
  const meta = useDocMeta(doc);
  const archived = useArchived(directory, selected);
  /**
   * The open document's threads: the rail's content, read once here because two
   * things depend on it — the handle in the topbar, and whether the drawer is
   * allowed to be open at all.
   */
  const threads = useThreads(doc);
  /**
   * The room the connection pill reports on and the sync panel details: the
   * open document's, or the directory's when none is open. The socket is
   * shared, so it is the same truth about the same hub either way.
   */
  const chromeRoom = doc ?? directory;
  /**
   * Who else is in that room, read *here* and handed to both readers. The pill
   * names one session and the panel lists them all; one subscription over the
   * awareness map is what keeps those two views of the same fact identical.
   */
  const presence = usePresence(chromeRoom);
  /**
   * The agent sessions the user menu counts, and the colour this session is
   * seen in. Both are workspace-wide facts about *this client*, so they are
   * read here beside the rest of the shell's state: the directory is the room
   * every session joins, and the colour is one setting with two readers (the
   * menu's swatches, and the chip in the header).
   */
  const agentSessions = useAgentSessions(directory);
  const presenceColor = useSetting("presenceColor") ?? identity.color;

  /**
   * A drawer over an empty rail is a panel of nothing. The rail can empty out
   * *under* an open drawer — the last thread deleted, or the reader navigating
   * to a document that has none — with nobody having closed anything.
   */
  useEffect(() => {
    if (threads.length === 0 && threadsOpen) closeThreads();
  }, [threads.length, threadsOpen, closeThreads]);

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
   * default workspace, a trailing slash or a shouted uuid becomes the canonical
   * spelling. The workspace segment itself is left exactly as typed — the slug
   * is display, and rewriting somebody's spelling of their own workspace is a
   * later question (#160 leaves it alone deliberately). `replace`, never
   * `push` — a redirect the reader did not ask for must not become a history
   * entry that Back bounces off.
   */
  useEffect(() => {
    const canonical = canonicalPath(parseRoute(path, defaultWorkspace));
    if (canonical !== null && canonical !== path) navigate(canonical, "replace");
  }, [path, navigate, defaultWorkspace]);

  /**
   * The workspaces on the switcher's menu, and going to one.
   *
   * Recomputed every render rather than memoised: `workspace` is rebuilt by
   * `parseRoute` each time anyway, so a memo would be a dependency that always
   * changed — and the work is splitting a short string.
   */
  const workspaces = workspaceList(configured, workspace);
  const onSwitchWorkspace = useCallback(
    // A workspace's list, not a document: two corpora share no uuid, so
    // carrying the open document across would be a link to nowhere.
    (segment: string) => navigate(`/${segment}`),
    [navigate],
  );

  /**
   * Pin a document, or unpin it — one write, two callers: the header's control
   * for the document on screen, and a row of the corpus listing (#118). Which
   * group and which position are the drag's business; this only decides that
   * the document belongs in the sidebar at all.
   */
  const onTogglePinDoc = useCallback(
    (uuid: string) => {
      if (sidebar === null) return;
      togglePin(sidebar.ydoc, uuid);
    },
    [sidebar],
  );
  /** The keyboard-reachable path in, from the place that is always about the
      open document. */
  const onTogglePin = useCallback(() => {
    if (selected !== null) onTogglePinDoc(selected);
  }, [onTogglePinDoc, selected]);

  /** Opening a document is navigating to it. There is nothing else to update. */
  const segment = workspace?.segment ?? null;
  const onSelect = useCallback(
    (uuid: string) => {
      if (segment !== null) navigate(docPath(segment, uuid));
    },
    [navigate, segment],
  );

  /** Going to the listing is navigating to it, like opening a document. */
  const onOpenAll = useCallback(() => {
    if (segment !== null) navigate(allPath(segment));
  }, [navigate, segment]);

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
    // Stamped here, because this is the moment the document is created and
    // nothing else knows it: the stub carries `createdAt` from then on (the
    // schema keeps the first one), which is what the "Created" sort reads.
    // Creating is also the document's first change, and it opens the stamping
    // window the first edits then fall inside — the same pair `create_doc`
    // writes on the MCP side.
    const createdAt = Date.now();
    upsertDirectoryEntry(directory.ydoc, {
      uuid,
      title: "",
      createdAt,
      updatedAt: createdAt,
    });
    pending.current?.release();
    pending.current = { room, release: handle.release };
    onSelect(uuid);
  }, [directory, identity, onSelect, workspace]);

  /**
   * The directory stub is a cache; `meta.title` in the document is
   * authoritative. Repair the stub for as long as the document is open — the
   * "repaired on write/connect" half of that invariant — and stamp `updatedAt`
   * on the changes this client makes. See `collab/directory-stub.ts` for the
   * rule and for why an update that merely arrived stamps nothing.
   */
  useEffect(() => {
    if (doc === null || directory === null) return;
    return watchDocumentStub(doc.ydoc, directory.ydoc);
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
        {/* The open document's breadcrumb, and the activity and connection
            pills. The document's room when there is one, the directory's when
            there is not: one shared socket, so it is the same truth about the
            same hub either way. */}
        <DocChrome
          connection={chromeRoom}
          presence={presence}
          endpoint={endpoint}
          meta={meta}
          threads={threads}
          pinned={pinned}
          onTogglePin={sidebar !== null && selected !== null ? onTogglePin : null}
          threadsOpen={threadsOpen}
          onToggleThreads={onToggleThreads}
          syncOpen={syncOpen}
          onToggleSync={onToggleSync}
        />
        {/* The colour the picker chose, which is also the colour peers see this
            session in — one reading of one setting (#74). */}
        <span className="ub-me" style={{ borderColor: presenceColor }}>
          {identity.name}
        </span>
      </header>
      <div className="ub-body">
        {!collapsed && (
          <Sidebar
            connection={directory}
            sidebar={sidebar}
            groups={sidebarGroups}
            entries={entries}
            workspaces={workspaces}
            workspace={workspace}
            onSwitchWorkspace={onSwitchWorkspace}
            identity={identity}
            agentSessions={agentSessions}
            selected={selected}
            onSelect={onSelect}
            onCreate={onCreate}
            onOpenAll={onOpenAll}
            allOpen={listing}
          />
        )}
        {/* The corpus journey (#406): both addresses that name the workspace
            rather than a document — `/<workspace>`, the first screen of a
            session, and `/<workspace>/all` — are the document list. It is the
            only pane that is about the workspace rather than about one
            document, so it takes the pane rather than passing four more props
            through `RoutePane`, which exists to say what a *document* address
            resolves to. */}
        {listing ? (
          /* Keyed by the workspace, because everything the pane holds is
             about one corpus: a filter typed in workspace A would otherwise
             survive the switch and make workspace B's first screen look
             empty. The uuid, not the segment — the slug is cosmetic, and two
             spellings of one workspace are one corpus — so `/<workspace>` and
             `/<workspace>/all` keep the query, and only a real switch clears
             it. */
          <DocumentList
            key={workspace?.uuid}
            connection={directory}
            entries={entries}
            groups={sidebarGroups}
            onSelect={onSelect}
            onTogglePin={sidebar !== null ? onTogglePinDoc : null}
          />
        ) : (
          <RoutePane
            route={route}
            configured={hubReady}
            connection={doc}
            meta={meta}
            author={identity.name}
            knownTags={knownTags}
            archived={archived}
            onRestore={onRestore}
            onSelectThread={onFocusThread}
          />
        )}
        {/* The outline and the threads rail stack in one right column. Both
            sections render nothing when they have nothing to show, so the rail
            hides itself when it is empty (`.ub-rail:empty`) rather than leaving
            a blank gutter. */}
        <aside
          id="ub-rail"
          className={threadsOpen ? "ub-rail ub-rail-open" : "ub-rail"}
        >
          <OutlinePane connection={doc} />
          <ThreadsPane
            connection={doc}
            threads={threads}
            focused={focusedThread}
            author={identity.name}
            readOnly={archived}
            onFocus={onFocusThread}
          />
        </aside>
        {/* The sync detail panel (#72), over the panes rather than beside them:
            it is opened to answer a question and closed again. The room the
            pill reports on, the sessions the pill names one of, and the
            display label for the endpoint that was resolved — the same one the
            pill carries, null only in the moment before that read settles. */}
        {syncOpen && (
          <SyncPanel
            connection={chromeRoom}
            presence={presence}
            endpoint={endpoint}
            onClose={closeSync}
          />
        )}
      </div>
    </main>
  );
}

/**
 * The app shell. Two rooms at a time: the workspace directory, and whichever
 * document is open.
 *
 * Which document that is comes from the address bar and nowhere else (#68) —
 * see route.ts. The sidebar, Back/Forward and a pasted link are then the same
 * gesture, and there is no second copy of the selection to drift out of step
 * with the URL.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement } from "react";
import {
  appendBlock,
  directoryRoom,
  getDirectoryEntry,
  initDoc,
  restoreDirectoryEntry,
  roomForDoc,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import {
  configuredWorkspaces,
  endpointLabel,
  hubEndpoint,
  localServing,
} from "../config.js";
import type { HubEndpoint, LocalServing } from "../config.js";
import { acquireRoom } from "../collab/rooms.js";
import { watchDocumentStub } from "../collab/directory-stub.js";
import { randomIdentity } from "../collab/identity.js";
import { createDocLinkContext } from "../editor/doc-links.js";
import type { DocLinkContext } from "../editor/doc-links.js";
import type { RoomConnection } from "../collab/rooms.js";
import type { RemotePresence } from "./doc-chrome.js";
import { CopyLink } from "./DocChrome.js";
import { Sidebar, togglePin } from "./Sidebar.js";
import { EditorPane, PaneNotice, StatusLine } from "./EditorPane.js";
import { OutlinePane } from "./OutlinePane.js";
import { SyncPanel } from "./SyncPanel.js";
import { ThreadsPane } from "./ThreadsPane.js";
import { WorkspaceSettings } from "./WorkspaceSettings.js";
import { workspaceTags } from "./tags.js";
import { focusThread } from "./threads.js";
import type { SelectThread, ThreadFocus, ThreadView } from "./threads.js";
import { useServingRoomStatus } from "./serving-status.js";
import { DocumentList } from "../shell/DocumentList.js";
import { createDocumentSearchClient } from "../shell/document-search.js";
import {
  allPath,
  canonicalPath,
  docIsHydrated,
  docPath,
  parseRoute,
  replicaHasAnswered,
  settingsPath,
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
  useSidebar,
  useStoredFlag,
  useThreads,
} from "./hooks.js";

/** Sidebar preference, persisted per browser. */
const SIDEBAR_COLLAPSED_KEY = "uberblick.sidebar.collapsed";

/** The frozen serving process is still useful; this notice only names its binding. */
export function ReboundNotice({
  serving,
}: {
  serving: LocalServing | null;
}): ReactElement | null {
  if (serving?.rebound !== true) return null;
  const remoteHub = endpointLabel(serving.remoteHubUrl);
  if (remoteHub === null) return null;
  return (
    <p className="ub-rebound-notice" role="status">
      <strong>This machine’s binding changed.</strong> <code>ub open</code> is still
      serving{" "}
      {serving.workspace === null ? (
        <>without a workspace</>
      ) : (
        <>
          workspace <code>{serving.workspace}</code>
        </>
      )}{" "}
      and is bound to sync with <code>{remoteHub}</code>. Restart <code>ub open</code>{" "}
      to pick up the change.
    </p>
  );
}

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
  presence,
  endpoint = null,
  hubAcked,
  meta,
  author,
  knownTags,
  archived,
  updatedAt,
  docLinks,
  pinned = false,
  onTogglePin = null,
  onArchive = null,
  onArchiveConfirmationFocusChange,
  focusRestore = false,
  onRestoreFocused,
  onRestore,
  onSelectThread,
  threads = [],
  threadsOpen = false,
  onToggleThreads,
  syncOpen = false,
  onToggleSync,
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
   * Who else is in that room, read once by the shell (`usePresence`) and passed
   * down to every reader of it — see {@link StatusLine}.
   */
  presence: readonly RemotePresence[];
  /** The hub the document-local sync reading describes. */
  endpoint?: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  /**
   * That room's metadata, or null while it has not been read yet. The
   * difference carries a decision: unread is silence, read-and-not-this-document
   * is the waiting screen — and an *empty* meta is only the second of those once
   * the room has answered. See {@link replicaHasAnswered}.
   */
  meta: DocMeta | null;
  author: string;
  /** The workspace's tags, for the identity line's add field (#122). */
  knownTags: readonly string[];
  /** Whether the directory tombstones this document — see `useArchived`. */
  archived: boolean;
  /** The selected directory stub's edit-freshness hint, when it has one. */
  updatedAt?: number | undefined;
  /** What an inline document reference resolves against — see {@link EditorPane}. */
  docLinks: DocLinkContext | null;
  /** Sidebar curation and lifecycle actions for the live document. */
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  onArchive?: (() => void) | null;
  /** Track focus that should survive a remote archive closing its confirmation. */
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  /** A local confirmed archive moves focus to the surviving Restore action. */
  focusRestore?: boolean;
  /** Consume that one-shot focus request after the Restore control receives it. */
  onRestoreFocused?: (() => void) | undefined;
  /** Lift that tombstone. The only action an archived document offers. */
  onRestore: (() => void) | null;
  onSelectThread: SelectThread;
  /** The open document's conversations, for the narrow pane-edge trigger. */
  threads?: readonly ThreadView[];
  threadsOpen?: boolean;
  onToggleThreads?: (() => void) | undefined;
  /** The document-local sync reading opens the existing details panel. */
  syncOpen?: boolean;
  onToggleSync?: (() => void) | undefined;
}): ReactElement {
  // Before the branches: a hook may not sit behind an early return. The answer
  // flag tells a freshly opened empty room apart from an empty server answer.
  const { hasAnswered } = useRoomStatus(connection);

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
    // empty metadata of a room that is still joining. All of those last
    // a render or two, and all keep the frame while saying nothing. Drawing
    // "waiting for sync" from ignorance would flash those words across the pane
    // every time a reader moves between two documents they already have.
    if (connection === null || !replicaHasAnswered(meta, hasAnswered)) {
      return <PaneNotice documentLayout>{null}</PaneNotice>;
    }

    if (!docIsHydrated(route.uuid, meta)) {
      return (
        <PaneNotice documentLayout>
          {/* The live sync state, so a link that is waiting says what it is
              waiting on rather than looking stuck — and the copy control, which
              this screen carried before the identity line existed and still
              needs: this is the address of a document that has not arrived, and
              handing it to somebody who does have it is the way out (#535). */}
          <div className="ub-waiting-meta">
            <StatusLine
              connection={connection}
              presence={presence}
              endpoint={endpoint}
              hubAcked={hubAcked}
              syncOpen={syncOpen}
              onToggleSync={onToggleSync}
            />
            <CopyLink room={connection.room} segment={route.workspace.segment} />
          </div>
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
      presence={presence}
      endpoint={endpoint}
      hubAcked={hubAcked}
      author={author}
      knownTags={knownTags}
      archived={archived}
      updatedAt={updatedAt}
      docLinks={docLinks}
      pinned={pinned}
      onTogglePin={onTogglePin}
      onArchive={onArchive}
      onArchiveConfirmationFocusChange={onArchiveConfirmationFocusChange}
      focusRestore={focusRestore}
      onRestoreFocused={onRestoreFocused}
      onRestore={onRestore}
      onSelectThread={onSelectThread}
      threads={threads}
      threadsOpen={threadsOpen}
      onToggleThreads={onToggleThreads}
      syncOpen={syncOpen}
      onToggleSync={onToggleSync}
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
  const serving = hubReady ? localServing() : null;
  /** Which hub the room providers dial. */
  const endpoint = hubReady ? hubEndpoint() : null;
  /**
   * Which hub the document chrome names. A locally served page dials `ub open`
   * but reports the upstream named by the same configuration document; a
   * direct page keeps naming the endpoint it dials.
   */
  const statusEndpoint = useMemo<HubEndpoint | null>(
    () =>
      !hubReady
        ? null
        : serving === null
          ? endpoint
          : { url: endpointLabel(serving.remoteHubUrl), source: "document" },
    [endpoint, hubReady, serving],
  );
  /** The one that answers `/`, the address that names no workspace. */
  const defaultWorkspace = configured[0] ?? null;
  const route = parseRoute(path, defaultWorkspace);
  // The address names the workspace — this client is configured for none and
  // cannot enumerate them. Null only where the address named none it could use,
  // and then there are no rooms to join at all.
  const workspace = route.kind === "no-workspace" ? null : route.workspace;
  const workspaceUuid = workspace?.uuid ?? null;
  const documentSearch = useMemo(
    () =>
      !hubReady
        ? undefined
        : serving === null || workspaceUuid === null
          ? null
          : createDocumentSearchClient(workspaceUuid, identity.name),
    [hubReady, identity.name, serving, workspaceUuid],
  );
  const selected = route.kind === "doc" ? route.uuid : null;
  const settings = route.kind === "settings";
  // Both addresses that name the workspace render the document list, so the
  // sidebar's entry for it is the current page at either one.
  const listing = route.kind === "all" || route.kind === "list";
  const [collapsed, setCollapsed] = useStoredFlag(SIDEBAR_COLLAPSED_KEY, false);
  const hideSidebar = useRef<HTMLButtonElement | null>(null);
  const restoreSidebar = useRef<HTMLButtonElement | null>(null);
  const previousCollapsed = useRef(collapsed);

  // Collapsing unmounts the control that received the gesture. Move focus to
  // its visible counterpart after that commit, and do the inverse on restore.
  // The initial stored preference is not a gesture, so it must not steal focus.
  useLayoutEffect(() => {
    if (previousCollapsed.current === collapsed) return;
    previousCollapsed.current = collapsed;
    (collapsed ? restoreSidebar : hideSidebar).current?.focus();
  }, [collapsed]);
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
  /** Whether the sync detail panel is open (#72) — the status reading's state. */
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    if (route.kind !== "doc" && syncOpen) setSyncOpen(false);
  }, [route.kind, syncOpen]);
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

  const onFocusThread = useCallback<SelectThread>((threadId, selection) => {
    setFocusedThread((previous) => focusThread(previous, threadId, selection));
    // The highlight is still what holds focus here — the card takes it a commit
    // later, from the rail's own effect — so this is the reader's way back.
    if (
      selection?.viaKeyboard === true &&
      document.activeElement instanceof HTMLElement
    ) {
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
  const directoryStatus = useRoomStatus(directory);
  const docStatus = useRoomStatus(doc);
  const sidebarStatus = useRoomStatus(sidebar);
  const entries = useDirectory(directory);
  /**
   * The curated sidebar (#115), live — the same reading a second browser and an
   * agent's `get_sidebar` produce, because all three are `readSidebar` over the
   * one synced document.
   */
  const sidebarGroups = useSidebar(sidebar);
  /** Whether the open document is pinned — what its actions menu shows. */
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
  const restoreFocusRoom = useRef<string | null>(null);
  const archiveConfirmationFocusRoom = useRef<string | null>(null);
  // `entries` is the live directory observer, while this exact lookup keeps the
  // selected tombstone available after archiving removes it from that listing.
  const selectedDirectoryEntry =
    directory === null || selected === null
      ? undefined
      : getDirectoryEntry(directory.ydoc, selected);
  /**
   * The open document's threads: the rail's content, read once here because two
   * things depend on it — the handle at the pane edge, and whether the drawer is
   * allowed to be open at all.
   */
  const threads = useThreads(doc);
  /**
   * The room the document-local sync reading and panel describe. A route with
   * no open document has no global replacement control, so it has no room here.
   */
  const chromeRoom = selected === null ? null : doc;
  const hubAcked = useServingRoomStatus(
    documentSearch,
    chromeRoom?.room ?? null,
  );
  /**
   * Who else is in that room, read *here* and handed to every reader of it. The
   * status line's strip draws them as circles and the sync panel lists them in
   * words; one subscription over the awareness map keeps both views identical.
   */
  const presence = usePresence(chromeRoom);
  /**
   * The agent sessions the user menu counts. It is a workspace-wide fact, so
   * the directory is the room every session joins.
   */
  const agentSessions = useAgentSessions(directory);

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
    if (
      directory === null ||
      selected === null ||
      !directory.status.writable
    ) {
      return;
    }
    restoreFocusRoom.current = null;
    restoreDirectoryEntry(directory.ydoc, selected);
  }, [directory, selected]);

  const onRestoreFocused = useCallback(() => {
    restoreFocusRoom.current = null;
    archiveConfirmationFocusRoom.current = null;
  }, []);

  /**
   * Remember focus only while it is inside the archive confirmation. A remote
   * tombstone can remove that portalled surface without calling `onArchive`,
   * and the surviving Restore control is then the nearest place to stand.
   */
  const onArchiveConfirmationFocusChange = useCallback(
    (focused: boolean) => {
      if (doc === null) return;
      if (focused) {
        archiveConfirmationFocusRoom.current = doc.room;
      } else if (archiveConfirmationFocusRoom.current === doc.room) {
        archiveConfirmationFocusRoom.current = null;
      }
    },
    [doc],
  );

  /**
   * Archive only a live directory stub, matching the MCP lifecycle boundary.
   * The pane follows the resulting tombstone through `useArchived`; there is no
   * optimistic archived state here.
   */
  const onArchive = useCallback(() => {
    if (
      directory === null ||
      doc === null ||
      selected === null ||
      !directory.status.writable
    ) {
      return;
    }
    const entry = getDirectoryEntry(directory.ydoc, selected);
    if (entry === null || entry.deleted === true) return;
    restoreFocusRoom.current = doc.room;
    tombstoneDirectoryEntry(directory.ydoc, selected);
  }, [directory, doc, selected]);

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
      if (sidebar === null || !sidebar.status.writable) return;
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

  /**
   * What an inline document reference resolves against (#444).
   *
   * Three things the mark deliberately does not store, assembled where they are
   * all already known: the address of a document in the workspace the reader is
   * *in* — the same `docPath` the sidebar and a copied link use, so a reference
   * never carries an address of its own — the directory room already joined
   * above, which is what tells a title, an unresolved target and a tombstoned
   * one apart without opening a single target room, and `onSelect`, so
   * following a reference is the same navigation as clicking a document in the
   * list and Back therefore works.
   *
   * Memoised on exactly what it closes over: the editor binds to this, so a new
   * object every render would tear the editor down under the reader's caret.
   */
  const docLinks = useMemo<DocLinkContext | null>(
    () =>
      segment === null
        ? null
        : createDocLinkContext({
            directory: directory?.ydoc ?? null,
            href: (uuid) => docPath(segment, uuid),
            open: onSelect,
          }),
    [directory, onSelect, segment],
  );

  /** Going to the listing is navigating to it, like opening a document. */
  const onOpenAll = useCallback(() => {
    if (segment !== null) navigate(allPath(segment));
  }, [navigate, segment]);

  /** Enter settings, or leave it for the workspace's fixed list address. */
  const onOpenSettings = useCallback(() => {
    if (segment !== null) navigate(settingsPath(segment));
  }, [navigate, segment]);
  const onBackToWorkspace = useCallback(() => {
    if (segment !== null) navigate(`/${segment}`);
  }, [navigate, segment]);

  /**
   * A create needs the new document's Y.Doc *before* React has mounted the
   * editor pane for it, so the handle is held here until `useRoom` has acquired
   * the same room. Room connections are refcounted and keyed by room name, so
   * this handle and the pane's are the same connection — and handing over as
   * soon as the pane has it is what keeps navigating away from actually closing
   * the connection instead of leaving it publishing stale awareness.
   */
  const pending = useRef<{
    room: string;
    release: () => void;
    stop: () => void;
    created: boolean;
    mounted: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      pending.current?.stop();
      pending.current?.release();
    },
    [],
  );

  useEffect(() => {
    const held = pending.current;
    if (held === null) return;
    if (doc === null || doc.room !== held.room) {
      if (!held.mounted || held.created) return;
      pending.current = null;
      held.stop();
      held.release();
      return;
    }
    held.mounted = true;
    if (!held.created) return;
    pending.current = null;
    held.stop();
    held.release();
  }, [doc]);

  const onCreate = useCallback(() => {
    if (
      directory === null ||
      workspace === null ||
      !directory.status.writable
    ) {
      return;
    }
    const uuid = crypto.randomUUID();
    const room = roomForDoc(workspace.uuid, uuid);
    const handle = acquireRoom(room, identity);
    pending.current?.stop();
    pending.current?.release();
    const held = {
      room,
      release: handle.release,
      stop: () => {},
      created: false,
      mounted: false,
    };
    pending.current = held;
    const attempt = (): void => {
      // The subscription supplies its seed synchronously. Defer the decision
      // so `held.stop` has received the actual unsubscribe before it is used.
      queueMicrotask(() => {
        if (pending.current !== held) return;
        if (held.created) return;
        const status = handle.connection.status;
        if (
          status.storeRefused ||
          status.protocolMismatch !== null ||
          directory.status.storeRefused ||
          directory.status.protocolMismatch !== null
        ) {
          pending.current = null;
          held.stop();
          held.release();
          onBackToWorkspace();
          return;
        }
        if (!status.writable || !directory.status.writable) return;
        held.created = true;
        held.stop();
        initDoc(handle.connection.ydoc, { uuid, title: "Untitled" });
        // A document with no blocks has nowhere to put the caret, so seed one.
        appendBlock(handle.connection.ydoc, { type: "paragraph", text: "" });
        const createdAt = Date.now();
        upsertDirectoryEntry(directory.ydoc, {
          uuid,
          title: "Untitled",
          createdAt,
          updatedAt: createdAt,
        });
        if (held.mounted) {
          pending.current = null;
          held.release();
        }
      });
    };
    let stopDocument = handle.connection.onStatusChange(attempt);
    let stopDirectory = directory.onStatusChange(attempt);
    held.stop = () => {
      stopDocument();
      stopDirectory();
      stopDocument = () => {};
      stopDirectory = () => {};
    };
    // Move to the new room immediately. Until admission its route draws the
    // waiting/read-only state, so a second create cannot keep editing the old
    // document while the new connection is still handshaking.
    onSelect(uuid);
  }, [directory, identity, onBackToWorkspace, onSelect, workspace]);

  /**
   * The directory stub is a cache; `meta.title` in the document is
   * authoritative. Repair the stub for as long as the document is open — the
   * "repaired on write/connect" half of that invariant — and stamp `updatedAt`
   * on the changes this client makes. See `collab/directory-stub.ts` for the
   * rule and for why an update that merely arrived stamps nothing.
   */
  useEffect(() => {
    if (doc === null || directory === null) return;
    return watchDocumentStub(doc.ydoc, directory.ydoc, {
      writable: () => directory.status.writable,
      subscribe: (listener) => directory.onStatusChange(() => listener()),
    });
  }, [doc, directory]);

  const sidebarToggleLabel = settings
    ? collapsed
      ? "Show sidebar"
      : "Hide sidebar"
    : collapsed
      ? "Show document list"
      : "Hide document list";

  return (
    <main className="ub-app">
      <ReboundNotice serving={serving} />
      <div className="ub-body">
        {collapsed && (
          /* Pane-local and out of flow: restoring the sidebar costs no global
             row and leaves every route at the application's top edge. */
          <button
            ref={restoreSidebar}
            type="button"
            className="ub-sidebar-toggle ub-sidebar-restore"
            aria-expanded="false"
            aria-label={sidebarToggleLabel}
            title={sidebarToggleLabel}
            onClick={() => setCollapsed(false)}
          >
            »
          </button>
        )}
        {!collapsed && (
          <Sidebar
            collapseButtonRef={hideSidebar}
            collapseLabel={sidebarToggleLabel}
            onCollapse={() => setCollapsed(true)}
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
            onOpenSettings={onOpenSettings}
            onBackToWorkspace={onBackToWorkspace}
            allOpen={listing}
            settingsOpen={settings}
          />
        )}
        {/* Workspace modes own the content pane directly. The corpus journey
            (#406): both addresses that name the workspace
            rather than a document — `/<workspace>`, the first screen of a
            session, and `/<workspace>/all` — are the document list. It is the
            only pane that is about the workspace rather than about one
            document, so it takes the pane rather than passing four more props
            through `RoutePane`, which exists to say what a *document* address
            resolves to. */}
        {settings ? (
          <WorkspaceSettings
            workspace={route.workspace}
            endpoint={endpoint}
            connection={directory}
            agentSessions={agentSessions}
          />
        ) : listing ? (
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
            searchClient={documentSearch}
            onSelect={onSelect}
            onTogglePin={sidebarStatus.writable ? onTogglePinDoc : null}
          />
        ) : (
          <RoutePane
            route={route}
            configured={hubReady}
            connection={doc}
            presence={presence}
            endpoint={statusEndpoint}
            hubAcked={serving === null ? undefined : hubAcked}
            meta={meta}
            author={identity.name}
            knownTags={knownTags}
            archived={archived}
            updatedAt={selectedDirectoryEntry?.updatedAt}
            docLinks={docLinks}
            pinned={pinned}
            onTogglePin={
              sidebarStatus.writable && selected !== null ? onTogglePin : null
            }
            onArchive={
              selectedDirectoryEntry !== null &&
              selectedDirectoryEntry !== undefined &&
              selectedDirectoryEntry.deleted !== true &&
              directoryStatus.writable
                ? onArchive
                : null
            }
            onArchiveConfirmationFocusChange={onArchiveConfirmationFocusChange}
            focusRestore={
              doc !== null &&
              (restoreFocusRoom.current === doc.room ||
                archiveConfirmationFocusRoom.current === doc.room)
            }
            onRestoreFocused={onRestoreFocused}
            onRestore={directoryStatus.writable ? onRestore : null}
            onSelectThread={onFocusThread}
            threads={threads}
            threadsOpen={threadsOpen}
            onToggleThreads={onToggleThreads}
            syncOpen={syncOpen}
            onToggleSync={onToggleSync}
          />
        )}
        {/* The outline follows the document independently of the comments rail:
            its compact trigger remains while the document pane scrolls, and no
            eligible heading means this renders no flex item at all. */}
        <OutlinePane
          key={doc?.room ?? "no-document"}
          connection={doc}
          obscured={threadsOpen}
        />
        {/* The comments rail renders nothing when there are no threads, so the
            rail hides itself when empty instead of leaving a blank gutter. */}
        <aside
          id="ub-rail"
          className={threadsOpen ? "ub-rail ub-rail-open" : "ub-rail"}
        >
          <ThreadsPane
            connection={doc}
            threads={threads}
            focused={focusedThread}
            author={identity.name}
            readOnly={archived || !docStatus.writable}
            onFocus={onFocusThread}
          />
        </aside>
        {/* The sync detail panel (#72), over the panes rather than beside them:
            it is opened to answer a question and closed again. The room and
            sessions are the ones the document-local status line describes;
            the endpoint is null only while its configuration read settles. */}
        {syncOpen && route.kind === "doc" && (
          <SyncPanel
            connection={chromeRoom}
            presence={presence}
            endpoint={statusEndpoint}
            hubAcked={serving === null ? undefined : hubAcked}
            onClose={closeSync}
          />
        )}
      </div>
    </main>
  );
}

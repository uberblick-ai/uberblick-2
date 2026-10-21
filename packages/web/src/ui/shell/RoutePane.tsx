import type { ComponentProps, ReactElement } from "react";
import { decisionCurrentRecord } from "@uberblick/schema";
import type { DecisionTopicResolution, DocMeta } from "@uberblick/schema";
import type { HubEndpoint } from "../../config.js";
import type { RoomConnection } from "../../collab/rooms.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import type { NotSharedReason } from "../../shell/document-search.js";
import type { SelectThread, ThreadView } from "../comments/threads.js";
import { CopyLink } from "../document/DocChrome.js";
import { DecisionTopicPane } from "../document/DecisionTopicPane.js";
import { DecisionsBlock, DecisionsLink } from "../document/DecisionsBlock.js";
import { EditorPane, PaneNotice, StatusLine } from "../document/EditorPane.js";
import { useRoomStatus } from "../hooks.js";
import { docIsHydrated, replicaHasAnswered } from "../route.js";
import type { Navigate, Route } from "../route.js";
import type { RemotePresence } from "../status/doc-chrome.js";

export interface RoutePaneProps {
  route: Route;
  /** Wait for configuration before an unresolved fetch establishes No workspace. */
  configured?: boolean;
  /** useRoom returns null during a route change rather than exposing the old room. */
  connection: RoomConnection | null;
  /** Read presence once in the shell and share it with every room-status surface. */
  presence: readonly RemotePresence[];
  /** The hub the document-local sync reading describes. */
  endpoint?: HubEndpoint | null;
  /** ub open's upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  rawHubAcked?: boolean | null | undefined;
  sampledAt?: number | null | undefined;
  notSharedReason?: NotSharedReason | null;
  /** Empty metadata earns the waiting screen only after a confirmed room answer. */
  meta: DocMeta | null;
  author: string;
  /** The workspace settings room that owns the curated tag catalog. */
  catalogConnection?: RoomConnection | null;
  /** Whether the directory tombstones this document — see useArchived. */
  archived: boolean;
  /** The selected directory stub's edit-freshness hint, when it has one. */
  updatedAt?: number | undefined;
  onLastUpdatedChange?: ((room: string, value: number | undefined) => void) | undefined;
  /** What an inline document reference resolves against — see EditorPane. */
  docLinks: DocLinkContext | null;
  /** Sidebar curation and lifecycle actions for the live document. */
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  onArchive?: (() => void) | null;
  onArchiveRecord?: (() => void) | null;
  showArchiveRecord?: boolean;
  archiveRecordUnavailable?: string | null;
  /** Track focus that should survive a remote archive closing its confirmation. */
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  /** A local confirmed archive moves focus to the surviving Restore action. */
  focusRestore?: boolean;
  /** Consume the one-shot focus request after the Restore control receives it. */
  onRestoreFocused?: (() => void) | undefined;
  /** Lift that tombstone. The only action an archived document offers. */
  onRestore: (() => void) | null;
  onSelectThread: SelectThread;
  /** The open document's conversations, for the narrow pane-edge trigger. */
  threads?: readonly ThreadView[];
  threadsOpen?: boolean;
  onToggleThreads?: (() => void) | undefined;
  /** The document-local sync reading opens the existing details panel. */
  syncDetails?: boolean;
  topic?: DecisionTopicResolution | null;
  selectedUuid?: string | null | undefined;
  navigate?: Navigate;
  directoryConnection?: RoomConnection | null;
  titleConnection?: RoomConnection | null;
  relatedTopics?: readonly DecisionTopicResolution[];
  onAlterDecision?: (() => void) | null;
}

function NoWorkspaceNotice({ route, configured }: {
  route: Extract<Route, { kind: "no-workspace" }>;
  configured: boolean;
}): ReactElement {
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
        <code>ub workspace create &lt;name&gt;</code> if this machine has none yet.
      </p>
    </PaneNotice>
  );
}

function WaitingForDocument({ route, uuid, props, connection }: {
  route: Extract<Route, { kind: "doc" | "decision" }>;
  uuid: string;
  props: RoutePaneProps;
  connection: RoomConnection;
}): ReactElement {
  return (
    <PaneNotice documentLayout>
      {/* Keep sync status and link copying available while the room arrives. */}
      <div className="ub-waiting-meta">
        <StatusLine
          connection={connection}
          presence={props.presence}
          endpoint={props.endpoint ?? null}
          hubAcked={props.hubAcked}
          rawHubAcked={props.rawHubAcked}
          sampledAt={props.sampledAt}
          notSharedReason={props.notSharedReason ?? null}
          onLastUpdatedChange={props.onLastUpdatedChange}
          syncDetails={props.syncDetails ?? false}
        />
        <CopyLink room={connection.room} segment={route.workspace.segment} />
      </div>
      <p className="ub-notice">
        <strong>Waiting for sync.</strong> Document <code>{uuid}</code>{" "}
        has not reached this page yet. It opens here as soon as it arrives.
      </p>
    </PaneNotice>
  );
}

function documentNotice(props: RoutePaneProps, hasAnswered: boolean): ReactElement | null {
  const { route, connection, meta, selectedUuid, topic = null, navigate } = props;
  if (route.kind !== "doc" && route.kind !== "decision") return null;
  if (route.kind === "decision" && (topic === null || selectedUuid === null)) {
    return <PaneNotice documentLayout><p className="ub-notice">Waiting for the selected record in this decision topic to sync.</p></PaneNotice>;
  }
  const uuid = selectedUuid ?? (route.kind === "doc" ? route.uuid : route.record);
  // Unread metadata or a joining empty room keeps the frame silent; neither
  // establishes waiting for sync.
  if (connection === null || !replicaHasAnswered(meta, hasAnswered)) {
    return <PaneNotice documentLayout>{null}</PaneNotice>;
  }
  if (!docIsHydrated(uuid, meta)) return <WaitingForDocument route={route} uuid={uuid} props={props} connection={connection} />;
  if (meta?.kind === "decision" && (topic === null || topic.first === null) && navigate !== undefined) {
    return <PaneNotice documentLayout><p className="ub-notice">Waiting for the decision topic to sync.</p></PaneNotice>;
  }
  return null;
}

function editorProperties(props: RoutePaneProps, segment: string): ComponentProps<typeof EditorPane> {
  return {
    connection: props.connection, segment, presence: props.presence,
    endpoint: props.endpoint ?? null,
    hubAcked: props.hubAcked, rawHubAcked: props.rawHubAcked, sampledAt: props.sampledAt,
    notSharedReason: props.notSharedReason ?? null, author: props.author,
    catalogConnection: props.catalogConnection ?? null, archived: props.archived, updatedAt: props.updatedAt,
    onLastUpdatedChange: props.onLastUpdatedChange, docLinks: props.docLinks,
    pinned: props.pinned ?? false, onTogglePin: props.onTogglePin ?? null, onArchive: props.onArchive ?? null,
    onArchiveRecord: props.onArchiveRecord ?? null, showArchiveRecord: props.showArchiveRecord ?? false,
    archiveRecordUnavailable: props.archiveRecordUnavailable ?? null,
    onArchiveConfirmationFocusChange: props.onArchiveConfirmationFocusChange,
    focusRestore: props.focusRestore ?? false, onRestoreFocused: props.onRestoreFocused, onRestore: props.onRestore,
    onSelectThread: props.onSelectThread, threads: props.threads ?? [], threadsOpen: props.threadsOpen ?? false,
    onToggleThreads: props.onToggleThreads, syncDetails: props.syncDetails ?? false,
  };
}

function RouteEditor({ route, props }: {
  route: Exclude<Route, { kind: "no-workspace" | "invalid" }>;
  props: RoutePaneProps;
}): ReactElement {
  const { meta, topic = null, navigate, relatedTopics = [] } = props;
  const editorProps = editorProperties(props, route.workspace.segment);
  if (navigate !== undefined && topic !== null) {
    const current = decisionCurrentRecord(topic);
    return <DecisionTopicPane {...editorProps}
      topic={topic} selected={props.selectedUuid ?? null} navigate={navigate}
      directoryConnection={props.directoryConnection ?? null}
      titleConnection={props.titleConnection ?? null}
      onAlterDecision={props.onAlterDecision ?? null}
      explicit={route.kind === "decision"}
      linkedRecord={route.kind === "doc" && route.uuid !== current?.uuid ? route.uuid : null}
    />;
  }
  const decisionsId = meta === null || relatedTopics.length === 0 ? null : `decisions-${meta.uuid}`;
  return <EditorPane {...editorProps}
    statusLink={decisionsId !== null && meta?.kind !== "decision" && <DecisionsLink topics={relatedTopics} id={decisionsId} />}
    afterAnswer={decisionsId !== null && meta?.kind !== "decision" && navigate !== undefined &&
      <DecisionsBlock topics={relatedTopics} segment={route.workspace.segment} navigate={navigate} id={decisionsId} />}
  />;
}

/** Unseen document routes resolve when their rooms arrive; other routes own their notices. */
export function RoutePane(props: RoutePaneProps): ReactElement {
  const { route } = props;
  // Hooks precede early returns so route changes retain one room-status subscription.
  const { hasAnswered, deleted } = useRoomStatus(props.connection);
  if (deleted) return <PaneNotice documentLayout>{null}</PaneNotice>;
  if (route.kind === "no-workspace") return <NoWorkspaceNotice route={route} configured={props.configured ?? true} />;
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
  return documentNotice(props, hasAnswered) ?? <RouteEditor route={route} props={props} />;
}

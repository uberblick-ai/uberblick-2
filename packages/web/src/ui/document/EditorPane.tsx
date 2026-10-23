/**
 * The editor pane: title, sync status, presence, and the bound editor — or the
 * loud read-only fallback when the palette gate is closed.
 */

import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  getAnnotation,
  getBlocksFragment,
  getMeta,
  isExternalHref,
  MAX_TLDR_LENGTH,
  parseRoom,
  setTldr,
  setTldrOptOut,
  setTitle,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import type { CodeCheck } from "@uberblick/schema";
import { DocumentTitle } from "./DocumentTitle.js";
import { bindGuardedEditor } from "../../editor/guarded-binding.js";
import { docLinkFromTarget } from "../../editor/doc-links.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { linkAnchorFromTarget } from "../../editor/external-links.js";
import { describeForeignBlocks } from "../../editor/palette.js";
import type { LinkConflict } from "../../editor/palette.js";
import { repairLinkConflict } from "../../editor/link-repair.js";
import { writeDocument } from "../../collab/document-write.js";
import type { LinkSurvivor } from "../../editor/link-repair.js";
import type { HubEndpoint } from "../../config.js";
import type { RoomConnection } from "../../collab/rooms.js";
import type { NotSharedReason } from "../../shell/document-search.js";
import { toast } from "sonner";
import { writeToClipboard } from "../../editor/source-chrome.js";
import { revealFoldedTarget } from "../../editor/toggle-headings.js";
import { rawSyncState, useCalmSyncState } from "../status/calm.js";
import { statusReading } from "../status/status-reading.js";
import { documentSyncFacts } from "../status/sync-facts.js";
import { bindSyncAttributes } from "../status/sync-state.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { isPlainClick } from "../route.js";
import { BlockMenu } from "../editor-controls/BlockMenu.js";
import { CodeLanguageControl } from "../editor-controls/CodeLanguageControl.js";
import { CardButtonControls } from "../editor-controls/CardButtonControls.js";
import { TableControls } from "../editor-controls/TableControls.js";
import { MentionMenu } from "../editor-controls/MentionMenu.js";
import { EmojiMenu } from "../editor-controls/EmojiMenu.js";
import {
  readRoomMeta,
  useDocMeta,
  useDocRev,
  useForeignBlocks,
  useLinkConflicts,
  usePeers,
  useRawBlocks,
  useRoomStatus,
} from "../hooks.js";
import type { RemotePresence } from "../status/doc-chrome.js";
import { CommentComposer } from "../comments/CommentComposer.js";
import { PeerCluster } from "../status/PeerCluster.js";
import { SyncDot } from "../status/SyncDot.js";
import { useDocumentSyncActivity } from "../status/document-sync-activity.js";
import { DocMetaLine } from "./DocChrome.js";
import type { DocumentActionProps } from "./DocChrome.js";
import { threadIdFromActivation, threadIdFromTarget } from "../comments/threads.js";
import type { SelectThread, ThreadView } from "../comments/threads.js";
import { Button } from "../shadcn/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../shadcn/alert-dialog.js";

/** Read the document itself, including before its React subscription answers. */
function isDecision(connection: RoomConnection): boolean {
  return getMeta(connection.ydoc).kind === "decision";
}

/**
 * Read live room state, never a render snapshot: the room can become a
 * decision or lose writability before React renders the change.
 */
function canWriteContent(connection: RoomConnection, contentReadOnly: boolean): boolean {
  return !contentReadOnly && !isDecision(connection) && connection.status.writable;
}

/**
 * Use one pane frame for every unresolved route so loading changes words
 * without moving the document column.
 */
export function PaneNotice({
  children,
  documentLayout = false,
}: {
  children: ReactNode;
  /** Keep document-route loading states at the document's eventual origin. */
  documentLayout?: boolean;
}): ReactElement {
  return (
    <section className={`ub-pane${documentLayout ? " ub-page-pane ub-document-pane" : ""}`}>
      <div className="ub-column">{children}</div>
    </section>
  );
}

/**
 * Archived content stays rendered, scrollable and copyable. Lifecycle actions
 * write the directory; title, editor and comments remain read-only.
 */
function ArchivedBanner({
  actions: { onRestore = null, onDelete = null, focusRestore = false, onRestoreFocused },
  title,
  decision,
  topicArchived,
}: {
  actions: DocumentActionProps;
  title: string;
  decision: boolean;
  topicArchived: boolean;
}): ReactElement {
  const restore = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!focusRestore) return;
    restore.current?.focus();
    onRestoreFocused?.();
  }, [focusRestore, onRestoreFocused]);
  return (
    <div className="ub-archived-banner mb-3 flex flex-wrap items-center gap-2 rounded-(--radius) border border-(--border) bg-(--archived-background) px-3 py-[0.6rem] text-(--foreground)">
      <svg aria-hidden="true" className="size-4 shrink-0 text-(--archived-icon)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9h16v11H4zM3 4h18v5H3zM10 13h4" />
      </svg>
      <span><strong className="font-medium">Archived.</strong> Read-only and hidden from the document list.</span>
      <Button
        ref={restore}
        type="button"
        variant="secondary"
        size="sm"
        className="ml-auto"
        disabled={onRestore === null}
        onClick={() => onRestore?.()}
      >
        {onRestore === null ? "Restore unavailable" : "Restore"}
      </Button>
      {(!decision || topicArchived) && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              className="min-h-6 min-w-6 cursor-pointer rounded-(--radius-sm) bg-transparent px-2 py-1 ub-type-ui text-(--destructive-ink) disabled:opacity-50"
              disabled={onDelete === null}
              aria-describedby={onDelete === null ? "ub-delete-unavailable" : undefined}
            >{decision ? "Delete topic…" : "Delete…"}</button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>{decision ? `Delete topic “${title}”?` : `Delete “${title}”?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {onDelete === null
                ? "Delete is unavailable while the directory is not ready to write. Nothing has been deleted."
                : decision
                  ? "The topic and all its records will be deleted for everyone, with their comments and history. Links to them will show they were deleted. This can't be undone."
                  : "It will be gone for everyone, with its comments and history. Links to it will show it was deleted. This can't be undone."}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={onDelete === null}
                onClick={(event) => {
                  if (onDelete === null) {
                    event.preventDefault();
                    return;
                  }
                  onDelete(decision);
                }}
              >{decision ? "Delete topic" : "Delete"}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {onRestore === null && (
        <span className="ub-restore-unavailable basis-full ub-type-small">
          Restore is unavailable while the directory is not ready to write.
        </span>
      )}
      {(!decision || topicArchived) && onDelete === null && (
        <span id="ub-delete-unavailable" className="basis-full ub-type-small">
          Delete is unavailable while the directory is not ready to write.
        </span>
      )}
    </div>
  );
}

/** The person-facing summary and its one in-place write surface. */
function TldrCallout({
  connection,
  catalogConnection,
  canCleanupTags,
  tldr,
  editing,
  archived,
  decision,
  writable,
  onEditingChange,
}: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  canCleanupTags: (() => boolean) | undefined;
  tldr: string | null;
  editing: boolean;
  archived: boolean;
  decision: boolean;
  writable: boolean;
  onEditingChange: (editing: boolean) => void;
}): ReactElement | null {
  const [draft, setDraft] = useState(tldr ?? "");
  const initialDraft = useRef(tldr ?? "");
  const input = useRef<HTMLTextAreaElement | null>(null);
  const readOnly = archived || decision || !writable;
  const value = draft.trim();
  const tooLong = value.length > MAX_TLDR_LENGTH;
  const error = tooLong
    ? `A TL;DR is at most ${MAX_TLDR_LENGTH} characters.`
    : null;

  useEffect(() => {
    if (!editing) {
      setDraft(tldr ?? "");
      initialDraft.current = tldr ?? "";
    }
  }, [editing, tldr]);

  useEffect(() => {
    if (!editing || readOnly) return;
    // The document menu suppresses its usual trigger-focus restoration for
    // this action; focus the field after React mounts it outside that portal.
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [editing, readOnly]);

  if (!editing && tldr === null) return null;

  const write = (next: string | null): void => {
    // `readOnly` describes the committed render; the live connection and the
    // tombstone guard the write itself, as the title field does below.
    if (!canWriteContent(connection, archived)) return;
    writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null, () => setTldr(connection.ydoc, next), undefined, canCleanupTags);
    onEditingChange(false);
  };

  return (
    <section className="ub-tldr" aria-labelledby="ub-tldr-title">
      <h2 id="ub-tldr-title">TL;DR</h2>
      <div className="ub-tldr-body">
        {editing && !decision ? (
          <form
            className="ub-tldr-form"
            aria-label={`${tldr === null ? "Add" : "Edit"} TL;DR`}
            onSubmit={(event) => {
              event.preventDefault();
              if (value.length === 0 || tooLong) return;
              write(value);
            }}
            onBlur={(event) => {
              // Moving to Save, Cancel or Clear stays inside the editor.
              if (event.currentTarget.contains(event.relatedTarget)) return;
              if (draft === initialDraft.current) onEditingChange(false);
            }}
            onMouseDownCapture={(event) => {
              // Safari blurs the field without focusing a clicked button.
              // Keep the caret until its action runs, as typing shortcuts do.
              if (event.target instanceof HTMLButtonElement) event.preventDefault();
            }}
          >
            <label htmlFor="ub-tldr-input">
              Write one or two plain-English sentences that help a reader
              understand this document.
            </label>
            <textarea
              ref={input}
              id="ub-tldr-input"
              value={draft}
              readOnly={readOnly}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={
                error === null
                  ? "ub-tldr-count"
                  : "ub-tldr-count ub-tldr-error"
              }
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onEditingChange(false);
                }
              }}
            />
            <div className="ub-tldr-form-meta">
              <span id="ub-tldr-count">
                {value.length} / {MAX_TLDR_LENGTH} characters
              </span>
              {readOnly && (
                <span>
                  {archived ? "Restore to edit." : "Editing unavailable."}
                </span>
              )}
            </div>
            {error !== null && (
              <p className="ub-tldr-error" id="ub-tldr-error" role="alert">
                {error}
              </p>
            )}
            <div className="ub-tldr-actions">
              {tldr !== null && (
                <button
                  type="button"
                  className="ub-tool"
                  disabled={readOnly}
                  onClick={() => write(null)}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="ub-tool"
                onClick={() => onEditingChange(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="ub-tool ub-tool-on"
                disabled={readOnly || value.length === 0}
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <p>
            {readOnly ? tldr : (
              <button
                type="button"
                className="block w-full border-0 p-0 bg-transparent text-left [font:inherit] [color:inherit] cursor-text"
                aria-label="Edit TL;DR"
                onClick={() => {
                  if (!canWriteContent(connection, archived)) return;
                  onEditingChange(true);
                }}
              >
                {tldr}
              </button>
            )}
          </p>
        )}
      </div>
    </section>
  );
}

/** The document-local sync reading, shared by waiting and hydrated headers. */
export interface DocumentSyncReading {
  /** The hub this reading describes, null while configuration is resolving. */
  endpoint?: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  rawHubAcked?: boolean | null | undefined;
  sampledAt?: number | null | undefined;
  notSharedReason?: NotSharedReason | null;
  /** Compose the reading as a trigger within the shell's sync Popover. */
  syncDetails?: boolean;
}

/** The quiet edit row retains explicit refusals and truthful durability warnings. */
export function StatusLine({
  connection,
  presence,
  lastUpdated,
  syncReading: {
    endpoint = null,
    hubAcked,
    rawHubAcked,
    sampledAt,
    notSharedReason = null,
    syncDetails = false,
  } = {},
  onActivatePresence,
  documentLayout = false,
  statusLink,
  revision = null,
  codeChecks = [],
}: {
  connection: RoomConnection;
  /**
   * Reuse the shell title roster, including agents with retained named
   * cursors. A second subscription would repeat awareness and fragment work
   * on every keystroke.
   */
  presence: readonly RemotePresence[];
  /** The selected directory stub's edit-freshness hint, not a sync state. */
  lastUpdated?: number | undefined;
  syncReading?: DocumentSyncReading;
  /** Reveal one currently resolvable remote caret without following it. */
  onActivatePresence?: ((session: RemotePresence) => void) | undefined;
  /** Reserve the capped presence width beside hydrated prose. */
  documentLayout?: boolean;
  statusLink?: ReactNode;
  revision?: string | null;
  codeChecks?: readonly CodeCheck[] | undefined;
}): ReactElement {
  const status = useRoomStatus(connection);
  const served = hubAcked !== undefined;
  const syncAttributes = useCallback((element: HTMLDivElement | null) => {
    if (element !== null) return bindSyncAttributes(element, connection, served);
  }, [connection, served]);
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  const reading = statusReading(status, state ?? raw);
  const localWorkspace = endpoint?.url === "local";
  const facts = documentSyncFacts(status, state, reading, hubAcked, notSharedReason, localWorkspace);
  // Show this room's presence independently of its blank settle-state word.
  // App room pairing excludes the directory roster.
  const peerStrip = (
    <PeerCluster presence={presence} onActivate={onActivatePresence} reserveSpace={documentLayout} />
  );
  const blank = facts.primary === null;
  const saveProblem = blank ? null : reading.detail ?? (!status.writable ? "Changes are not saved." : null);
  // A retained serving cause is not a hub claim while its acknowledgement is
  // unknown. Publish only the condition the compact facts actually name.
  const hubProblem = facts.hub === "not shared with hub" ? facts.hubDetail : null;
  useEffect(() => {
    const saveKey = `document-status:${connection.room}:save`;
    if (saveProblem === null) toast.dismiss(saveKey);
    else toast.error(saveProblem, { id: saveKey });
  }, [connection, saveProblem]);
  useEffect(() => {
    const hubKey = `document-status:${connection.room}:hub`;
    if (hubProblem === null) toast.dismiss(hubKey);
    else toast.warning(hubProblem, { id: hubKey });
  }, [connection, hubProblem]);
  // Cause changes update the same notice; only leaving this source ends its
  // ownership. RoutePane mounts either the waiting or hydrated header.
  useEffect(() => {
    const saveKey = `document-status:${connection.room}:save`;
    const hubKey = `document-status:${connection.room}:hub`;
    return () => {
      toast.dismiss(saveKey);
      toast.dismiss(hubKey);
    };
  }, [connection]);
  const activity = useDocumentSyncActivity(connection, hubAcked, rawHubAcked, sampledAt);
  const hasHub = endpoint !== null && endpoint.url !== "local";
  const refusal = reading.detail !== null ? reading.word : hubProblem !== null ? "not shared with hub" : null;
  const unsaved = !blank && reading.detail === null && !status.writable;
  const offline = hasHub && facts.twoFact && state === "synced" && hubAcked === false && refusal === null;
  const confirmed = hasHub && raw === "synced" && status.writable && refusal === null && notSharedReason === null && activity.confirmed;
  const now = useTimestampClock();
  const formattedUpdatedAt =
    lastUpdated === undefined ? null : formatTimestamp(lastUpdated, now);
  const updatedReading =
    formattedUpdatedAt === null ? null : (
      <span className="ub-last-updated">
        Edited{" "}
        <time
          dateTime={formattedUpdatedAt.dateTime}
          title={formattedUpdatedAt.title}
        >
          {formattedUpdatedAt.label}
        </time>
      </span>
    );
  const codeNote = codeChecks.some((check) => check.result === "drift")
    ? "Differs from code"
    : null;

  // Refusals retain their compact word; recovery stays in notices and details.
  return (
    <div ref={syncAttributes} data-sync-room={connection.room} className="ub-status min-w-0 ub-type-small text-[var(--muted-foreground)] py-[0.35rem] border-b border-[var(--border)] mb-3">
      <div className="ub-status-row">
        {hasHub && <SyncDot key={connection.room} offline={offline} error={refusal !== null || unsaved} confirmed={confirmed}
          lastConfirmedAt={activity.lastConfirmedAt} pulse={activity.pulse} syncDetails={syncDetails}
          codeChecks={isDecision(connection) ? [] : codeChecks} />}
        <div className="ub-status-left">
          {updatedReading}
          {codeNote !== null && <>
            {updatedReading !== null && <span className="ub-status-separator" aria-hidden="true"> · </span>}
            <span className="ub-code-check-note text-(--status-warning-ink)">{codeNote}</span>
          </>}
          {refusal !== null && <span className="ub-status-word">{refusal}</span>}
          {unsaved && <span className="ub-not-saved">not saved</span>}
          {offline && <span className="ub-status-offline">Offline. Changes are saved on this device.</span>}
          {Boolean(statusLink) && (updatedReading !== null || codeNote !== null || refusal !== null || unsaved || offline) &&
            <span className="ub-status-separator" aria-hidden="true"> · </span>}
          {statusLink}
        </div>
        {/*
            * Use bounded circles so roster changes leave status geometry still;
            * readPresence supplies names and resolved caret locations for hover.
         */}
        {reading.detail === null && peerStrip}
        {revision !== null && <button type="button" className="ub-doc-rev" aria-label={`Copy revision ${revision}`} title={`Copy revision ${revision}`}
          onClick={() => { void writeToClipboard(revision).then((ok) => toast[ok ? "success" : "error"](ok ? "Revision copied" : "Couldn't copy the revision. Try again in a browser with clipboard access.", { id: "clipboard" })); }}>
          rev <span className="ub-doc-id">{revision.slice(0, 8)}</span>
        </button>}
      </div>
    </div>
  );
}

/**
 * Repair link conflicts per range, naming both competing targets and falling
 * back to a document UUID. Rendering never repairs anything; only a
 * deliberate pick removes the competing mark. Separate ranges may need
 * different answers.
 */
function LinkConflictRepair({
  connection,
  catalogConnection,
  canCleanupTags,
  contentReadOnly,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  canCleanupTags: (() => boolean) | undefined;
  contentReadOnly: boolean;
  writable: boolean;
  docLinks: DocLinkContext | null;
}): ReactElement | null {
  const { conflicts, refresh } = useLinkConflicts(connection);
  const repair = (conflict: LinkConflict, keep: LinkSurvivor): void => {
    // Guard the write too: the room can become a decision before React observes it.
    if (!canWriteContent(connection, contentReadOnly)) return;
    writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null, () => repairLinkConflict(conflict, keep), undefined, canCleanupTags);
    // Unconditional: a repair changes the list, and a refusal means live state
    // has already moved on without this render hearing about it yet.
    refresh();
  };
  // Restoring an archive never permits edits to decision content.
  if (contentReadOnly || !writable || conflicts.length === 0) return null;
  const name = (docId: string): string => docLinks?.lookup(docId).title ?? docId;
  return (
    <div className="ub-link-repair">
      <p>
        One range, two links. Keep one of each pair — the other mark is cleared
        from that range, and nothing else in the block changes.
      </p>
      <ul>
        {conflicts.map((conflict) => (
          <li
            key={`${conflict.index}:${conflict.cell?.row ?? "prose"}:${conflict.cell?.column ?? ""}:${conflict.textIndex}:${conflict.start}:${conflict.end}`}
          >
            <q>{conflict.label}</q>
            <button
              type="button"
              className="ub-tool"
              onClick={() => repair(conflict, "docLink")}
            >
              Keep the document: {name(conflict.docId)}
            </button>
            <button
              type="button"
              className="ub-tool"
              onClick={() => repair(conflict, "link")}
            >
              Keep the link: {conflict.href}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Do not bind unsupported content: y-prosemirror deletes elements absent from
 * its schema. Preserve it read-only, and let summary distinguish foreign
 * content from supported link marks that conflict on one range.
 */
function ForeignFallback({
  connection,
  catalogConnection,
  canCleanupTags,
  summary,
  contentReadOnly,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  canCleanupTags: (() => boolean) | undefined;
  summary: string;
  contentReadOnly: boolean;
  writable: boolean;
  docLinks: DocLinkContext | null;
}): ReactElement {
  const blocks = useRawBlocks(connection);
  return (
    <div className="ub-foreign">
      <p className="ub-foreign-banner">
        <strong>Editor disabled.</strong> {summary}
      </p>
      <LinkConflictRepair
        connection={connection}
        catalogConnection={catalogConnection}
        canCleanupTags={canCleanupTags}
        contentReadOnly={contentReadOnly}
        writable={writable}
        docLinks={docLinks}
      />
      <ol className="ub-foreign-list">
        {blocks.map((block, index) => (
          <li key={block.id ?? `index-${index}`}>
            <code>{block.nodeName}</code>
            <span className="ub-muted"> {block.id ?? "(no id)"}</span>
            <pre>{block.text}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

// The shell's presence reading also changes when a caret crosses blocks. Keep
// that parent update outside the editor; its own peer-name/status readers stay
// live, and actual binding inputs still pass through React's props comparison.
const BoundEditor = memo(function BoundEditor({
  connection,
  catalogConnection,
  canCleanupTags,
  author,
  archived,
  historyActive = false,
  contentReadOnly,
  docLinks,
  onSelectThread,
}: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  canCleanupTags: (() => boolean) | undefined;
  author: string;
  /** Archived documents also withhold comments. */
  archived: boolean;
  historyActive?: boolean;
  /** Title, decision line and blocks cannot change; comments may stay open. */
  contentReadOnly: boolean;
  /** See {@link EditorPane}. Must be referentially stable — it binds the editor. */
  docLinks: DocLinkContext | null;
  onSelectThread: SelectThread;
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [bindingEpoch, setBindingEpoch] = useState(0);
  const { writable } = useRoomStatus(connection);
  // The only names anyone can mention are the peers publishing awareness right
  // now — there is no registry, and a mention is plain text.
  const peers = usePeers(connection);
  /**
   * The binding effect reads the latest read-only flag without depending on
   * it: initial binding must already enforce read-only, and later permission
   * changes must not rebind.
   */
  const readContentReadOnly = useEffectEvent(() => contentReadOnly);
  const readCleanupPermission = useEffectEvent(() => canCleanupTags?.() !== false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The epoch rebinds after the synchronous guard destroys an editor that normalization immediately made bindable again.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    // bindGuardedEditor registers its synchronous guard before binding. A
    // foreign block arriving later unbinds the editor without deleting it,
    // then useForeignBlocks displays the fallback.
    const binding = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(connection.ydoc),
      awareness: connection.provider.awareness,
      editable: canWriteContent(connection, readContentReadOnly()),
      canWrite: () => connection.status.writable,
      canCleanupTags: () => canWriteContent(connection, readContentReadOnly()) && readCleanupPermission(),
      canNormalize: () => connection.status.writable && connection.status.synced,
      onUnbind: () => {
        setEditor(null);
        setBindingEpoch((epoch) => epoch + 1);
      },
      docLinks,
      workspaceSettings: catalogConnection?.ydoc ?? null,
    });
    // Delegate comment-highlight clicks on the host. Document references and
    // external links win over surrounding thread selection so one gesture has
    // one action; the conversation remains reachable from adjacent highlight
    // or rail.
    const selectThread = (threadId: string, viaKeyboard = false): void => {
      onSelectThread(threadId, {
        viaKeyboard,
        // Only a resolved anchor takes the rail's one expansion slot. An open
        // anchor leaves the resolved conversation a reader already expanded
        // alone, while a card keeps its own toggle gesture.
        revealResolved:
          getAnnotation(connection.ydoc, threadId)?.resolved === true,
      });
    };
    const activate = (event: MouseEvent): void => {
      const docId = docLinkFromTarget(event.target);
      if (docId !== null) {
        if (docLinks?.lookup(docId).state === "deleted") {
          event.preventDefault();
          return;
        }
        // A modifier or a middle button is the browser's business — the anchor
        // carries a real address, so cmd-click still opens a tab. Everything
        // else navigates in-app, which is what keeps Back working.
        if (isPlainClick(event) && docLinks !== null) {
          event.preventDefault();
          docLinks.open(docId);
        }
        return;
      }
      const anchor = linkAnchorFromTarget(event.target);
      if (anchor !== null) {
        // Editable links open through ProseMirror's non-moving handleClick,
        // never this DOM click (which also fires after a selection drag). A
        // read-only link keeps its native target/rel behavior, including links
        // in a data view's noneditable chrome inside an editable document.
        // Refuse other schemes even if an anchor's DOM was changed.
        if (
          (binding.editor?.isEditable && anchor.closest(".ub-chart-panel") === null) ||
          event.shiftKey ||
          !isExternalHref(anchor.getAttribute("href"))
        ) {
          event.preventDefault();
        }
        return;
      }
      const threadId = threadIdFromTarget(event.target);
      if (threadId !== null) selectThread(threadId);
    };
    // Enter/Space activates only a focused button-role highlight. Capture and
    // stop activation before ProseMirror can split a block; caret typing
    // targets the contenteditable and must remain untouched.
    const activateThread = (event: KeyboardEvent): void => {
      // Enter on a focused read-only reference navigates in-app, preserving
      // Back and avoiding surrounding thread selection. Caret typing targets
      // contenteditable, outside the anchor.
      const docId = docLinkFromTarget(event.target);
      if (docId !== null) {
        if (docLinks?.lookup(docId).state === "deleted") {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (event.key !== "Enter" || docLinks === null) return;
        event.preventDefault();
        event.stopPropagation();
        docLinks.open(docId);
        return;
      }
      const anchor = linkAnchorFromTarget(event.target);
      if (anchor !== null) {
        // Enter on a focused read-only anchor belongs to the browser; neither
        // Enter nor Space on it activates the surrounding comment highlight.
        if (
          event.key === "Enter" &&
          !isExternalHref(anchor.getAttribute("href"))
        ) {
          event.preventDefault();
        }
        return;
      }
      const threadId = threadIdFromActivation(event);
      if (threadId === null) return;
      event.preventDefault();
      event.stopPropagation();
      selectThread(threadId, true);
    };
    element.addEventListener("click", activate);
    element.addEventListener("keydown", activateThread, true);
    setEditor(binding.editor);
    return () => {
      element.removeEventListener("click", activate);
      element.removeEventListener("keydown", activateThread, true);
      setEditor(null);
      binding.destroy();
    };
  }, [connection, catalogConnection, docLinks, onSelectThread, bindingEpoch]);

  /**
   * Change ProseMirror editable in place to preserve caret, scroll, selection
   * and copying while refusing keys, beforeinput, paste and drop. Use a
   * layout effect so the banner and editor permissions agree in the same
   * painted commit.
   */
  useLayoutEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.setEditable(!contentReadOnly && !isDecision(connection) && writable);
    if (!archived && !historyActive && writable) {
      // A repair suppressed while the link was gone gets another plugin pass
      // as soon as the admitted room is writable again. Automatic block-id
      // maintenance remains independent of decision content permissions.
      editor.view.dispatch(editor.state.tr.setMeta("uberblick:writable", true));
    }
  }, [editor, connection, archived, contentReadOnly, historyActive, writable]);

  return (
    <>
      {/* The composer and gutter button use this frame. ProseMirror owns the
          source DOM; the code caption's dedicated slot hosts React chrome. */}
      <div className="ub-editor-frame" ref={frame}>
        <div className="ub-editor" ref={host} />
        {editor !== null && (
          <CardButtonControls
            editor={editor}
            canWrite={() => canWriteContent(connection, contentReadOnly)}
          />
        )}
        {editor !== null && !contentReadOnly && writable && (
          <CodeLanguageControl
            editor={editor}
            canWrite={() => canWriteContent(connection, contentReadOnly)}
          />
        )}
        {/* Decision content offers no editing controls, but discussion stays
            open. An archive also withholds the comment composer. */}
        {editor !== null && !contentReadOnly && writable && (
          <BlockMenu editor={editor} host={frame} />
        )}
        {editor !== null && !contentReadOnly && writable && (
          <TableControls editor={editor} host={frame} />
        )}
        {editor !== null && !contentReadOnly && writable && (
          <EmojiMenu editor={editor} host={frame} />
        )}
        {editor !== null && !contentReadOnly && writable && (
          <MentionMenu
            editor={editor}
            host={frame}
            docLinks={docLinks}
            // Read the document identity from its current room key, using the
            // shared parser.
            openDocId={parseRoom(connection.room).uuid}
          />
        )}
        {editor !== null && !archived && writable && (
          <CommentComposer
            editor={editor}
            hidden={historyActive}
            contentReadOnly={contentReadOnly}
            ydoc={connection.ydoc}
            catalogConnection={catalogConnection}
            canCleanupTags={canCleanupTags}
            author={author}
            mentions={peers.map((peer) => peer.name)}
            host={frame}
            onCreated={onSelectThread}
          />
        )}
      </div>
    </>
  );
});

export function EditorPane({
  connection,
  segment,
  presence,
  author,
  catalogConnection = null,
  canCleanupTags,
  archived,
  updatedAt,
  actions = {},
  isDecisionTopic = false,
  topicArchived = false,
  actionTitle,
  docLinks,
  onSelectThread,
  syncReading = {},
  threads = [],
  threadsOpen = false,
  onToggleThreads,
  header,
  beforeAnswer,
  afterAnswer,
  statusLink,
  answerClassName,
  copyPath,
  decisionView = false,
  displayTitle,
  historyControl,
  historyActive = false,
}: {
  connection: RoomConnection;
  /** The workspace as the address spells it — see {@link DocMetaLine}. */
  segment: string;
  /** This room's presence reading, passed through to {@link StatusLine}. */
  presence: readonly RemotePresence[];
  /** The awareness name this client publishes — the author of its comments. */
  author: string;
  /** The workspace settings room that owns the curated tag catalog. */
  catalogConnection?: RoomConnection | null;
  canCleanupTags?: (() => boolean) | undefined;
  /**
   * Observe directory tombstones in both directions so remote archive and
   * restore update this pane.
   */
  archived: boolean;
  /** The selected directory stub's edit-freshness hint. */
  updatedAt?: number | undefined;
  actions?: DocumentActionProps;
  isDecisionTopic?: boolean;
  topicArchived?: boolean;
  actionTitle?: string | undefined;
  /**
   * References use the current workspace address, directory titles and
   * navigation callback; null means no workspace. Keep the object stable
   * because it is a binding dependency.
   */
  docLinks: DocLinkContext | null;
  /**
   * Notify the rail of a clicked highlight or newly created thread. Keep this
   * callback stable because it is a binding dependency.
   */
  onSelectThread: SelectThread;
  syncReading?: DocumentSyncReading;
  threads?: readonly ThreadView[];
  threadsOpen?: boolean;
  onToggleThreads?: (() => void) | undefined;
  /** Topic pages supply their shared title. */
  header?: ReactNode;
  displayTitle?: string;
  beforeAnswer?: ReactNode;
  afterAnswer?: ReactNode;
  /** Read-only page chrome in the line under the title. */
  statusLink?: ReactNode;
  answerClassName?: string;
  /** Copy the topic or explicit history selection currently displayed. */
  copyPath?: string;
  /** A known decision route stays read-only while its room metadata catches up. */
  decisionView?: boolean;
  historyControl?: ReactNode;
  historyActive?: boolean | undefined;
}): ReactElement {
  const pane = useRef<HTMLElement | null>(null);
  const [tldrEditorRoom, setTldrEditorRoom] = useState<string | null>(null);
  const revealPresence = useCallback((session: RemotePresence): void => {
    if (session.blockId === null) return;
    const target = document.getElementById(session.blockId);
    if (
      target === null ||
      pane.current === null ||
      !pane.current.contains(target) ||
      target.closest(".ub-editor") === null
    ) {
      return;
    }
    revealFoldedTarget(target);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const observedMeta = useDocMeta(connection);
  const revision = useDocRev(connection);
  // RoutePane admits only hydrated documents. Its child subscription starts
  // after mounting, so read this exact connection on the first frame too.
  const meta = observedMeta ?? readRoomMeta(connection);
  const decision = decisionView || meta?.kind === "decision";
  const contentReadOnly = archived || decision || historyActive;
  const foreign = useForeignBlocks(connection);
  const { writable } = useRoomStatus(connection);
  const openThreads = threads.filter((thread) => !thread.resolved).length;
  const editingTldr = meta?.kind !== "decision" && meta?.tldrOptOut !== true && connection.room === tldrEditorRoom;

  useEffect(() => {
    if (meta?.tldrOptOut === true) setTldrEditorRoom(null);
  }, [meta?.tldrOptOut]);

  // The shared page pane anchors the column beside the sibling rail;
  // document controls use `ub-document-pane` to find their scroll container.
  return (
    <section className="ub-pane ub-page-pane ub-document-pane" ref={pane}
      inert={historyActive} style={historyActive ? { display: "none" } : undefined}>
      {threads.length > 0 && onToggleThreads !== undefined && (
        <button
          type="button"
          className="ub-threads-toggle ub-pane-threads-toggle hidden max-xl:inline-flex items-center gap-[0.35rem] [font-family:inherit] [font-weight:inherit] ub-type-caption border border-border rounded-full py-[0.1rem] px-[0.55rem] bg-(--card-accent) text-secondary-foreground whitespace-nowrap cursor-pointer"
          aria-expanded={threadsOpen}
          aria-controls="ub-rail"
          onClick={onToggleThreads}
        >
          Threads <span className="ub-muted">{openThreads}</span>
        </button>
      )}
      <div className="ub-column">
        {archived && (
          <ArchivedBanner actions={actions} title={actionTitle || meta?.title || "Untitled"} decision={decision} topicArchived={topicArchived} />
        )}
        {/* Keep document kind, tags and revision above the title. */}
        <DocMetaLine
          connection={connection}
          catalogConnection={catalogConnection}
          canCleanupTags={canCleanupTags}
          segment={segment}
          meta={meta === null || displayTitle === undefined ? meta : { ...meta, title: displayTitle }}
          actionTitle={actionTitle}
          archived={archived}
          readOnly={!writable}
          contentReadOnly={decision}
          copyPath={copyPath}
          actions={actions}
          isDecisionTopic={isDecisionTopic}
          hasTldr={meta?.tldr != null}
          onEditTldr={() => {
            if (!canWriteContent(connection, contentReadOnly)) return;
            if (getMeta(connection.ydoc).tldrOptOut === true) writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null, () => setTldrOptOut(connection.ydoc, false), undefined, canCleanupTags);
            setTldrEditorRoom(connection.room);
          }}
          onRemoveTldr={() => {
            if (!canWriteContent(connection, contentReadOnly)) return;
            writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null, () => setTldrOptOut(connection.ydoc, true), undefined, canCleanupTags);
            setTldrEditorRoom(null);
          }}
        />
        {header ?? <DocumentTitle
          value={meta?.title ?? ""}
          readOnly={contentReadOnly || !writable}
          // Guard the live write too: a document may become a decision before
          // this readOnly render updates.
          onChange={(value) => {
            if (!canWriteContent(connection, contentReadOnly)) return;
            writeDocument(connection.ydoc, catalogConnection?.ydoc ?? null, () => setTitle(connection.ydoc, value), undefined, canCleanupTags);
          }}
        />}
        {/* The editor draws only for a document that is here: `RoutePane` sends
            everything else to the waiting screen. */}
        <StatusLine
          connection={connection}
          documentLayout
          presence={presence}
          lastUpdated={updatedAt}
          syncReading={syncReading}
          onActivatePresence={revealPresence}
          statusLink={statusLink}
          revision={revision}
          codeChecks={meta?.code_check}
        />
        {historyControl}
        {beforeAnswer}
        <div className={answerClassName}>
          {!decision && <TldrCallout
            key={connection.room}
            connection={connection}
            catalogConnection={catalogConnection}
            canCleanupTags={canCleanupTags}
            tldr={meta?.tldr ?? null}
            editing={editingTldr}
            archived={archived || historyActive}
            decision={decision}
            writable={writable && !historyActive}
            onEditingChange={(editing) =>
              setTldrEditorRoom(editing ? connection.room : null)
            }
          />}
          {foreign.length > 0 ? (
            <ForeignFallback
              connection={connection}
              catalogConnection={catalogConnection}
              canCleanupTags={canCleanupTags}
              summary={describeForeignBlocks(foreign, { repairable: !contentReadOnly, decision })}
              contentReadOnly={contentReadOnly}
              writable={writable}
              docLinks={docLinks}
            />
          ) : (
            <BoundEditor
              connection={connection}
              catalogConnection={catalogConnection}
              canCleanupTags={canCleanupTags}
              author={author}
              archived={archived}
              historyActive={historyActive}
              contentReadOnly={contentReadOnly}
              docLinks={docLinks}
              onSelectThread={onSelectThread}
            />
          )}
        </div>
        {afterAnswer}
      </div>
    </section>
  );
}

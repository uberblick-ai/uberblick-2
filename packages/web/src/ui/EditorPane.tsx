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
  setTitle,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { bindGuardedEditor } from "../editor/guarded-binding.js";
import { docLinkFromTarget } from "../editor/doc-links.js";
import type { DocLinkContext } from "../editor/doc-links.js";
import { linkAnchorFromTarget } from "../editor/external-links.js";
import { describeForeignBlocks } from "../editor/palette.js";
import type { LinkConflict } from "../editor/palette.js";
import { repairLinkConflict } from "../editor/link-repair.js";
import type { LinkSurvivor } from "../editor/link-repair.js";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import type { NotSharedReason } from "../shell/document-search.js";
import { notifySticky, resolveSticky } from "../notifications.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import type { SyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
import { documentSyncFacts } from "./sync-facts.js";
import { formatTimestamp, useTimestampClock } from "./timestamps.js";
import { BlockMenu } from "./BlockMenu.js";
import { CodeLanguageControl } from "./CodeLanguageControl.js";
import { CardButtonControls } from "./CardButtonControls.js";
import { TableControls } from "./TableControls.js";
import { MentionMenu } from "./MentionMenu.js";
import {
  useDocMeta,
  useForeignBlocks,
  useLinkConflicts,
  usePeers,
  useRawBlocks,
  useRoomStatus,
} from "./hooks.js";
import type { RemotePresence } from "./doc-chrome.js";
import { CommentComposer } from "./CommentComposer.js";
import { PeerCluster } from "./PeerCluster.js";
import { PopoverTrigger } from "./shadcn/popover.js";
import { DocMetaLine } from "./DocChrome.js";
import { threadIdFromActivation, threadIdFromTarget } from "./threads.js";
import type { SelectThread, ThreadView } from "./threads.js";

/** Read the document itself, including before its React subscription answers. */
function isDecision(connection: RoomConnection): boolean {
  return getMeta(connection.ydoc).kind === "decision";
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
    <section className={`ub-pane${documentLayout ? " ub-document-pane" : ""}`}>
      <div className="ub-column">{children}</div>
    </section>
  );
}

/**
 * Archived content stays rendered, scrollable and copyable. Restore is the
 * only write action; title, editor and comments remain read-only while the
 * directory tombstone stands.
 */
function ArchivedBanner({
  onRestore,
  focusRestore,
  onRestoreFocused,
}: {
  onRestore: (() => void) | null;
  focusRestore: boolean;
  onRestoreFocused?: (() => void) | undefined;
}): ReactElement {
  const restore = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!focusRestore) return;
    restore.current?.focus();
    onRestoreFocused?.();
  }, [focusRestore, onRestoreFocused]);
  return (
    <p className="ub-archived-banner mb-3 flex flex-wrap items-baseline gap-2 rounded-(--radius) border border-(--status-warning) bg-(--status-warning-subtle) px-3 py-[0.6rem] leading-[1.5] text-(--foreground)">
      <span><strong className="font-medium">Archived.</strong> Read-only and hidden from the document list.</span>
      <button
        ref={restore}
        type="button"
        className="ml-auto cursor-pointer rounded-(--radius-sm) border border-(--border) bg-(--secondary) px-[0.45rem] py-[0.15rem] font-[inherit] text-xs text-(--secondary-foreground)"
        disabled={onRestore === null}
        onClick={() => onRestore?.()}
      >
        {onRestore === null ? "Restore unavailable" : "Restore"}
      </button>
      {onRestore === null && (
        <span className="ub-restore-unavailable basis-full text-xs">
          Restore is unavailable while the directory is not ready to write.
        </span>
      )}
    </p>
  );
}

function SparklesIcon(): ReactElement {
  return (
    <svg className="ub-tldr-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c.45 3.35 2.15 5.05 5.5 5.5-3.35.45-5.05 2.15-5.5 5.5C11.55 10.15 9.85 8.45 6.5 8 9.85 7.55 11.55 5.85 12 2.5Z" />
      <path d="M18.25 13.5c.25 1.85 1.4 3 3.25 3.25-1.85.25-3 1.4-3.25 3.25-.25-1.85-1.4-3-3.25-3.25 1.85-.25 3-1.4 3.25-3.25ZM5 13c.2 1.35 1 2.15 2.35 2.35C6 15.55 5.2 16.35 5 17.7c-.2-1.35-1-2.15-2.35-2.35C4 15.15 4.8 14.35 5 13Z" />
    </svg>
  );
}

/** The person-facing summary and its one in-place write surface. */
function TldrCallout({
  connection,
  tldr,
  editing,
  archived,
  decision,
  writable,
  onEditingChange,
}: {
  connection: RoomConnection;
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
    if (archived || getMeta(connection.ydoc).kind === "decision" || !connection.status.writable) return;
    setTldr(connection.ydoc, next);
    onEditingChange(false);
  };

  return (
    <section className="ub-tldr" aria-labelledby="ub-tldr-title">
      <div className="ub-tldr-header">
        <span className="ub-tldr-mark">
          <SparklesIcon />
        </span>
        <div className="ub-tldr-heading">
          <span className="ub-tldr-label">Quick summary</span>
          <h2 id="ub-tldr-title">TL;DR</h2>
        </div>
      </div>
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
                  if (archived || getMeta(connection.ydoc).kind === "decision" || !connection.status.writable) return;
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

/**
 * Debounce status redraws while reserving each mark and its longest label.
 * Persistent backlogs still read busy; counts and recovery prose belong to
 * details and notices so the compact line does not shift.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
export function StatusLine({
  connection,
  presence,
  lastUpdated,
  onLastUpdatedChange,
  endpoint = null,
  hubAcked,
  notSharedReason = null,
  syncDetails = false,
  onActivatePresence,
  documentLayout = false,
  statusLink,
}: {
  connection: RoomConnection;
  /**
   * Reuse the shell title roster, including agents with retained named
   * cursors; Sync details uses live presence. A second subscription would
   * repeat awareness and fragment work on every keystroke.
   */
  presence: readonly RemotePresence[];
  /** The selected directory stub's edit-freshness hint, not a sync state. */
  lastUpdated?: number | undefined;
  /** Report the displayed stamp so the details panel mirrors this segment. */
  onLastUpdatedChange?:
    | ((room: string, value: number | undefined) => void)
    | undefined;
  /** The hub this reading describes, null while configuration is resolving. */
  endpoint?: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  notSharedReason?: NotSharedReason | null;
  /** Compose the reading as a trigger within the shell's sync Popover. */
  syncDetails?: boolean;
  /** Reveal one currently resolvable remote caret without following it. */
  onActivatePresence?: ((session: RemotePresence) => void) | undefined;
  /** Reserve the capped presence width beside hydrated prose. */
  documentLayout?: boolean;
  statusLink?: ReactNode;
}): ReactElement {
  const status = useRoomStatus(connection);
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  const reading = statusReading(status, state ?? raw);
  const localWorkspace = endpoint?.url === "local";
  const facts = documentSyncFacts(status, state, reading, hubAcked, notSharedReason, localWorkspace);
  const saveNote =
    !status.writable && reading.detail === null ? (
      <span className="ub-muted ub-not-saved flex-none whitespace-nowrap">not saved</span>
    ) : null;
  // Show this room's presence independently of its blank settle-state word.
  // App room pairing excludes the directory roster.
  const peerStrip = (
    <PeerCluster presence={presence} onActivate={onActivatePresence} reserveSpace={documentLayout} />
  );
  const mark = (tone: SyncState | null): ReactElement => (
    <span className="ub-status-mark" aria-hidden="true">
      {tone === "syncing" ? (
        <span className="ub-spinner" />
      ) : tone === null ? null : (
        <span
          className={`ub-dot ${tone === "synced" ? "ub-dot-live" : "ub-dot-off"}`}
        />
      )}
    </span>
  );
  const primary = (
    <span className="inline-flex flex-none items-center gap-2">
      {mark(facts.primaryTone)}
      <span
        className={`ub-status-word${facts.twoFact ? " ub-status-word--saved" : saveNote !== null ? " ub-status-word--unsaved" : ""}`}
      >
        {facts.primary}
      </span>
    </span>
  );
  const hubFact = facts.twoFact && !localWorkspace ? (
    <span className="inline-flex flex-none items-center gap-2">
      {mark(facts.hubTone)}
      <span className="ub-status-word ub-status-word--hub">{facts.hub}</span>
    </span>
  ) : null;
  const blank = facts.primary === null;
  const saveProblem = blank ? null : reading.detail ?? (!status.writable ? "Changes are not saved." : null);
  // A retained serving cause is not a hub claim while its acknowledgement is
  // unknown. Publish only the condition the compact facts actually name.
  const hubProblem = facts.hub === "not shared with hub" ? facts.hubDetail : null;
  useEffect(() => {
    const saveKey = `document-status:${connection.room}:save`;
    const hubKey = `document-status:${connection.room}:hub`;
    if (saveProblem === null) resolveSticky(saveKey);
    else notifySticky({ key: saveKey, message: saveProblem, severity: "error" });
    if (hubProblem === null) resolveSticky(hubKey);
    else notifySticky({ key: hubKey, message: hubProblem, severity: "warning" });
  }, [connection, saveProblem, hubProblem]);
  // Cause changes update the same notice; only leaving this source ends its
  // ownership. RoutePane mounts either the waiting or hydrated header.
  useEffect(() => {
    const saveKey = `document-status:${connection.room}:save`;
    const hubKey = `document-status:${connection.room}:hub`;
    return () => {
      resolveSticky(saveKey);
      resolveSticky(hubKey);
    };
  }, [connection]);
  const hub =
    endpoint === null || (hubAcked !== undefined && !facts.twoFact)
      ? null
      : `${endpoint.url ?? "unknown"} (${endpointSourceLabel(endpoint.source)})`;
  const factLabel = [facts.primary, facts.hub].filter(
    (value): value is string => value !== null,
  );
  // The serving view's intrinsic minimum protects its fixed fact slots and
  // already exceeds the target floor, even while the status words are blank.
  const syncReading =
    !syncDetails ? (
      <>
        {primary}
        {hubFact}
      </>
    ) : (
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`ub-status-sync ub-sync-toggle inline-flex min-h-6 [@media(any-pointer:coarse)]:min-h-11 cursor-pointer items-center gap-2 -my-[0.2rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.3rem] py-[0.2rem] [font:inherit] text-inherit hover:bg-(--card-accent) hover:text-(--secondary-foreground) focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1${hubAcked === undefined ? " flex-none min-w-6 [@media(any-pointer:coarse)]:min-w-11" : " min-w-min max-w-full flex-wrap"}`}
          aria-label={
            factLabel.length === 0
              ? hub === null
                ? "Sync details"
                : `Sync details — hub ${hub}`
              : hub === null
                ? `Sync details — ${factLabel.join(", ")}`
                : `Sync details — ${factLabel.join(", ")}${facts.twoFact ? ";" : ","} hub ${hub}`
          }
          title={hub === null ? "Sync details" : `Sync details — hub ${hub}`}
        >
          {primary}
          {hubFact}
        </button>
      </PopoverTrigger>
    );
  const now = useTimestampClock();
  const formattedUpdatedAt =
    lastUpdated === undefined ? null : formatTimestamp(lastUpdated, now);
  const updatedReading =
    formattedUpdatedAt === null ? null : (
      <span className="ub-last-updated">
        <span aria-hidden="true">·</span> last updated{" "}
        <time
          dateTime={formattedUpdatedAt.dateTime}
          title={formattedUpdatedAt.title}
        >
          {formattedUpdatedAt.label}
        </time>
      </span>
    );
  const shownUpdatedAt =
    blank || formattedUpdatedAt === null ? undefined : lastUpdated;
  const statusFacts = <>
    {syncReading}
    {!blank && saveNote}
    {!blank && updatedReading}
  </>;
  // Report the displayed timestamp before paint, paired with its room
  // including cleanup. The separately mounted details panel must not restart
  // its settle window or invent an omitted stamp.
  useLayoutEffect(() => {
    onLastUpdatedChange?.(connection.room, shownUpdatedAt);
    return () => onLastUpdatedChange?.(connection.room, undefined);
  }, [connection.room, onLastUpdatedChange, shownUpdatedAt]);

  // Refusals retain their compact word; recovery stays in notices and details.
  return (
    <div className="ub-status min-w-0 text-[0.8rem]/[1.2] text-[var(--muted-foreground)] py-[0.35rem] border-b border-[var(--border)] mb-3">
      <div className="flex min-w-0 min-h-7 items-center gap-2">
        {statusLink ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {statusFacts}
          {statusLink}
        </div> : statusFacts}
        {/*
            * Use bounded circles so roster changes leave status geometry still;
            * readPresence supplies names and resolved caret locations for hover.
         */}
        {reading.detail === null && peerStrip}
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
  contentReadOnly,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
  contentReadOnly: boolean;
  writable: boolean;
  docLinks: DocLinkContext | null;
}): ReactElement | null {
  const { conflicts, refresh } = useLinkConflicts(connection);
  const repair = (conflict: LinkConflict, keep: LinkSurvivor): void => {
    // Guard the write too: the room can become a decision before React observes it.
    if (contentReadOnly || isDecision(connection) || !connection.status.writable) return;
    repairLinkConflict(conflict, keep);
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
  summary,
  contentReadOnly,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
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
  author,
  archived,
  contentReadOnly,
  docLinks,
  onSelectThread,
}: {
  connection: RoomConnection;
  catalogConnection: RoomConnection | null;
  author: string;
  /** Archived documents also withhold comments. */
  archived: boolean;
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
      editable: !readContentReadOnly() && !isDecision(connection) && connection.status.writable,
      canWrite: () => connection.status.writable,
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
        // A modifier or a middle button is the browser's business — the anchor
        // carries a real address, so cmd-click still opens a tab. Everything
        // else navigates in-app, which is what keeps Back working.
        const modified =
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey;
        if (!modified && docLinks !== null) {
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
    if (!archived && writable) {
      // A repair suppressed while the link was gone gets another plugin pass
      // as soon as the admitted room is writable again. Automatic block-id
      // maintenance remains independent of decision content permissions.
      editor.view.dispatch(editor.state.tr.setMeta("uberblick:writable", true));
    }
  }, [editor, connection, archived, contentReadOnly, writable]);

  return (
    <>
      {/* The composer and gutter button use this frame. ProseMirror owns the
          source DOM; the code caption's dedicated slot hosts React chrome. */}
      <div className="ub-editor-frame" ref={frame}>
        <div className="ub-editor" ref={host} />
        {editor !== null && (
          <CardButtonControls
            editor={editor}
            canWrite={() => !contentReadOnly && !isDecision(connection) && connection.status.writable}
          />
        )}
        {editor !== null && !contentReadOnly && writable && (
          <CodeLanguageControl
            editor={editor}
            canWrite={() => !contentReadOnly && !isDecision(connection) && connection.status.writable}
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
            contentReadOnly={contentReadOnly}
            ydoc={connection.ydoc}
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
  archived,
  updatedAt,
  onLastUpdatedChange,
  pinned = false,
  onTogglePin = null,
  onArchive = null,
  onArchiveConfirmationFocusChange,
  focusRestore = false,
  onRestoreFocused,
  docLinks,
  onRestore,
  onSelectThread,
  endpoint = null,
  hubAcked,
  notSharedReason = null,
  threads = [],
  threadsOpen = false,
  onToggleThreads,
  syncDetails = false,
  header,
  beforeAnswer,
  afterAnswer,
  statusLink,
  answerClassName,
  copyPath,
  decisionView = false,
}: {
  connection: RoomConnection | null;
  /** The workspace as the address spells it — see {@link DocMetaLine}. */
  segment: string;
  /** This room's presence reading, passed through to {@link StatusLine}. */
  presence: readonly RemotePresence[];
  /** The awareness name this client publishes — the author of its comments. */
  author: string;
  /** The workspace settings room that owns the curated tag catalog. */
  catalogConnection?: RoomConnection | null;
  /**
   * Observe directory tombstones in both directions so remote archive and
   * restore update this pane.
   */
  archived: boolean;
  /** The selected directory stub's edit-freshness hint. */
  updatedAt?: number | undefined;
  onLastUpdatedChange?:
    | ((room: string, value: number | undefined) => void)
    | undefined;
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  onArchive?: (() => void) | null;
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  focusRestore?: boolean;
  onRestoreFocused?: (() => void) | undefined;
  /**
   * References use the current workspace address, directory titles and
   * navigation callback; null means no workspace. Keep the object stable
   * because it is a binding dependency.
   */
  docLinks: DocLinkContext | null;
  /** Lift the tombstone. */
  onRestore: (() => void) | null;
  /**
   * Notify the rail of a clicked highlight or newly created thread. Keep this
   * callback stable because it is a binding dependency.
   */
  onSelectThread: SelectThread;
  endpoint?: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  notSharedReason?: NotSharedReason | null;
  threads?: readonly ThreadView[];
  threadsOpen?: boolean;
  onToggleThreads?: (() => void) | undefined;
  syncDetails?: boolean;
  /** Topic pages supply their own read-only title and related-page link. */
  header?: ReactNode;
  beforeAnswer?: ReactNode;
  afterAnswer?: ReactNode;
  /** Read-only page chrome in the line under the title. */
  statusLink?: ReactNode;
  answerClassName?: string;
  /** Copy the topic or explicit history selection currently displayed. */
  copyPath?: string;
  /** A known decision route stays read-only while its room metadata catches up. */
  decisionView?: boolean;
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
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const observedMeta = useDocMeta(connection);
  // RoutePane admits only hydrated documents. Its child subscription starts
  // after mounting, so read this exact connection on the first frame too.
  const meta = observedMeta ?? (connection === null ? null : getMeta(connection.ydoc));
  const decision = decisionView || meta?.kind === "decision";
  const contentReadOnly = archived || decision;
  const foreign = useForeignBlocks(connection);
  const { writable } = useRoomStatus(connection);
  const openThreads = threads.filter((thread) => !thread.resolved).length;
  const editingTldr = meta?.kind !== "decision" && connection?.room === tldrEditorRoom;

  if (connection === null) {
    return (
      <PaneNotice>
        <p className="ub-muted">Pick a document, or create one.</p>
      </PaneNotice>
    );
  }

  // `ub-pane` is the scroll container; `ub-document-pane` keeps this column
  // and the sibling rail in one left-anchored composition.
  return (
    <section className="ub-pane ub-document-pane" ref={pane}>
      {threads.length > 0 && onToggleThreads !== undefined && (
        <button
          type="button"
          className="ub-threads-toggle ub-pane-threads-toggle hidden max-xl:inline-flex items-center gap-[0.35rem] [font-family:inherit] [font-weight:inherit] text-xs leading-[1.6] border border-border rounded-full py-[0.1rem] px-[0.55rem] bg-(--card-accent) text-secondary-foreground whitespace-nowrap cursor-pointer"
          aria-expanded={threadsOpen}
          aria-controls="ub-rail"
          onClick={onToggleThreads}
        >
          Threads <span className="ub-muted">{openThreads}</span>
        </button>
      )}
      <div className="ub-column">
        {archived && (
          <ArchivedBanner
            onRestore={onRestore}
            focusRestore={focusRestore}
            onRestoreFocused={onRestoreFocused}
          />
        )}
        {/* Keep document kind, tags and revision above the title. */}
        <DocMetaLine
          connection={connection}
          catalogConnection={catalogConnection}
          segment={segment}
          meta={meta}
          archived={archived}
          readOnly={!writable}
          contentReadOnly={decision}
          copyPath={copyPath}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onArchive={onArchive}
          onArchiveConfirmationFocusChange={onArchiveConfirmationFocusChange}
          hasTldr={meta?.tldr != null}
          onEditTldr={() => setTldrEditorRoom(connection.room)}
        />
        {header ?? <input
          className="ub-title"
          value={meta?.title ?? ""}
          placeholder="Untitled"
          // `readOnly`, not `disabled`: the title is still the document's name
          // and still worth selecting and copying — it just cannot be retyped.
          readOnly={contentReadOnly || !writable}
          // Guard the live write too: a document may become a decision before
          // this readOnly render updates.
          onChange={(event) => {
            if (contentReadOnly || isDecision(connection) || !connection.status.writable) return;
            setTitle(connection.ydoc, event.target.value);
          }}
        />}
        {/* The editor draws only for a document that is here: `RoutePane` sends
            everything else to the waiting screen. */}
        <StatusLine
          connection={connection}
          documentLayout
          presence={presence}
          lastUpdated={updatedAt}
          onLastUpdatedChange={onLastUpdatedChange}
          endpoint={endpoint}
          hubAcked={hubAcked}
          notSharedReason={notSharedReason}
          syncDetails={syncDetails}
          onActivatePresence={revealPresence}
          statusLink={statusLink}
        />
        {beforeAnswer}
        <div className={answerClassName}>
          <TldrCallout
            key={connection.room}
            connection={connection}
            tldr={meta?.tldr ?? null}
            editing={editingTldr}
            archived={archived}
            decision={decision}
            writable={writable}
            onEditingChange={(editing) =>
              setTldrEditorRoom(editing ? connection.room : null)
            }
          />
          {foreign.length > 0 ? (
            <ForeignFallback
              connection={connection}
              summary={describeForeignBlocks(foreign, { repairable: !contentReadOnly, decision })}
              contentReadOnly={contentReadOnly}
              writable={writable}
              docLinks={docLinks}
            />
          ) : (
            <BoundEditor
              connection={connection}
              catalogConnection={catalogConnection}
              author={author}
              archived={archived}
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

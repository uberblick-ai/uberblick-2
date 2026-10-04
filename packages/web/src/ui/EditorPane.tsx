/**
 * The editor pane: title, sync status, presence, and the bound editor — or the
 * loud read-only fallback when the palette gate is closed.
 */

import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  getAnnotation,
  getBlocksFragment,
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
import { retypeSelectedBlock, selectedBlock } from "../editor/retype.js";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import { backlogLabel, rawSyncState, useCalmSyncState } from "./calm.js";
import type { SyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
import { documentSyncFacts } from "./sync-facts.js";
import { formatTimestamp, useTimestampClock } from "./timestamps.js";
import { BlockMenu } from "./BlockMenu.js";
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

/**
 * The pane frame with a message in it instead of a document.
 *
 * Every "there is nothing to edit here" screen renders through this — no
 * document picked, no workspace at all, a malformed link, a link whose
 * document has not synced yet. One frame for all of them means resolving a link
 * swaps the words inside the column rather than moving the column.
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
 * The archive banner: what an archived document says about itself, and the one
 * action it offers.
 *
 * Deliberately the *only* action. Archiving is a tombstone on the directory
 * stub, not a deletion — every byte of the document is still here, which is
 * why the pane below still renders it, still scrolls, still copies. What it
 * does not do is take an edit: restoring is the way back, and there is no
 * second path that quietly writes to a document someone archived.
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
      <strong className="font-medium">Archived.</strong> This document is tombstoned in the directory:
      it is read-only here and hidden from the document list. Restore it to edit
      it again.
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
  writable,
  onEditingChange,
}: {
  connection: RoomConnection;
  tldr: string | null;
  editing: boolean;
  archived: boolean;
  writable: boolean;
  onEditingChange: (editing: boolean) => void;
}): ReactElement | null {
  const [draft, setDraft] = useState(tldr ?? "");
  const input = useRef<HTMLTextAreaElement | null>(null);
  const readOnly = archived || !writable;
  const value = draft.trim();
  const tooLong = value.length > MAX_TLDR_LENGTH;
  const error = tooLong
    ? `A TL;DR is at most ${MAX_TLDR_LENGTH} characters.`
    : null;

  useEffect(() => {
    if (!editing) {
      setDraft(tldr ?? "");
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
    if (archived || !connection.status.writable) return;
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
        {editing ? (
          <form
            className="ub-tldr-form"
            aria-label={`${tldr === null ? "Add" : "Edit"} TL;DR`}
            onSubmit={(event) => {
              event.preventDefault();
              if (value.length === 0 || tooLong) return;
              write(value);
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
            />
            <div className="ub-tldr-form-meta">
              <span id="ub-tldr-count">
                {value.length} / {MAX_TLDR_LENGTH} characters
              </span>
              {readOnly && (
                <span>{archived ? "Restore to edit." : "Editing unavailable."}</span>
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
          <p>{tldr}</p>
        )}
      </div>
    </section>
  );
}

/**
 * Exported for the label test only.
 *
 * The backlog count names its unit (`backlogLabel`, shared with the sync
 * panel), because `sync_status` reports a *rooms* count under a similar name.
 *
 * Three things keep the line still while someone types (#76):
 *
 * 1. The state is debounced (`useCalmSyncState`) — the truth is unchanged, the
 *    redraw cadence is.
 * 2. The mark and the word each sit in a fixed-width slot, so swapping the dot
 *    for the spinner and "synced" for "syncing…" moves nothing to their right.
 * 3. The fixed sync slots keep the stable freshness and peer readings still
 *    while the transient backlog fact appears only when relevant.
 *
 * The suppression in (3) is safe only because a non-empty backlog is itself
 * part of what makes the state busy (`rawSyncState`). A backlog that outlives
 * the settle window moves the indicator to `syncing…` and brings the badge back
 * with it; the pair can delay the news by 400ms, never swallow it.
 */
export function StatusLine({
  connection,
  presence,
  lastUpdated,
  onLastUpdatedChange,
  endpoint = null,
  hubAcked,
  syncDetails = false,
  onActivatePresence,
}: {
  connection: RoomConnection;
  /**
   * Who else is in this room, read once by the shell and handed down — the same
   * snapshot the sync panel draws from (`App.tsx`).
   *
   * A prop rather than a `usePresence` of its own, because the shell already
   * holds this room's reading: a second subscription would add an awareness
   * `change` listener and a fragment observer that re-derive, on every
   * keystroke anyone types, a reading the shell has already made.
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
  /** Compose the reading as a trigger within the shell's sync Popover. */
  syncDetails?: boolean;
  /** Reveal one currently resolvable remote caret without following it. */
  onActivatePresence?: ((session: RemotePresence) => void) | undefined;
}): ReactElement {
  const status = useRoomStatus(connection);
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  const reading = statusReading(status, state ?? raw);
  const facts = documentSyncFacts(status, state, reading, hubAcked);
  const saveNote =
    !status.writable && reading.detail === null ? (
      <span className="ub-muted ub-not-saved">not saved</span>
    ) : null;
  // Presence is independent of the connection's settled status word. Keep the
  // current room's roster in its ordinary slot while that word is blank; the
  // directory's roster is already excluded by App's room pairing (#606).
  const peerStrip = (
    <PeerCluster presence={presence} onActivate={onActivatePresence} />
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
    <>
      {mark(facts.primaryTone)}
      <span
        className={`ub-status-word${facts.twoFact ? " ub-status-word--saved" : ""}`}
      >
        {facts.primary}
      </span>
    </>
  );
  const hubFact = facts.twoFact ? (
    <>
      {mark(facts.hubTone)}
      <span className="ub-status-word ub-status-word--hub">{facts.hub}</span>
    </>
  ) : null;
  const blank = facts.primary === null;
  const hub =
    endpoint === null || (hubAcked !== undefined && !facts.twoFact)
      ? null
      : `${endpoint.url ?? "unknown"} (${endpointSourceLabel(endpoint.source)})`;
  const factLabel = [facts.primary, facts.hub].filter(
    (value): value is string => value !== null,
  );
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
          className="ub-status-sync ub-sync-toggle"
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
  // The details panel mounts independently, often after this line has already
  // settled. Report what this line actually shows before paint rather than
  // give the panel another initial settle window or display a stamp this line
  // omitted. Pair every report with its room, including unmount cleanup.
  useLayoutEffect(() => {
    onLastUpdatedChange?.(connection.room, shownUpdatedAt);
    return () => onLastUpdatedChange?.(connection.room, undefined);
  }, [connection.room, onLastUpdatedChange, shownUpdatedAt]);

  // A refusal replaces the rest of the line rather than decorating it: the
  // backlog and peer strip are about a connection that is working or returning.
  return (
    <div className="ub-status">
      {syncReading}
      {reading.detail !== null && <span className="ub-muted">{reading.detail}</span>}
      {!blank && saveNote}
      {!blank && updatedReading}
      {!blank &&
        reading.detail === null &&
        state !== "synced" &&
        status.unsyncedChanges > 0 && (
          <span className="ub-pending">
            {backlogLabel(status.unsyncedChanges)}
          </span>
        )}
      {/* Circles, not name pills (#494): the strip is the constrained surface,
          and a row of words pushes the status line around as sessions come and
          go. The detail a name carried is on the avatar's hover instead — which
          is why this is the presence reading and not `usePeers`: the block a
          caret sits in is resolved once, in `readPresence`. */}
      {reading.detail === null && peerStrip}
    </div>
  );
}

/**
 * The way back out of a link conflict, and the only one a browser reader has.
 *
 * A merge of two replicas that formatted one range as different kinds of link
 * leaves both marks on it, the gate refuses to bind (see `editor/palette.ts`),
 * and until this existed the fallback could only point at the MCP tools — which
 * is no answer at all for the person who does not have them. So the choice is
 * offered here, and it is offered **per conflicting range**: two ranges in one
 * block can legitimately want different answers, and a sweep would decide for
 * the reader.
 *
 * Each choice names its own target, because that is what the reader is picking
 * between — the URL as written, and the document by the title the directory
 * advertises for it, falling back to the uuid when it cannot name it. Nothing
 * is repaired by opening the document or by rendering this list; only a click
 * writes, and only the mark it did not choose.
 */
function LinkConflictRepair({
  connection,
  archived,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
  archived: boolean;
  writable: boolean;
  docLinks: DocLinkContext | null;
}): ReactElement | null {
  const { conflicts, refresh } = useLinkConflicts(connection);
  const repair = (conflict: LinkConflict, keep: LinkSurvivor): void => {
    // Guarded here as well as by the absent control below: an archived document
    // takes no write from this pane, and the rule belongs where the write is.
    if (archived || !connection.status.writable) return;
    repairLinkConflict(conflict, keep);
    // Unconditional: a repair changes the list, and a refusal means live state
    // has already moved on without this render hearing about it yet.
    refresh();
  };
  // An archived document's one action is Restore — the banner above says so.
  if (archived || !writable || conflicts.length === 0) return null;
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
            key={`${conflict.index}:${conflict.textIndex}:${conflict.start}:${conflict.end}`}
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
 * The loud fallback. Rendered instead of the editor whenever the document holds
 * a block the palette cannot bind.
 *
 * It refuses to edit on purpose: y-prosemirror's node factory deletes
 * Y.XmlElements whose node name its ProseMirror schema does not know, so
 * binding the editor here would destroy the very blocks this screen is warning
 * about. Read-only means nothing is dropped.
 *
 * The lead says only that the editor is off, because the reasons differ and
 * `summary` is what names them: unsupported content is one, and two supported
 * link marks a merge left on one range is another — calling that "unsupported"
 * would name a mark this client renders perfectly well.
 */
function ForeignFallback({
  connection,
  summary,
  archived,
  writable,
  docLinks,
}: {
  connection: RoomConnection;
  summary: string;
  archived: boolean;
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
        archived={archived}
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

/**
 * The language of the code block the caret is in, and nothing else.
 *
 * What used to sit here was a row of block-type buttons; block types are now
 * chosen from the insertion menu (`/` and the gutter `+`), so the row is gone
 * (#105). The language is not a block type — it is an attribute of one — and
 * dropping this field would leave a human no way to set it at all, so it stays,
 * shown only while it applies.
 */
function CodeLanguageField({
  editor,
  canWrite,
}: {
  editor: Editor;
  canWrite: () => boolean;
}): ReactElement | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const bump = (): void => tick((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  const current = selectedBlock(editor);
  if (current === null || current.type !== "code") return null;

  return (
    <div className="ub-toolbar">
      <input
        className="ub-lang"
        placeholder="language"
        aria-label="Code language"
        value={
          typeof current.attrs.language === "string" ? current.attrs.language : ""
        }
        onChange={(event) => {
          if (!canWrite()) return;
          retypeSelectedBlock(editor, "code", { language: event.target.value });
        }}
      />
    </div>
  );
}

// The shell's presence reading also changes when a caret crosses blocks. Keep
// that parent update outside the editor; its own peer-name/status readers stay
// live, and actual binding inputs still pass through React's props comparison.
const BoundEditor = memo(function BoundEditor({
  connection,
  author,
  archived,
  docLinks,
  onSelectThread,
}: {
  connection: RoomConnection;
  author: string;
  /** Read-only, and none of the chrome that writes. */
  archived: boolean;
  /** See {@link EditorPane}. Must be referentially stable — it binds the editor. */
  docLinks: DocLinkContext | null;
  onSelectThread: SelectThread;
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const { writable } = useRoomStatus(connection);
  // The only names anyone can mention are the peers publishing awareness right
  // now — there is no registry, and a mention is plain text.
  const peers = usePeers(connection);
  /**
   * The current value, readable from the binding effect without making it a
   * dependency of it. An archived document must be bound read-only from the
   * start — never editable-then-corrected — while a *change* of the flag must
   * not rebind (see the effect below), and those two are only compatible if the
   * effect can read the flag without re-running when it moves.
   */
  const readArchived = useEffectEvent(() => archived);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    // The gate lives in bindGuardedEditor: it registers a synchronous guard
    // before binding, so a foreign block arriving mid-session unbinds the editor
    // instead of being destroyed by it. `useForeignBlocks` above then re-renders
    // into the read-only fallback.
    const binding = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(connection.ydoc),
      awareness: connection.provider.awareness,
      editable: !readArchived() && connection.status.writable,
      canWrite: () => connection.status.writable,
      docLinks,
    });
    // A comment highlight is a plain span ProseMirror renders from the `comment`
    // mark, so the click that focuses its thread is read by delegation on the
    // host: no ProseMirror plugin, and nothing competing with the caret. A
    // document reference is read the same way, and *first*. External links also
    // bypass thread selection: following a link and opening a thread would be
    // two actions from one gesture. The link wins; the thread stays reachable
    // through the highlight beside the link or its card in the rail.
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
        // read-only link keeps its native target/rel behavior. Refuse other
        // schemes at this boundary too, even if an anchor's DOM was changed.
        if (
          binding.editor?.isEditable ||
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
    // And the keyboard's version of that click (#101): the span is a
    // `role="button"` tab stop, so Enter and Space on a *focused* highlight
    // select its thread and send focus after it.
    //
    // Capture, and it stops there: ProseMirror binds keydown on the
    // contenteditable inside this element, and an Enter that reached it would
    // split a block. Nothing else is intercepted — a key press with the caret
    // in the prose targets the contenteditable, which is no highlight's
    // descendant, so `threadIdFromActivation` reads it as null.
    const activateThread = (event: KeyboardEvent): void => {
      // The same one-action rule as the click, for the one place the anchor is
      // a tab stop: a read-only pane. Enter on a focused reference follows it
      // in-app rather than selecting the thread it happens to sit inside — and
      // rather than letting the browser reload the whole app on the href. The
      // caret's own keystrokes target the contenteditable, which no anchor is
      // an ancestor of, so typing never reaches this.
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
  }, [connection, docLinks, onSelectThread]);

  /**
   * Read-only is a *setting* on the live editor, never a reason to rebind.
   * Archiving a document someone is reading has to flip it in place — a rebind
   * would throw away their caret and their scroll position, on a change that
   * touched no content at all.
   *
   * ProseMirror's own `editable` is what enforces it: with it off the view
   * ignores every user input path — keys, `beforeinput`, paste, drop — while
   * leaving selection and copy exactly as they were.
   *
   * `useLayoutEffect`, because a passive effect runs *after* paint. The render
   * that draws the banner and takes the chrome away would otherwise leave the
   * editor itself editable for one committed, painted frame — a frame that
   * accepts a keystroke, which is the one thing the whole feature is for. This
   * runs inside the same commit, so the two never disagree on screen.
   */
  useLayoutEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.setEditable(!archived && writable);
    if (!archived && writable) {
      // A repair suppressed while the link was gone gets another plugin pass
      // as soon as the admitted room is writable again.
      editor.view.dispatch(editor.state.tr.setMeta("uberblick:writable", true));
    }
  }, [editor, archived, writable]);

  return (
    <>
      {editor !== null && !archived && writable && (
        <CodeLanguageField
          editor={editor}
          canWrite={() => connection.status.writable}
        />
      )}
      {/* The composer and gutter button use this frame; the menus find the
          enclosing pane from it. ProseMirror owns every child of `.ub-editor`. */}
      <div className="ub-editor-frame" ref={frame}>
        <div className="ub-editor" ref={host} />
        {/* Both are ways of writing to the document, so an archived document
            offers neither: the insertion menu and the comment composer are
            gone, not merely inert. */}
        {editor !== null && !archived && writable && (
          <BlockMenu editor={editor} host={frame} />
        )}
        {editor !== null && !archived && writable && (
          <MentionMenu
            editor={editor}
            host={frame}
            docLinks={docLinks}
            // The document on screen, from the room it is open in — the one
            // place its uuid is already known here, and the same parse a copied
            // link goes through.
            openDocId={parseRoom(connection.room).uuid}
          />
        )}
        {editor !== null && !archived && writable && (
          <CommentComposer
            editor={editor}
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
  threads = [],
  threadsOpen = false,
  onToggleThreads,
  syncDetails = false,
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
   * Whether the directory tombstones this document. Live in both directions:
   * the value changes under an open pane when anyone archives or restores.
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
   * What a `docLink` resolves against: the address of a document in the
   * workspace on screen, the directory that names it, and where a click goes
   * (`editor/doc-links.ts`). Null before a workspace is known. Must be
   * referentially stable — it is an effect dependency, and a new object every
   * render would rebind the editor under the reader's caret.
   */
  docLinks: DocLinkContext | null;
  /** Lift the tombstone. */
  onRestore: (() => void) | null;
  /**
   * Called when a click lands inside a comment highlight, so the rail can focus
   * that thread. Must be referentially stable — it is an effect dependency.
   * Also called with a thread this client has just started.
   */
  onSelectThread: SelectThread;
  endpoint?: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  threads?: readonly ThreadView[];
  threadsOpen?: boolean;
  onToggleThreads?: (() => void) | undefined;
  syncDetails?: boolean;
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
  const meta = useDocMeta(connection);
  const foreign = useForeignBlocks(connection);
  const { writable } = useRoomStatus(connection);
  const openThreads = threads.filter((thread) => !thread.resolved).length;
  const editingTldr = connection?.room === tldrEditorRoom;

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
        {/* The eyebrow: what this document is, what it is tagged, and which
            version of it is on screen — above the title, as design 1a has it. */}
        <DocMetaLine
          connection={connection}
          catalogConnection={catalogConnection}
          segment={segment}
          meta={meta}
          archived={archived}
          readOnly={!writable}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onArchive={onArchive}
          onArchiveConfirmationFocusChange={onArchiveConfirmationFocusChange}
          hasTldr={meta?.tldr != null}
          onEditTldr={() => setTldrEditorRoom(connection.room)}
        />
        <input
          className="ub-title"
          value={meta?.title ?? ""}
          placeholder="Untitled"
          // `readOnly`, not `disabled`: the title is still the document's name
          // and still worth selecting and copying — it just cannot be retyped.
          readOnly={archived || !writable}
          // And the write is guarded as well as the field. `readOnly` is a
          // statement to the browser about typing; the rule is that an archived
          // document takes no write from here, and a rule worth having is worth
          // enforcing where the write happens rather than trusting the one
          // attribute that happens to sit in front of it today.
          onChange={(event) => {
            if (archived || !connection.status.writable) return;
            setTitle(connection.ydoc, event.target.value);
          }}
        />
        {/* The editor draws only for a document that is here: `RoutePane` sends
            everything else to the waiting screen. */}
        <StatusLine
          connection={connection}
          presence={presence}
          lastUpdated={updatedAt}
          onLastUpdatedChange={onLastUpdatedChange}
          endpoint={endpoint}
          hubAcked={hubAcked}
          syncDetails={syncDetails}
          onActivatePresence={revealPresence}
        />
        <TldrCallout
          key={connection.room}
          connection={connection}
          tldr={meta?.tldr ?? null}
          editing={editingTldr}
          archived={archived}
          writable={writable}
          onEditingChange={(editing) =>
            setTldrEditorRoom(editing ? connection.room : null)
          }
        />
        {foreign.length > 0 ? (
          <ForeignFallback
            connection={connection}
            summary={describeForeignBlocks(foreign, { repairable: !archived })}
            archived={archived}
            writable={writable}
            docLinks={docLinks}
          />
        ) : (
          <BoundEditor
            connection={connection}
            author={author}
            archived={archived}
            docLinks={docLinks}
            onSelectThread={onSelectThread}
          />
        )}
      </div>
    </section>
  );
}

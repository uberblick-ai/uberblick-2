/**
 * The editor pane: title, sync status, presence, and the bound editor — or the
 * loud read-only fallback when the palette gate is closed.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { getBlocksFragment, parseRoom, setTitle } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { bindGuardedEditor } from "../editor/guarded-binding.js";
import { docLinkFromTarget } from "../editor/doc-links.js";
import type { DocLinkContext } from "../editor/doc-links.js";
import { describeForeignBlocks } from "../editor/palette.js";
import type { LinkConflict } from "../editor/palette.js";
import { repairLinkConflict } from "../editor/link-repair.js";
import type { LinkSurvivor } from "../editor/link-repair.js";
import { writeToClipboard } from "../editor/source-chrome.js";
import { retypeSelectedBlock, selectedBlock } from "../editor/retype.js";
import type { RoomConnection } from "../collab/rooms.js";
import { backlogLabel, rawSyncState, useCalmSyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
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
import { PeerAvatar } from "./PeerAvatar.js";
import { DocMetaLine } from "./DocChrome.js";
import { shareUrl } from "./route.js";
import { threadIdFromActivation, threadIdFromTarget } from "./threads.js";
import type { SelectThread } from "./threads.js";

/**
 * The pane frame with a message in it instead of a document.
 *
 * Every "there is nothing to edit here" screen renders through this — no
 * document picked, no workspace at all, a malformed link, a link whose
 * document has not synced yet. One frame for all of them means resolving a link
 * swaps the words inside the column rather than moving the column.
 */
export function PaneNotice({ children }: { children: ReactNode }): ReactElement {
  return (
    <section className="ub-pane">
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
function ArchivedBanner({ onRestore }: { onRestore: () => void }): ReactElement {
  return (
    <p className="ub-archived-banner">
      <strong>Archived.</strong> This document is tombstoned in the directory:
      it is read-only here and hidden from the document list. Restore it to edit
      it again.
      <button type="button" className="ub-tool" onClick={onRestore}>
        Restore
      </button>
    </p>
  );
}

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_MS = 1_500;

type CopyResult = "idle" | "copied" | "failed";

/**
 * The room key, doubling as the document's shareable link (#68).
 *
 * The line that already identified the document becomes the copy affordance
 * rather than growing a button beside it — there was never anything else to
 * show. The confirmation is positioned out of flow for the reason the rest of
 * this line is built the way it is (#76): nothing here may move sideways, and a
 * word appearing in the row would move everything after it.
 *
 * The link is built from `segment` — the workspace as the *address* spells it —
 * rather than from the room key, which carries the bare uuid. The two are the
 * same string for an undecorated workspace and differ for `<slug>-<uuid>`, and
 * a copy that quietly handed back the undecorated form would rewrite somebody's
 * link on its way out of their own address bar. What is copied is the address
 * this document is open at.
 *
 * The visible label stays the room key, because that is what the rest of this
 * line is about: the sync state of a room, named the way the hub and the update
 * log name it. The accessible name goes the other way and announces the
 * address, because that is the thing the click produces.
 *
 * The copy goes through `writeToClipboard`, not `navigator.clipboard`: that API
 * exists only in a secure context, and serving this client over plain http on a
 * tailnet host is a supported deployment (REMOTE.md). The shared helper falls
 * back to `execCommand`, and reports whether either worked — so a failure is
 * said out loud rather than swallowed into a button that quietly does nothing.
 */
function CopyLink({
  room,
  segment,
}: {
  room: string;
  segment: string;
}): ReactElement {
  const [result, setResult] = useState<CopyResult>("idle");

  useEffect(() => {
    if (result === "idle") return;
    const timer = setTimeout(() => setResult("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [result]);

  // The one address this button is about: what it copies, and what it says it
  // copies. Two derivations of that would be two chances for them to disagree.
  const address = `${segment}/${parseRoom(room).uuid}`;

  const copy = async (): Promise<void> => {
    const ok = await writeToClipboard(shareUrl(address, window.location.origin));
    setResult(ok ? "copied" : "failed");
  };

  return (
    <span className="ub-room-wrap">
      <button
        type="button"
        className="ub-room"
        // The visible label is the room key, which names the document but not
        // the action. `title` is not reliably announced, so the accessible name
        // is set explicitly and carries both — and it names the address that is
        // actually copied, not the room key beside it, so what a screen reader
        // announces is what lands on the clipboard.
        aria-label={`Copy link to ${address}`}
        title={`Copy link to ${address}`}
        onClick={() => void copy()}
      >
        {room}
      </button>
      {/* Rendered always, empty when idle: `role="status"` only announces
          changes to a region the reader was already in. */}
      <span className="ub-copied" role="status">
        {result !== "idle" && (result === "copied" ? "link copied" : "copy failed")}
      </span>
    </span>
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
 * 3. The backlog badge is last before the presence strip, and only shows when
 *    the settled state is not `synced`. In the two settled states the room key
 *    and "local cache" are therefore at identical positions; a badge in its old
 *    place, between them and the word, could not have been.
 *
 * The suppression in (3) is safe only because a non-empty backlog is itself
 * part of what makes the state busy (`rawSyncState`). A backlog that outlives
 * the settle window moves the indicator to `syncing…` and brings the badge back
 * with it; the pair can delay the news by 400ms, never swallow it.
 */
export function StatusLine({
  connection,
  segment,
  presence,
}: {
  connection: RoomConnection;
  /** The workspace as the address spells it — what a copied link carries. */
  segment: string;
  /**
   * Who else is in this room, read once by the shell and handed down — the same
   * snapshot the activity pill and the sync panel draw from (`App.tsx`).
   *
   * A prop rather than a `usePresence` of its own, because the shell already
   * holds this room's reading: a second subscription would add an awareness
   * `change` listener and a fragment observer that re-derive, on every
   * keystroke anyone types, a reading the shell has already made.
   */
  presence: readonly RemotePresence[];
}): ReactElement {
  const status = useRoomStatus(connection);
  const state = useCalmSyncState(rawSyncState(status));
  const reading = statusReading(status, state);
  if (reading.detail !== null) {
    // A refusal replaces the line rather than decorating it: the backlog, the
    // cache claim and the peer strip are all about a connection that is working
    // or coming back, and none of them is what this reader has to act on.
    return (
      <div className="ub-status">
        <span className="ub-status-mark" aria-hidden="true">
          <span className="ub-dot ub-dot-off" />
        </span>
        <span className="ub-status-word">{reading.word}</span>
        <span className="ub-muted">{reading.detail}</span>
        <CopyLink room={connection.room} segment={segment} />
      </div>
    );
  }
  return (
    <div className="ub-status">
      {/* The word carries the meaning; the mark is decoration beside it. */}
      <span className="ub-status-mark" aria-hidden="true">
        {state === "syncing" ? (
          <span className="ub-spinner" />
        ) : (
          <span
            className={`ub-dot ${state === "synced" ? "ub-dot-live" : "ub-dot-off"}`}
          />
        )}
      </span>
      <span className="ub-status-word">{reading.word}</span>
      {/* `hasLocalCache`, not `localReplicaLoaded`: the second only says the
          local read is over, and it is over immediately where there is no
          IndexedDB to read. */}
      {status.hasLocalCache && <span className="ub-muted">local cache</span>}
      <CopyLink room={connection.room} segment={segment} />
      {state !== "synced" && status.unsyncedChanges > 0 && (
        <span className="ub-pending">{backlogLabel(status.unsyncedChanges)}</span>
      )}
      {/* Circles, not name pills (#494): the strip is the constrained surface,
          and a row of words pushes the status line around as sessions come and
          go. The detail a name carried is on the avatar's hover instead — which
          is why this is the presence reading and not `usePeers`: the block a
          caret sits in is resolved once, in `readPresence`, so the hover and
          the activity pill cannot disagree about where a session is. */}
      <span className="ub-peers">
        {presence.map((peer) => (
          <PeerAvatar key={peer.clientId} session={peer} />
        ))}
      </span>
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
  docLinks,
}: {
  connection: RoomConnection;
  archived: boolean;
  docLinks: DocLinkContext | null;
}): ReactElement | null {
  const { conflicts, refresh } = useLinkConflicts(connection);
  const repair = (conflict: LinkConflict, keep: LinkSurvivor): void => {
    // Guarded here as well as by the absent control below: an archived document
    // takes no write from this pane, and the rule belongs where the write is.
    if (archived) return;
    repairLinkConflict(conflict, keep);
    // Unconditional: a repair changes the list, and a refusal means live state
    // has already moved on without this render hearing about it yet.
    refresh();
  };
  // An archived document's one action is Restore — the banner above says so.
  if (archived || conflicts.length === 0) return null;
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
  docLinks,
}: {
  connection: RoomConnection;
  summary: string;
  archived: boolean;
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
function CodeLanguageField({ editor }: { editor: Editor }): ReactElement | null {
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
        onChange={(event) =>
          retypeSelectedBlock(editor, "code", { language: event.target.value })
        }
      />
    </div>
  );
}

function BoundEditor({
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
  const archivedNow = useRef(archived);
  archivedNow.current = archived;

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
      editable: !archivedNow.current,
      docLinks,
    });
    // A comment highlight is a plain span ProseMirror renders from the `comment`
    // mark, so the click that focuses its thread is read by delegation on the
    // host: no ProseMirror plugin, and nothing competing with the caret. A
    // document reference is read the same way, and *first*: the two can overlap,
    // and a click that both navigated and opened a thread would be two actions
    // from one gesture. The reference wins, and the thread stays reachable by
    // clicking the highlight beside the link or its card in the rail.
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
      const threadId = threadIdFromTarget(event.target);
      if (threadId !== null) onSelectThread(threadId);
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
      const threadId = threadIdFromActivation(event);
      if (threadId === null) return;
      event.preventDefault();
      event.stopPropagation();
      onSelectThread(threadId, true);
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
    editor.setEditable(!archived);
  }, [editor, archived]);

  return (
    <>
      {editor !== null && !archived && <CodeLanguageField editor={editor} />}
      {/* The composer and the block menu are positioned against this frame, not
          against the editor itself: ProseMirror owns every child of
          `.ub-editor`. */}
      <div className="ub-editor-frame" ref={frame}>
        <div className="ub-editor" ref={host} />
        {/* Both are ways of writing to the document, so an archived document
            offers neither: the insertion menu and the comment composer are
            gone, not merely inert. */}
        {editor !== null && !archived && <BlockMenu editor={editor} host={frame} />}
        {editor !== null && !archived && (
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
        {editor !== null && !archived && (
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
}

export function EditorPane({
  connection,
  segment,
  presence,
  author,
  knownTags,
  archived,
  docLinks,
  onRestore,
  onSelectThread,
}: {
  connection: RoomConnection | null;
  /** The workspace as the address spells it — see {@link StatusLine}. */
  segment: string;
  /** This room's presence reading, passed through to {@link StatusLine}. */
  presence: readonly RemotePresence[];
  /** The awareness name this client publishes — the author of its comments. */
  author: string;
  /**
   * Every tag the workspace already uses, read from the directory stubs by the
   * shell. The identity line's add field suggests from it (#122).
   */
  knownTags: readonly string[];
  /**
   * Whether the directory tombstones this document. Live in both directions:
   * the value changes under an open pane when anyone archives or restores.
   */
  archived: boolean;
  /**
   * What a `docLink` resolves against: the address of a document in the
   * workspace on screen, the directory that names it, and where a click goes
   * (`editor/doc-links.ts`). Null before a workspace is known. Must be
   * referentially stable — it is an effect dependency, and a new object every
   * render would rebind the editor under the reader's caret.
   */
  docLinks: DocLinkContext | null;
  /** Lift the tombstone. */
  onRestore: () => void;
  /**
   * Called when a click lands inside a comment highlight, so the rail can focus
   * that thread. Must be referentially stable — it is an effect dependency.
   * Also called with a thread this client has just started.
   */
  onSelectThread: SelectThread;
}): ReactElement {
  const meta = useDocMeta(connection);
  const foreign = useForeignBlocks(connection);

  if (connection === null) {
    return (
      <PaneNotice>
        <p className="ub-muted">Pick a document, or create one.</p>
      </PaneNotice>
    );
  }

  // `ub-pane` is the scroll container and takes whatever width is left; the
  // reading measure lives on `ub-column`, centred inside it.
  return (
    <section className="ub-pane">
      <div className="ub-column">
        {archived && <ArchivedBanner onRestore={onRestore} />}
        {/* The eyebrow: what this document is, what it is tagged, and which
            version of it is on screen — above the title, as design 1a has it. */}
        <DocMetaLine
          connection={connection}
          meta={meta}
          knownTags={knownTags}
          archived={archived}
        />
        <input
          className="ub-title"
          value={meta?.title ?? ""}
          placeholder="Untitled"
          // `readOnly`, not `disabled`: the title is still the document's name
          // and still worth selecting and copying — it just cannot be retyped.
          readOnly={archived}
          // And the write is guarded as well as the field. `readOnly` is a
          // statement to the browser about typing; the rule is that an archived
          // document takes no write from here, and a rule worth having is worth
          // enforcing where the write happens rather than trusting the one
          // attribute that happens to sit in front of it today.
          onChange={(event) => {
            if (archived) return;
            setTitle(connection.ydoc, event.target.value);
          }}
        />
        <StatusLine connection={connection} segment={segment} presence={presence} />
        {foreign.length > 0 ? (
          <ForeignFallback
            connection={connection}
            summary={describeForeignBlocks(foreign, { repairable: !archived })}
            archived={archived}
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

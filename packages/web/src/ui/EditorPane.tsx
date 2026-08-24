/**
 * The editor pane: title, sync status, presence, and the bound editor — or the
 * loud read-only fallback when the palette gate is closed.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { getBlocksFragment, setTitle } from "@uberblick/schema";
import type { BlockType, HeadingLevel } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { bindGuardedEditor } from "../editor/guarded-binding.js";
import { describeForeignBlocks } from "../editor/palette.js";
import { retypeSelectedBlock, selectedBlock } from "../editor/retype.js";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import {
  useDocMeta,
  useForeignBlocks,
  usePeers,
  useRawBlocks,
  useRoomStatus,
} from "./hooks.js";
import { CommentComposer } from "./CommentComposer.js";
import { threadIdFromTarget } from "./threads.js";

/**
 * Exported for the label test only.
 *
 * The backlog count names its unit, because `sync_status` reports a *rooms*
 * count under a similar name and two numbers labelled "pending" invite the
 * question of which one is lying.
 *
 * The unit is provider sync messages awaiting the hub's acknowledgement — not
 * Yjs updates, which the counter cannot report: the provider merges a batch of
 * updates into one message, counts a message before it goes out, and resets the
 * backlog to the single sync-handshake message on every reconnect. So "1 sync
 * message unacked" can stand for a whole document's worth of unsent work —
 * which is why the label does not say "1 update".
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
}: {
  connection: RoomConnection;
}): ReactElement {
  const status = useRoomStatus(connection);
  const peers = usePeers(connection);
  const state = useCalmSyncState(rawSyncState(status));
  const label = state === "syncing" ? "syncing…" : state;
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
      <span className="ub-status-word">{label}</span>
      {status.localReplicaLoaded && <span className="ub-muted">local cache</span>}
      <span className="ub-muted">{connection.room}</span>
      {state !== "synced" && status.unsyncedChanges > 0 && (
        <span className="ub-pending">
          {status.unsyncedChanges} sync message
          {status.unsyncedChanges === 1 ? "" : "s"} unacked
        </span>
      )}
      <span className="ub-peers">
        {peers.map((peer) => (
          <span
            key={peer.clientId}
            className="ub-peer"
            style={{ borderColor: peer.color }}
          >
            {peer.name}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The loud fallback. Rendered instead of the editor whenever the document holds
 * a block the palette cannot represent.
 *
 * It refuses to edit on purpose: y-prosemirror's node factory deletes
 * Y.XmlElements whose node name its ProseMirror schema does not know, so
 * binding the editor here would destroy the very blocks this screen is warning
 * about. Read-only means nothing is dropped.
 */
function ForeignFallback({
  connection,
  summary,
}: {
  connection: RoomConnection;
  summary: string;
}): ReactElement {
  const blocks = useRawBlocks(connection);
  return (
    <div className="ub-foreign">
      <p className="ub-foreign-banner">
        <strong>Unsupported content — editor disabled.</strong> {summary}
      </p>
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
 * The block palette, as buttons. The four types and nothing else — which is the
 * point: a restricted palette you cannot select from is not a palette.
 */
function BlockToolbar({ editor }: { editor: Editor }): ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const bump = (): void => tick((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  const current = selectedBlock(editor);
  const active = (type: BlockType, level?: HeadingLevel): boolean => {
    if (current === null || current.type !== type) return false;
    if (level === undefined) return true;
    return String(current.attrs.level ?? "1") === String(level);
  };
  const button = (
    label: string,
    type: BlockType,
    level?: HeadingLevel,
  ): ReactElement => (
    <button
      key={label}
      type="button"
      className={active(type, level) ? "ub-tool ub-tool-on" : "ub-tool"}
      onMouseDown={(event) => {
        // Keep the selection: a focus change would move the caret out of the
        // block we are about to re-type.
        event.preventDefault();
        retypeSelectedBlock(editor, type, level === undefined ? {} : { level });
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="ub-toolbar">
      {button("¶", "paragraph")}
      {button("H1", "heading", 1)}
      {button("H2", "heading", 2)}
      {button("H3", "heading", 3)}
      {button("code", "code")}
      {button("mermaid", "mermaid")}
      {current?.type === "code" && (
        <input
          className="ub-lang"
          placeholder="language"
          value={
            typeof current.attrs.language === "string" ? current.attrs.language : ""
          }
          onChange={(event) =>
            retypeSelectedBlock(editor, "code", { language: event.target.value })
          }
        />
      )}
    </div>
  );
}

function BoundEditor({
  connection,
  author,
  onSelectThread,
}: {
  connection: RoomConnection;
  author: string;
  onSelectThread: (threadId: string) => void;
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // The only names anyone can mention are the peers publishing awareness right
  // now — there is no registry, and a mention is plain text.
  const peers = usePeers(connection);

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
    });
    // A comment highlight is a plain span ProseMirror renders from the `comment`
    // mark, so the click that focuses its thread is read by delegation on the
    // host: no ProseMirror plugin, and nothing competing with the caret.
    const focusThread = (event: MouseEvent): void => {
      const threadId = threadIdFromTarget(event.target);
      if (threadId !== null) onSelectThread(threadId);
    };
    element.addEventListener("click", focusThread);
    setEditor(binding.editor);
    return () => {
      element.removeEventListener("click", focusThread);
      setEditor(null);
      binding.destroy();
    };
  }, [connection, onSelectThread]);

  return (
    <>
      {editor !== null && <BlockToolbar editor={editor} />}
      {/* The composer is positioned against this frame, not against the editor
          itself: ProseMirror owns every child of `.ub-editor`. */}
      <div className="ub-editor-frame" ref={frame}>
        <div className="ub-editor" ref={host} />
        {editor !== null && (
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
  author,
  onSelectThread,
}: {
  connection: RoomConnection | null;
  /** The awareness name this client publishes — the author of its comments. */
  author: string;
  /**
   * Called when a click lands inside a comment highlight, so the rail can focus
   * that thread. Must be referentially stable — it is an effect dependency.
   * Also called with a thread this client has just started.
   */
  onSelectThread: (threadId: string) => void;
}): ReactElement {
  const meta = useDocMeta(connection);
  const foreign = useForeignBlocks(connection);

  if (connection === null) {
    return (
      <section className="ub-pane">
        <div className="ub-column">
          <p className="ub-muted">Pick a document, or create one.</p>
        </div>
      </section>
    );
  }

  // `ub-pane` is the scroll container and takes whatever width is left; the
  // reading measure lives on `ub-column`, centred inside it.
  return (
    <section className="ub-pane">
      <div className="ub-column">
        <input
          className="ub-title"
          value={meta?.title ?? ""}
          placeholder="Untitled"
          onChange={(event) => setTitle(connection.ydoc, event.target.value)}
        />
        <StatusLine connection={connection} />
        {foreign.length > 0 ? (
          <ForeignFallback
            connection={connection}
            summary={describeForeignBlocks(foreign)}
          />
        ) : (
          <BoundEditor
            connection={connection}
            author={author}
            onSelectThread={onSelectThread}
          />
        )}
      </div>
    </section>
  );
}

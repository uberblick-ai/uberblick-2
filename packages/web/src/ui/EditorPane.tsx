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
import {
  useDocMeta,
  useForeignBlocks,
  usePeers,
  useRawBlocks,
  useRoomStatus,
} from "./hooks.js";

function StatusLine({ connection }: { connection: RoomConnection }): ReactElement {
  const status = useRoomStatus(connection);
  const peers = usePeers(connection);
  const label = !status.connected
    ? "offline"
    : status.synced
      ? "synced"
      : "connected, syncing…";
  return (
    <div className="ub-status">
      <span
        className={`ub-dot ${status.connected && status.synced ? "ub-dot-live" : status.connected ? "ub-dot-syncing" : "ub-dot-off"}`}
      />
      <span>{label}</span>
      {status.unsyncedChanges > 0 && (
        <span className="ub-pending">{status.unsyncedChanges} pending</span>
      )}
      {status.localReplicaLoaded && <span className="ub-muted">local cache</span>}
      <span className="ub-muted">{connection.room}</span>
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

function BoundEditor({ connection }: { connection: RoomConnection }): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

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
    setEditor(binding.editor);
    return () => {
      setEditor(null);
      binding.destroy();
    };
  }, [connection]);

  return (
    <>
      {editor !== null && <BlockToolbar editor={editor} />}
      <div className="ub-editor" ref={host} />
    </>
  );
}

export function EditorPane({
  connection,
}: {
  connection: RoomConnection | null;
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
          <BoundEditor connection={connection} />
        )}
      </div>
    </section>
  );
}

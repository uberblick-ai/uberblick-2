/**
 * The app shell. Two rooms at a time: the workspace directory, and whichever
 * document is open.
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
import { DocList } from "./DocList.js";
import { EditorPane } from "./EditorPane.js";
import { useDirectory, useIdentity, useRoom } from "./hooks.js";

export function App(): ReactElement {
  const identity = useIdentity(randomIdentity);
  const [selected, setSelected] = useState<string | null>(null);

  const directory = useRoom(directoryRoom(WORKSPACE), identity);
  const doc = useRoom(
    selected === null ? null : roomForDoc(WORKSPACE, selected),
    identity,
  );
  const entries = useDirectory(directory);

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
    setSelected(uuid);
  }, [directory, identity]);

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
        <span className="ub-brand">uberblick</span>
        <span className="ub-muted">workspace {WORKSPACE}</span>
        <span className="ub-me" style={{ borderColor: identity.color }}>
          {identity.name}
        </span>
      </header>
      <div className="ub-body">
        <DocList
          connection={directory}
          entries={entries}
          selected={selected}
          onSelect={setSelected}
          onCreate={onCreate}
        />
        <EditorPane connection={doc} />
      </div>
    </main>
  );
}

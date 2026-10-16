/** Stored Mermaid is removed before the editor's foreign-content boundary. */
import { act, render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocks, getBlocksFragment, initDoc, setKind } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import { EditorPane } from "../src/ui/document/EditorPane.js";

const LIVE: RoomStatus = { connected: true, synced: true, writable: true,
  hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
  unsyncedChanges: 0, protocolMismatch: null, authFailed: false, tokenMissing: false };
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";

afterEach(() => vi.restoreAllMocks());

function oldBlock(id = "old-diagram"): Y.XmlElement {
  const block = new Y.XmlElement("mermaid");
  block.setAttribute("id", id);
  block.insert(0, [new Y.XmlText("flowchart LR\n  A --> B")]);
  return block;
}

it.each([false, true])("removes Mermaid before binding or remote rendering (late: %s)", (late) => {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "removal", title: "Stored diagram" });
  appendBlock(ydoc, { type: "paragraph", text: "Keep this paragraph" });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const element = document.createElement("div");
  document.body.appendChild(element);
  const unbind = vi.fn();
  if (!late) getBlocksFragment(ydoc).insert(1, [oldBlock()]);
  const binding = bindGuardedEditor({ element, fragment: getBlocksFragment(ydoc),
    canNormalize: () => true, onUnbind: unbind });
  try {
    expect(binding.refused).toBe(false);
    const editor = binding.editor!;
    if (late) {
      getBlocksFragment(peer).insert(1, [oldBlock()]);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    }
    expect(unbind).not.toHaveBeenCalled();
    expect(editor.isDestroyed).toBe(false);
    expect(getBlocks(ydoc).map(block => block.text)).toEqual(["Keep this paragraph"]);
    expect(editor.state.doc.childCount).toBe(1);
    editor.commands.setTextSelection(1);
    editor.view.dispatch(editor.state.tr.insertText("Still editable: "));
    expect(getBlocks(ydoc)[0]?.text).toBe("Still editable: Keep this paragraph");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    expect(getBlocksFragment(peer).toJSON()).toEqual(getBlocksFragment(ydoc).toJSON());
  } finally { binding.destroy(); element.remove(); ydoc.destroy(); peer.destroy(); }
});

it.each(["regular", "decision", "archived"] as const)("normalizes a %s page after writable sync without unlocking content", (kind) => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "Stored diagram" });
  if (kind === "decision") setKind(ydoc, "decision");
  appendBlock(ydoc, { type: "paragraph", text: "Keep" });
  getBlocksFragment(ydoc).insert(1, [oldBlock()]);
  const listeners = new Set<(status: RoomStatus) => void>();
  const connection = { room: `${WORKSPACE}/${UUID}`, ydoc, provider: { awareness: null },
    status: { ...LIVE, writable: false, synced: false },
    onStatusChange(listener: (status: RoomStatus) => void) {
      listeners.add(listener); listener(connection.status); return () => { listeners.delete(listener); };
    },
  } as unknown as RoomConnection;
  onTestCleanup(() => ydoc.destroy());
  const { container } = render(<EditorPane connection={connection} segment={WORKSPACE} presence={[]}
    author="Reader" archived={kind === "archived"} docLinks={null} onRestore={null} onSelectThread={() => {}} />);
  expect(getBlocksFragment(ydoc).length).toBe(2);
  act(() => {
    Object.assign(connection.status, LIVE);
    for (const listener of listeners) listener(connection.status);
  });
  expect(container.textContent).not.toContain("Editor disabled");
  expect(getBlocks(ydoc).map(block => block.text)).toEqual(["Keep"]);
  expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe(String(kind === "regular"));
});

it.each([false, true])("keeps an editor usable when Mermaid was its only remaining block (late: %s)", (late) => {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "Only diagram" });
  getBlocksFragment(ydoc).insert(0, [late
    ? new Y.XmlElement("paragraph") : oldBlock()]);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const element = document.createElement("div");
  document.body.appendChild(element);
  const unbind = vi.fn();
  const binding = bindGuardedEditor({ element, fragment: getBlocksFragment(ydoc),
    canNormalize: () => true, onUnbind: unbind });
  try {
    if (late) {
      peer.transact(() => {
        getBlocksFragment(peer).delete(0, 1);
        getBlocksFragment(peer).insert(0, [oldBlock()]);
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    }
    expect(binding.refused).toBe(false);
    expect(unbind).not.toHaveBeenCalled();
    const editor = binding.editor!;
    expect(editor.isDestroyed).toBe(false);
    expect(editor.state.doc.textContent).toBe("");
    editor.commands.setTextSelection(1);
    editor.view.dispatch(editor.state.tr.insertText("New content"));
    expect(getBlocks(ydoc).map(block => block.text)).toEqual(["New content"]);
  } finally { binding.destroy(); element.remove(); ydoc.destroy(); peer.destroy(); }
});

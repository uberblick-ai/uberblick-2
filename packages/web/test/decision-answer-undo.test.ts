import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, decisionAnswerShapeFailure, deleteBlock, getBlocks,
  getBlocksFragment, initDoc,
} from "@uberblick/schema";
import { guardUndoManager } from "../src/editor/guarded-undo.js";
import { decisionAnswerDocEditAllowed } from "../src/editor/decision-answer.js";
import { onTestCleanup } from "./test-cleanup.js";

function fixture() {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "answer-undo", title: "Answer" });
  appendBlock(ydoc, { type: "paragraph", text: "First" });
  appendBlock(ydoc, { type: "paragraph", text: "Second" });
  const origin = {};
  const manager = new Y.UndoManager(getBlocksFragment(ydoc), { trackedOrigins: new Set([origin]) });
  const local = (change: () => void) => {
    manager.stopCapturing();
    ydoc.transact(change, origin);
  };
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  onTestCleanup(() => { ydoc.destroy(); peer.destroy(); });
  return { ydoc, manager, local, peer };
}

function acceptAnswer(_before: Y.Doc, after: Y.Doc): boolean {
  return decisionAnswerShapeFailure(getBlocks(after)) === null;
}

function redoLinks(ydoc: Y.Doc) {
  return [...ydoc.store.clients.values()].flatMap((structs) => structs.flatMap((struct) =>
    struct instanceof Y.Item
      ? [{ id: { ...struct.id }, length: struct.length, keep: struct.keep,
          redone: struct.redone === null ? null : { ...struct.redone } }]
      : []));
}

describe("decision answer Yjs history guard", () => {
  it("refuses an undo that remote insertion made too long without consuming history or writing", () => {
    const { ydoc, manager, local, peer } = fixture();
    guardUndoManager(manager, getBlocksFragment(ydoc), () => true, acceptAnswer);
    const second = getBlocks(ydoc)[1];
    if (second === undefined) throw new Error("Missing second block");
    local(() => deleteBlock(ydoc, second.id));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    appendBlock(peer, { type: "paragraph", text: "Remote third" });
    appendBlock(peer, { type: "paragraph", text: "Remote fourth" });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    const before = getBlocks(ydoc);
    const stackItem = manager.undoStack[0];
    if (stackItem === undefined) throw new Error("Missing undo entry");
    const selectionKey = {};
    stackItem.meta.set(selectionKey, { selection: { anchor: 1, head: 4 } });
    const deletions = [...stackItem.deletions.clients].map(([client, ranges]) =>
      [client, ranges.map((range) => ({ ...range }))]);
    const insertions = [...stackItem.insertions.clients].map(([client, ranges]) =>
      [client, ranges.map((range) => ({ ...range }))]);
    const update = vi.fn();
    ydoc.on("update", update);

    expect(manager.undo()).toBeNull();
    expect(getBlocks(ydoc)).toEqual(before);
    expect(manager.undoStack).toHaveLength(1);
    expect(manager.redoStack).toHaveLength(0);
    expect(manager.undoStack[0]).toBe(stackItem);
    expect(stackItem.meta.get(selectionKey)).toEqual({ selection: { anchor: 1, head: 4 } });
    expect([...stackItem.deletions.clients]).toEqual(deletions);
    expect([...stackItem.insertions.clients]).toEqual(insertions);
    expect(update).not.toHaveBeenCalled();

    const fourth = getBlocks(peer)[2];
    if (fourth === undefined) throw new Error("Missing remote block");
    deleteBlock(peer, fourth.id);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    expect(manager.undo()).not.toBeNull();
    expect(getBlocks(ydoc)).toHaveLength(3);
    expect(getBlocks(ydoc).some((block) => block.text === "Second")).toBe(true);
  });

  it("preserves redo links across repeated undo and redo before rejecting a concurrent extra block", () => {
    const { ydoc, manager, local, peer } = fixture();
    let preview: unknown;
    guardUndoManager(manager, getBlocksFragment(ydoc), () => true, (before, after) => {
      preview = getBlocks(after);
      return acceptAnswer(before, after);
    });
    local(() => appendBlock(ydoc, { type: "paragraph", text: "Local third" }));
    expect(manager.undo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    expect(manager.redo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    expect(manager.undo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);

    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    appendBlock(peer, { type: "paragraph", text: "Remote third" });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    const before = getBlocks(ydoc);
    const linksBefore = redoLinks(ydoc);
    const update = vi.fn();
    ydoc.on("update", update);
    expect(manager.redo()).toBeNull();
    expect(getBlocks(ydoc)).toEqual(before);
    expect(redoLinks(ydoc)).toEqual(linksBefore);
    expect(manager.redoStack).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();

    const remote = getBlocks(peer)[2];
    if (remote === undefined) throw new Error("Missing remote block");
    deleteBlock(peer, remote.id);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    expect(manager.redo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["First", "Second", "Local third"]);
  });

  it("checks current permission for both history directions and leaves their stacks available", () => {
    const { ydoc, manager, local } = fixture();
    let writable = true;
    guardUndoManager(manager, getBlocksFragment(ydoc), () => writable, acceptAnswer);
    const second = getBlocks(ydoc)[1];
    if (second === undefined) throw new Error("Missing second block");
    local(() => deleteBlock(ydoc, second.id));
    local(() => appendBlock(ydoc, { type: "paragraph", text: "Replacement" }));
    expect(manager.undo()).not.toBeNull();
    writable = false;
    const before = getBlocks(ydoc);
    const update = vi.fn();
    ydoc.on("update", update);
    expect(manager.undo()).toBeNull();
    expect(manager.redo()).toBeNull();
    expect(getBlocks(ydoc)).toEqual(before);
    expect(manager.undoStack).toHaveLength(1);
    expect(manager.redoStack).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
    writable = true;
    expect(manager.redo()).not.toBeNull();
  });

  it("includes the live history delete filter when predicting whether undo adds a fourth block", () => {
    const { ydoc, manager, local } = fixture();
    appendBlock(ydoc, { type: "paragraph", text: "Third" });
    manager.deleteFilter = () => false;
    guardUndoManager(manager, getBlocksFragment(ydoc), () => true, acceptAnswer);
    const second = getBlocks(ydoc)[1];
    if (second === undefined) throw new Error("Missing second block");
    local(() => {
      deleteBlock(ydoc, second.id);
      appendBlock(ydoc, { type: "paragraph", text: "Replacement" });
    });
    const before = getBlocks(ydoc);
    const update = vi.fn();
    ydoc.on("update", update);
    expect(manager.undo()).toBeNull();
    expect(getBlocks(ydoc)).toEqual(before);
    expect(update).not.toHaveBeenCalled();
  });

  it("counts both physical copies when undo would retain a moved block with the same id", () => {
    const { ydoc, manager, local } = fixture();
    appendBlock(ydoc, { type: "paragraph", text: "Third" });
    const fragment = getBlocksFragment(ydoc);
    const second = fragment.get(1);
    if (!(second instanceof Y.XmlElement)) throw new Error("Missing second block");
    const copy = second.clone();
    local(() => {
      fragment.delete(1, 1);
      fragment.insert(2, [copy]);
    });
    // A protected moved copy survives undo while the original is restored.
    manager.deleteFilter = () => false;
    guardUndoManager(manager, fragment, () => true, (before, after) => {
      expect(getBlocks(after)).toHaveLength(3);
      expect(getBlocksFragment(after).length).toBe(4);
      return decisionAnswerDocEditAllowed(before, after);
    });
    const before = fragment.toArray();
    const update = vi.fn();
    ydoc.on("update", update);
    expect(manager.undo()).toBeNull();
    expect(fragment.toArray()).toEqual(before);
    expect(fragment.length).toBe(3);
    expect(update).not.toHaveBeenCalled();
  });

  it("previews split redo ranges after a collaborator edits restored text", () => {
    const { ydoc, manager, local, peer } = fixture();
    const block = getBlocksFragment(ydoc).get(0);
    if (!(block instanceof Y.XmlElement) || !(block.firstChild instanceof Y.XmlText)) {
      throw new Error("Missing paragraph text");
    }
    const text = block.firstChild;
    let preview: unknown;
    guardUndoManager(manager, getBlocksFragment(ydoc), () => true, (before, after) => {
      preview = getBlocks(after);
      return acceptAnswer(before, after);
    });
    local(() => text.delete(1, 3));
    expect(manager.undo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const remoteBlock = getBlocksFragment(peer).get(0);
    if (!(remoteBlock instanceof Y.XmlElement) || !(remoteBlock.firstChild instanceof Y.XmlText)) {
      throw new Error("Missing remote paragraph text");
    }
    remoteBlock.firstChild.insert(2, "X");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    expect(manager.redo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    expect(manager.undo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
    expect(manager.redo()).not.toBeNull();
    expect(getBlocks(ydoc)).toEqual(preview);
  });
});

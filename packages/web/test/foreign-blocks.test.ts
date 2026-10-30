import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { AllSelection, NodeSelection } from "@tiptap/pm/state";
import { absolutePositionToRelativePosition, getRelativeSelection, redo, relativePositionToAbsolutePosition, undo, ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { appendBlock, cardPartElement, getBlocks, getBlocksFragment, initDoc } from "@uberblick/schema";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import { findForeignBlocks, hasPageFallback } from "../src/editor/palette.js";
import { retypeBlockInTransaction } from "../src/editor/retype.js";
import { pastePlainText, sequentialIds, typeText } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

function documentWithContext(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "foreign-preservation", title: "Compatibility" });
  appendBlock(ydoc, { type: "paragraph", text: "Before" });
  appendBlock(ydoc, { type: "paragraph", text: "After" });
  onTestCleanup(() => ydoc.destroy());
  return ydoc;
}

function mount(ydoc: Y.Doc, editable = true): Editor {
  const element = document.body.appendChild(document.createElement("div"));
  const binding = bindGuardedEditor({
    element, fragment: getBlocksFragment(ydoc), awareness: null, editable,
    newBlockId: sequentialIds(),
  });
  onTestCleanup(() => { binding.destroy(); element.remove(); });
  expect(binding.refused).toBe(false);
  if (binding.editor === null) throw new Error("Expected an editor with per-block placeholders");
  return binding.editor;
}

function opaqueBlock(): Y.XmlElement {
  const block = new Y.XmlElement("future-block");
  block.setAttribute("variant", "not-understood");
  const child = new Y.XmlElement("future-child");
  child.setAttribute("answer", "42");
  const text = new Y.XmlText("Keep this intact");
  text.format(0, 4, { futureMark: { colour: "violet" } });
  text.insertEmbed(5, { future: ["shape", 3] });
  child.insert(0, [text]);
  block.insert(0, [child]);
  return block;
}

function snapshot(node: Y.XmlElement | Y.XmlText | Y.XmlHook): unknown {
  if (node instanceof Y.XmlText) return { delta: node.toDelta() };
  if (node instanceof Y.XmlElement) {
    return { name: node.nodeName, attributes: node.getAttributes(), children: node.toArray().map(snapshot) };
  }
  return { hook: node.toJSON() };
}

/** Observe writes as well as final values: delete-and-recreate cannot satisfy this invariant. */
function protect(ydoc: Y.Doc, block: Y.XmlElement): () => void {
  const before = snapshot(block);
  const descendants = block.toArray();
  const writes: Y.YEvent<Y.AbstractType<unknown>>[] = [];
  const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void => {
    if (transaction.local) writes.push(...events);
  };
  block.observeDeep(observe);
  onTestCleanup(() => block.unobserveDeep(observe));
  return () => {
    expect(getBlocksFragment(ydoc).toArray()).toContain(block);
    expect(block.toArray()).toEqual(descendants);
    for (let index = 0; index < descendants.length; index += 1) expect(block.get(index)).toBe(descendants[index]);
    expect(snapshot(block)).toEqual(before);
    expect(writes).toEqual([]);
  };
}

function mixed(): { ydoc: Y.Doc; editor: Editor; block: Y.XmlElement; intact: () => void } {
  const ydoc = documentWithContext();
  const block = opaqueBlock();
  getBlocksFragment(ydoc).insert(1, [block]);
  const intact = protect(ydoc, block);
  const editor = mount(ydoc);
  intact();
  return { ydoc, editor, block, intact };
}

function stopCapturing(editor: Editor): void {
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
}

describe("opaque unsupported blocks in the bound editor", () => {
  it("uses a placeholder for a nested hook and keeps stray root hooks in the page fallback", () => {
    const nested = documentWithContext();
    const block = getBlocksFragment(nested).get(0) as Y.XmlElement;
    block.insert(1, [new Y.XmlHook("future") as unknown as Y.XmlElement]);
    expect(findForeignBlocks(getBlocksFragment(nested))[0]?.nodeName).toBe("#hook");
    expect(hasPageFallback(getBlocksFragment(nested))).toBe(false);
    const intact = protect(nested, block);
    expect(mount(nested).state.doc.child(0).type.name).toBe("unsupportedBlock");
    intact();

    const stray = documentWithContext();
    getBlocksFragment(stray).insert(1, [new Y.XmlHook("future") as unknown as Y.XmlElement]);
    expect(hasPageFallback(getBlocksFragment(stray))).toBe(true);
    const before = Y.encodeStateAsUpdate(stray);
    const binding = bindGuardedEditor({ element: null, fragment: getBlocksFragment(stray) });
    expect(binding.refused).toBe(true);
    expect(binding.editor).toBeNull();
    expect(Y.encodeStateAsUpdate(stray)).toEqual(before);
    binding.destroy();
  });

  it.each([true, false])("places every detected top-level block beside supported content (editable %s)", (editable) => {
    const ydoc = documentWithContext();
    const future = opaqueBlock();
    const divider = new Y.XmlElement("divider");
    divider.insert(0, [new Y.XmlText("Legacy divider content")]);
    const table = new Y.XmlElement("table");
    table.insert(0, [new Y.XmlText("An unrepresentable table")]);
    const marked = new Y.XmlElement("paragraph");
    const markedText = new Y.XmlText("Unknown formatting");
    markedText.format(0, 7, { underline: true });
    marked.insert(0, [markedText]);
    const embedded = new Y.XmlElement("paragraph");
    const embeddedText = new Y.XmlText("Embedded content");
    embeddedText.insertEmbed(0, { future: "embed" });
    embedded.insert(0, [embeddedText]);
    const nested = new Y.XmlElement("paragraph");
    nested.insert(0, [new Y.XmlElement("future-inline")]);
    const blocks = [future, divider, table, marked, embedded, nested];
    getBlocksFragment(ydoc).insert(1, blocks);
    const intact = blocks.map((block) => protect(ydoc, block));
    expect(findForeignBlocks(getBlocksFragment(ydoc)).map(({ nodeName }) => nodeName)).toEqual([
      "future-block", "#divider-shape", "#table-shape", "#mark:underline", "#embed", "future-inline",
    ]);

    const editor = mount(ydoc, editable);

    expect(editor.isEditable).toBe(editable);
    expect(Array.from({ length: editor.state.doc.childCount }, (_, index) => editor.state.doc.child(index).type.name))
      .toEqual(["paragraph", ...blocks.map(() => "unsupportedBlock"), "paragraph"]);
    expect(editor.view.dom.querySelectorAll(".ub-unsupported-block")).toHaveLength(blocks.length);
    for (const placeholder of editor.view.dom.querySelectorAll(".ub-unsupported-block")) {
      expect(placeholder.textContent).toBe("This block needs a newer version.");
      expect(placeholder.getAttribute("contenteditable")).toBe("false");
    }
    expect(editor.view.dom.textContent).toContain("Before");
    expect(editor.view.dom.textContent).toContain("After");
    expect(editor.view.dom.textContent).not.toContain("Keep this intact");
    for (const assertIntact of intact) assertIntact();
  });

  it.each([
    { name: "typing", edit: (editor: Editor) => { editor.commands.setTextSelection(3); typeText(editor, " typed"); } },
    { name: "paste", edit: (editor: Editor) => { editor.commands.setTextSelection(3); pastePlainText(editor, " pasted"); } },
    { name: "drop", edit: (editor: Editor) => { editor.view.dispatch(editor.state.tr.insertText(" dropped", 3).setMeta("uiEvent", "drop")); } },
    { name: "block-id repair", edit: (editor: Editor) => { editor.view.dispatch(editor.state.tr.setNodeAttribute(0, "id", null)); } },
  ])("edits supported content through $name without writing an opaque block or its missing id", ({ edit }) => {
    const { ydoc, editor, intact, block } = mixed();
    const before = getBlocks(ydoc)[0];
    edit(editor);
    expect(getBlocks(ydoc)[0]).not.toEqual(before);
    expect(getBlocksFragment(ydoc).get(1)).toBe(block);
    expect(block.getAttribute("id")).toBeUndefined();
    intact();
    stopCapturing(editor);
    undo(editor.state);
    intact();
    redo(editor.state);
    intact();
  });

  it.each([
    { name: "selection replacement", edit: (editor: Editor) => editor.state.tr.insertText("replacement", 3, 12) },
    { name: "paste over a selection", edit: (editor: Editor) => editor.state.tr.insertText("pasted", 3, 12).setMeta("uiEvent", "paste") },
    { name: "cut", edit: (editor: Editor) => editor.state.tr.delete(3, 12).setMeta("uiEvent", "cut") },
    { name: "delete all", edit: (editor: Editor) => editor.state.tr.setSelection(new AllSelection(editor.state.doc)).deleteSelection() },
    { name: "delete the placeholder", edit: (editor: Editor) => editor.state.tr.delete(8, 9) },
    { name: "rewrite placeholder attributes", edit: (editor: Editor) => editor.state.tr.setNodeAttribute(8, "id", "repaired") },
    { name: "move the placeholder", edit: (editor: Editor) => editor.state.tr.replaceWith(0, editor.state.doc.content.size,
      Fragment.fromArray([editor.state.doc.child(1), editor.state.doc.child(0), editor.state.doc.child(2)])) },
  ])("keeps the opaque element in place through $name and undo/redo", ({ edit }) => {
    const { ydoc, editor, block, intact } = mixed();
    editor.view.dispatch(edit(editor));
    intact();
    expect(getBlocksFragment(ydoc).get(1)).toBe(block);
    stopCapturing(editor);
    undo(editor.state);
    intact();
    redo(editor.state);
    intact();
  });

  it("refuses retyping a placeholder and leaves duplicate foreign ids untouched", () => {
    const ydoc = documentWithContext();
    const block = opaqueBlock();
    const id = (getBlocksFragment(ydoc).get(0) as Y.XmlElement).getAttribute("id");
    block.setAttribute("id", id!);
    getBlocksFragment(ydoc).insert(1, [block]);
    const intact = protect(ydoc, block);
    const editor = mount(ydoc);
    const tr = editor.state.tr;
    expect(retypeBlockInTransaction(tr, 8, "heading")).toBe(false);
    expect(tr.docChanged).toBe(false);
    editor.view.dispatch(editor.state.tr.insertText("Edit", 1));
    expect(block.getAttribute("id")).toBe(id);
    intact();
  });

  it("omits placeholders from copied or dragged slices pasted into another document", () => {
    const { editor, intact } = mixed();
    const slice = new AllSelection(editor.state.doc).content();
    const copied = editor.view.serializeForClipboard(slice);
    expect(copied.text).toContain("Before");
    expect(copied.text).toContain("After");
    expect(copied.text).not.toContain("newer version");
    expect(copied.dom.querySelector(".ub-unsupported-block")).toBeNull();
    expect(copied.dom.innerHTML).not.toContain("future");
    const target = documentWithContext();
    const destination = mount(target);
    destination.view.dispatch(destination.state.tr.setSelection(new AllSelection(destination.state.doc)));
    expect(destination.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent)).toBe(true);
    expect(getBlocks(target).map(({ text }) => text)).toEqual(["Before", "After"]);
    expect(findForeignBlocks(getBlocksFragment(target))).toEqual([]);
    const onlyPlaceholder = editor.view.serializeForClipboard(editor.state.doc.slice(8, 9));
    expect(onlyPlaceholder.text.trim()).toBe("");
    expect(onlyPlaceholder.dom.textContent).toBe("");
    const before = Y.encodeStateAsUpdate(target);
    destination.view.pasteHTML(onlyPlaceholder.dom.innerHTML, new Event("paste") as ClipboardEvent);
    expect(Y.encodeStateAsUpdate(target)).toEqual(before);
    destination.view.dispatch(destination.state.tr.insert(0, editor.state.doc.child(1)));
    expect(Y.encodeStateAsUpdate(target)).toEqual(before);
    intact();
  });

  it("refuses unsafe writes at the binding even when an editor transaction filter is bypassed", () => {
    const { ydoc, editor, intact } = mixed();
    const binding = ySyncPluginKey.getState(editor.state).binding;
    const doc = editor.state.doc;
    const before = Y.encodeStateAsUpdate(ydoc);
    const unsupported = doc.child(1);
    const unsafeDocuments = [
      doc.copy(Fragment.fromArray([doc.child(0), doc.child(2)])),
      doc.copy(Fragment.fromArray([doc.child(0), unsupported, unsupported, doc.child(2)])),
      doc.copy(Fragment.fromArray([doc.child(0).copy(Fragment.from(unsupported)), doc.child(2)])),
      doc.copy(Fragment.fromArray([doc.child(0), unsupported.type.create(), doc.child(2)])),
    ];
    for (const unsafe of unsafeDocuments) {
      binding._prosemirrorChanged(unsafe);
      expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
      intact();
    }
  });

  it("keeps relative positions inside opaque content out of caret, cursor and comment mappings", () => {
    const { ydoc, editor, block } = mixed();
    const fragment = getBlocksFragment(ydoc);
    const child = block.firstChild as Y.XmlElement;
    const text = child.firstChild as Y.XmlText;
    const binding = ySyncPluginKey.getState(editor.state).binding;
    for (const position of [
      Y.createRelativePositionFromTypeIndex(block, 0),
      Y.createRelativePositionFromTypeIndex(child, 0),
      Y.createRelativePositionFromTypeIndex(text, 3),
    ]) {
      expect(relativePositionToAbsolutePosition(ydoc, fragment, position, binding.mapping)).toBeNull();
    }
    const supported = (fragment.get(0) as Y.XmlElement).firstChild as Y.XmlText;
    expect(relativePositionToAbsolutePosition(ydoc, fragment,
      Y.createRelativePositionFromTypeIndex(supported, 3), binding.mapping)).toBe(4);
    const after = (fragment.get(2) as Y.XmlElement).firstChild as Y.XmlText;
    const position = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + 3;
    expect(relativePositionToAbsolutePosition(ydoc, fragment,
      Y.createRelativePositionFromTypeIndex(after, 2), binding.mapping)).toBe(position);
    expect(relativePositionToAbsolutePosition(ydoc, fragment,
      absolutePositionToRelativePosition(position, fragment, binding.mapping), binding.mapping)).toBe(position);
  });

  it("keeps the supported-only node-selection fallback when a selected ancestor is deleted remotely", () => {
    const ydoc = new Y.Doc();
    onTestCleanup(() => ydoc.destroy());
    initDoc(ydoc, { uuid: "supported-selection", title: "Selection" });
    appendBlock(ydoc, { type: "paragraph", text: "Before" });
    appendBlock(ydoc, { type: "card", text: "title: Title\n\nBody" });
    appendBlock(ydoc, { type: "paragraph", text: "After" });
    const editor = mount(ydoc);
    let position = -1;
    editor.state.doc.descendants((node, pos, parent) => {
      if (node.type.name === "paragraph" && parent?.type.name === "cardTitle") position = pos;
    });
    expect(position).toBeGreaterThan(0);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
    const mapping = ySyncPluginKey.getState(editor.state).binding.mapping;
    const relative = absolutePositionToRelativePosition(position, getBlocksFragment(ydoc), mapping);
    const peer = new Y.Doc();
    onTestCleanup(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    getBlocksFragment(peer).delete(1, 1);

    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

    expect(relativePositionToAbsolutePosition(ydoc, getBlocksFragment(ydoc), relative, mapping)).toBeNull();
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
    expect(editor.isDestroyed).toBe(false);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("paragraph");
    expect(editor.state.selection.anchor).toBe(editor.state.doc.child(0).nodeSize);
  });

  it("keeps a selected nested node's caret valid when its root becomes opaque", () => {
    const ydoc = documentWithContext();
    appendBlock(ydoc, { type: "card", text: "title: Title\n\nBody" });
    const editor = mount(ydoc);
    let position = -1;
    editor.state.doc.descendants((node, pos, parent) => {
      if (node.type.name === "paragraph" && parent?.type.name === "cardTitle") position = pos;
    });
    expect(position).toBeGreaterThan(0);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
    const peer = new Y.Doc();
    onTestCleanup(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    cardPartElement(getBlocksFragment(peer).get(2) as Y.XmlElement, "title")!.setAttribute("future", "shape");

    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

    expect(editor.state.doc.child(2).type.name).toBe("unsupportedBlock");
    expect(editor.state.selection.anchor).not.toBeNull();
    const binding = ySyncPluginKey.getState(editor.state).binding;
    const relative = getRelativeSelection(binding, editor.state);
    expect(relativePositionToAbsolutePosition(ydoc, getBlocksFragment(ydoc), relative.anchor, binding.mapping)).not.toBeNull();
    const intact = protect(ydoc, getBlocksFragment(ydoc).get(2) as Y.XmlElement);
    editor.commands.setTextSelection(2);
    typeText(editor, " edited");
    expect(getBlocks(ydoc)[0]?.text).toContain(" edited");
    intact();
  });

  it("replaces only the affected block in both live directions without rebinding", () => {
    const ydoc = documentWithContext();
    const editor = mount(ydoc);
    const block = getBlocksFragment(ydoc).get(1) as Y.XmlElement;
    const text = block.firstChild as Y.XmlText;
    text.format(0, 5, { futureMark: { version: 2 } });
    expect(editor.isDestroyed).toBe(false);
    expect(editor.isEditable).toBe(true);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).type.name).toBe("unsupportedBlock");
    const intact = protect(ydoc, block);
    editor.commands.setTextSelection(2);
    typeText(editor, " edited");
    intact();
    text.format(0, 5, { futureMark: null });
    expect(editor.isDestroyed).toBe(false);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    const offset = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection(offset);
    typeText(editor, "Now supported: ");
    expect(text.toString()).toBe("Now supported: After");
  });

  it.each(["before", "during", "after"] as const)("merges remote changes inside opaque content arriving %s supported edits", (arrival) => {
    const { ydoc, editor, block } = mixed();
    const peer = new Y.Doc();
    onTestCleanup(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const peerBlock = getBlocksFragment(peer).get(1) as Y.XmlElement;
    const peerChild = peerBlock.firstChild as Y.XmlElement;
    const peerText = peerChild.firstChild as Y.XmlText;
    const text = (block.firstChild as Y.XmlElement).firstChild as Y.XmlText;
    const arrive = (): void => {
      peer.transact(() => {
        peerBlock.setAttribute("future-revision", "two");
        peerText.insert(0, "Remote ");
        peerText.format(0, 6, { futureMark: { colour: "blue" } });
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    };
    editor.commands.setTextSelection(2);
    if (arrival === "before") arrive();
    typeText(editor, " first");
    if (arrival === "during") arrive();
    typeText(editor, " second");
    if (arrival === "after") arrive();
    const intact = protect(ydoc, block);
    stopCapturing(editor);
    undo(editor.state);
    redo(editor.state);
    intact();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    expect(snapshot(block)).toEqual(snapshot(peerBlock));
    expect(text).toBe((block.firstChild as Y.XmlElement).firstChild);
    expect(getBlocks(ydoc)[0]?.text).toContain(" first second");
    expect(getBlocks(peer)[0]?.text).toBe(getBlocks(ydoc)[0]?.text);
    expect(getBlocksFragment(ydoc).get(1)).toBe(block);
    expect(editor.state.doc.child(1).type.name).toBe("unsupportedBlock");
  });

  it.each(["undo", "redo"] as const)("does not %s history inside a block that became unsupported", (history) => {
    const ydoc = documentWithContext();
    const editor = mount(ydoc);
    editor.commands.setTextSelection(10);
    typeText(editor, " local");
    stopCapturing(editor);
    if (history === "redo") undo(editor.state);
    const peer = new Y.Doc();
    onTestCleanup(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const peerText = (getBlocksFragment(peer).get(1) as Y.XmlElement).firstChild as Y.XmlText;
    peerText.format(0, 3, { unknownMark: true });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    const block = getBlocksFragment(ydoc).get(1) as Y.XmlElement;
    const intact = protect(ydoc, block);
    expect(editor.state.doc.child(1).type.name).toBe("unsupportedBlock");
    undo(editor.state);
    intact();
    redo(editor.state);
    intact();
  });
});

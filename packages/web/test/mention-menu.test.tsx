/**
 * The `@` picker.
 *
 * What is worth defending is the document and the trigger, not the pixels. Four
 * contracts:
 *
 * 1. **The trigger is exact.** An `@` opens a picker only where a mention can
 *    begin — after a space or at the start of a prose block — and only on this
 *    reader typing it. An e-mail address, a source block, a peer's keystroke, an
 *    undo and a paste all leave the text alone.
 * 2. **A picked reference is a typed one.** Same `docLink` mark, same uuid, the
 *    directory's title as ordinary text, the `@query` gone, one undo step, and
 *    what the reader types next is unmarked prose.
 * 3. **Dismissing changes nothing.** Esc, a click outside, and a query nothing
 *    matches leave the typed characters exactly as typed — and give Enter back
 *    to the prose.
 * 4. **It never acts on a block that has moved or gone**, and never offers the
 *    open document or an archived one.
 *
 * Everything is read back out of a real Y.Doc through the schema package. One
 * composing Enter checks that ProseMirror owns this picker's key handling.
 * Layout is not asserted — jsdom has none; the caret-anchored gesture end to end
 * is `e2e/doc-link.spec.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, render } from "./react-render.js";
import * as Y from "yjs";
import {
  appendBlock,
  deleteBlock,
  editBlock,
  getBlocks,
  getBlocksFragment,
  initDoc,
  tableCellText,
  tableRows,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
  writeGfmTable,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { redo, undo } from "y-prosemirror";
import { createDocLinkContext } from "../src/editor/doc-links.js";
import type { DocLinkContext } from "../src/editor/doc-links.js";
import {
  linkMentionAtTrigger,
  mentionTriggerAt,
} from "../src/editor/mention-menu.js";
import type { MentionTrigger } from "../src/editor/mention-menu.js";
import { MentionMenu } from "../src/ui/editor-controls/MentionMenu.js";
import { mountEditor, snapshotFragment } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** The document being written in — never offered as a target. */
const DOC = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const HUB = "0189abcd-2222-4333-8444-555566667777";
const BLOCKS = "3f7d1e88-1111-4222-9333-444455556666";

/** A directory naming three documents, and a context over it. */
function directory(): { ydoc: Y.Doc; context: DocLinkContext; opened: string[] } {
  const ydoc = new Y.Doc();
  upsertDirectoryEntry(ydoc, { uuid: DOC, title: "References" });
  upsertDirectoryEntry(ydoc, { uuid: HUB, title: "The hub" });
  upsertDirectoryEntry(ydoc, { uuid: BLOCKS, title: "Editing and blocks" });
  const opened: string[] = [];
  const context = createDocLinkContext({
    directory: ydoc,
    href: (uuid) => `/${WORKSPACE}/${uuid}`,
    open: (uuid) => opened.push(uuid),
  });
  return { ydoc, context, opened };
}

function docWith(
  blocks: Array<{ type: "paragraph" | "code" | "terminal" | "chart"; text: string }>,
): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "References" });
  const ids = blocks.map((block) => appendBlock(ydoc, block));
  return { ydoc, ids };
}

interface Mounted {
  editor: Editor;
  card: () => Element | null;
  labels: () => string[];
  /** Returns the event, whose `defaultPrevented` says whether the picker took it. */
  press: (key: string, init?: KeyboardEventInit) => KeyboardEvent;
  pick: (label: string) => void;
  unmountMenu: () => void;
  unmount: () => void;
}

/** An editor with the picker mounted over it, the way `EditorPane` wires them. */
function mountPicker(ydoc: Y.Doc, context: DocLinkContext): Mounted {
  const { editor, element } = mountEditor(ydoc, { docLinks: context });
  const frame = document.createElement("div");
  onTestCleanup(() => frame.remove());
  document.body.appendChild(frame);
  frame.appendChild(element);
  const container = document.createElement("div");
  frame.appendChild(container);
  const view = render(
    <MentionMenu
      editor={editor}
      host={{ current: frame }}
      docLinks={context}
      openDocId={DOC}
    />,
    { container },
  );

  let menuMounted = true;
  const unmountMenu = (): void => {
    if (!menuMounted) return;
    view.unmount();
    menuMounted = false;
  };
  return {
    editor,
    // The card is nameless presentation and stays open when no listbox exists;
    // empty-state tests below prove this same handle still finds that open card.
    card: () => document.body.querySelector('[data-slot="caret-menu-content"]'),
    labels: () =>
      screen.queryAllByRole("option").map(
        (node) => node.getAttribute("aria-label") ?? "",
      ),
    press: (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        editor.view.dom.dispatchEvent(event);
      });
      return event;
    },
    pick: (label: string) => {
      const entry = screen.getByRole("option", { name: label });
      act(() => entry.click());
    },
    unmountMenu,
    unmount: () => {
      unmountMenu();
      frame.remove();
      editor.destroy();
    },
  };
}

/** Type into the editor the way a reader does — one transaction per gesture. */
function type(editor: Editor, text: string): void {
  act(() => {
    editor.commands.insertContent(text);
  });
}

/** Put the caret `offset` characters into block `index`. */
function caret(editor: Editor, index: number, offset: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  act(() => {
    editor.commands.setTextSelection(pos + offset);
  });
}

/** Backspace: the one-character deletion prosemirror-commands dispatches. */
function backspace(editor: Editor): void {
  act(() => {
    const { state } = editor;
    const at = state.selection.from;
    editor.view.dispatch(state.tr.delete(at - 1, at));
  });
}

/** The first block's delta — text and marks together, as Yjs holds them. */
function delta(ydoc: Y.Doc): Array<Record<string, unknown>> {
  return snapshotFragment(ydoc)[0]?.delta ?? [];
}

/** A second replica, wired the way the hub wires two clients. */
function peerOf(local: Y.Doc): Y.Doc {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return remote;
}

function tableDoc(rows: string[][] = [["", "Header"], ["", "Body"]]): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "References" });
  appendBlock(ydoc, { type: "table", text: writeGfmTable(rows) });
  return ydoc;
}

/** Positions are read from the live table, never saved row or column offsets. */
function cellPosition(editor: Editor, row: number, column: number): number {
  const table = editor.state.doc.firstChild!;
  let position = 1;
  for (let index = 0; index < row; index += 1) position += table.child(index).nodeSize;
  position += 1;
  for (let index = 0; index < column; index += 1) position += table.child(row).child(index).nodeSize;
  return position + 2;
}

function cellCaret(editor: Editor, row: number, column: number, offset = 0): void {
  act(() => editor.commands.setTextSelection(cellPosition(editor, row, column) + offset));
}

function cell(ydoc: Y.Doc, row: number, column: number): Y.XmlElement {
  return tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement)[row]![column]!;
}

function cellDelta(ydoc: Y.Doc, row: number, column: number): unknown[] {
  return tableCellText(cell(ydoc, row, column))?.toDelta() ?? [];
}

describe("the picker", () => {
  it("identifies the highlighted document from the prose, and clears an empty list", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      const list = screen.queryByRole("listbox", { name: "Documents" });
      if (list === null || list === undefined) throw new Error("no list");
      const options = within(list).getAllByRole("option");
      expect(mounted.editor.view.dom.getAttribute("aria-controls")).toBe(list.id);
      expect(mounted.editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[0]?.id,
      );
      mounted.press("ArrowDown");
      expect(mounted.editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[1]?.id,
      );
      act(() => {
        options[0]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      expect(mounted.editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[0]?.id,
      );
      expect(options[0]?.getAttribute("aria-selected")).toBe("true");

      type(mounted.editor, "nope");
      expect(mounted.card()).not.toBeNull();
      expect(mounted.editor.view.dom.hasAttribute("aria-activedescendant")).toBe(
        false,
      );
      expect(mounted.editor.view.dom.hasAttribute("aria-controls")).toBe(false);
    } finally {
      mounted.unmount();
    }
  });

  it("removes its keys and active descendant when the picker unmounts", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.editor.view.dom.hasAttribute("aria-activedescendant")).toBe(
        true,
      );
      mounted.unmountMenu();
      expect(mounted.editor.view.dom.hasAttribute("aria-activedescendant")).toBe(
        false,
      );
      expect(mounted.editor.view.dom.hasAttribute("aria-controls")).toBe(false);
      mounted.press("Enter");
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["@hub", ""]);
    } finally {
      mounted.unmount();
    }
  });

  it("offers every document but the open one, and the arrows and Enter pick one", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "see ");
      type(mounted.editor, "@");

      // Sorted by title, and "References" — the document being written in — is
      // absent: a reference to where the reader already is says nothing.
      expect(mounted.labels()).toEqual(["Editing and blocks", "The hub"]);

      mounted.press("ArrowDown");
      const enter = mounted.press("Enter");
      // The picker took the key, so ProseMirror never split the paragraph.
      expect(enter.defaultPrevented).toBe(true);
      expect(getBlocks(ydoc)).toHaveLength(1);

      expect(delta(ydoc)).toEqual([
        { insert: "see " },
        { insert: "The hub", attributes: { docLink: { docId: HUB } } },
      ]);
      expect(mounted.card()).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("narrows as you type, and what follows a picked reference is plain prose", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.labels()).toEqual(["The hub"]);

      // The pointer path: clicking a row does what Enter does.
      mounted.pick("The hub");
      type(mounted.editor, " is where it syncs");

      // `docLink` is not inclusive, so the sentence after the reference carries
      // no mark — the label is the reference, not everything typed after it.
      expect(delta(ydoc)).toEqual([
        { insert: "The hub", attributes: { docLink: { docId: HUB } } },
        { insert: " is where it syncs" },
      ]);
      expect(getBlocks(ydoc)[0]?.text).toBe("The hub is where it syncs");

      // One gesture, one undo step: the reader gets their `@query` back, not the
      // empty block they started from.
      act(() => {
        mounted.editor.commands.keyboardShortcut("Mod-z");
      });
      act(() => {
        mounted.editor.commands.keyboardShortcut("Mod-z");
      });
      expect(getBlocks(ydoc)[0]?.text).toBe("@hub");
    } finally {
      mounted.unmount();
    }
  });

  it("leaves an e-mail address alone, and a space ends a session", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "write ben");
      type(mounted.editor, "@");
      // The `@` has a letter in front of it, so it is an address, not a mention.
      expect(mentionTriggerAt(mounted.editor)).toBeNull();
      expect(mounted.card()).toBeNull();
      type(mounted.editor, "example.com");
      expect(getBlocks(ydoc)[0]?.text).toBe("write ben@example.com");

      // A space after a real trigger is a reader writing prose, not filtering.
      type(mounted.editor, " ");
      type(mounted.editor, "@");
      expect(mounted.card()).not.toBeNull();
      type(mounted.editor, " ");
      expect(mounted.card()).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("write ben@example.com @ ");
    } finally {
      mounted.unmount();
    }
  });

  /** Source blocks cannot hold the picked `docLink` mark. */
  it.each(["code", "terminal", "chart"] as const)("never opens in a %s source block", (source) => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: source, text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      expect(mentionTriggerAt(mounted.editor)).toBeNull();
      expect(mounted.card()).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("@");
    } finally {
      mounted.unmount();
    }
  });

  it("says which question it answered when nothing matches, and gives Enter back", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "zzz");

      // Open, and saying so — an empty card would read as "there are none",
      // which a partly synced replica cannot claim.
      const card = mounted.card();
      expect(card?.textContent).toBe(
        "No document this page knows matches.",
      );

      // Nothing to move over or pick, so the keys are the prose's again: this
      // Enter reaches ProseMirror and splits the paragraph.
      mounted.press("ArrowDown");
      mounted.press("Enter");
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["@zzz", ""]);
    } finally {
      mounted.unmount();
    }
  });

  it("leaves the typed text exactly as typed when Esc dismisses it", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hu");
      expect(mounted.card()).not.toBeNull();

      mounted.press("Escape");
      expect(mounted.card()).toBeNull();
      expect(mounted.editor.view.dom.hasAttribute("aria-activedescendant")).toBe(
        false,
      );
      expect(mounted.editor.view.dom.hasAttribute("aria-controls")).toBe(false);
      expect(delta(ydoc)).toEqual([{ insert: "@hu" }]);

      // Dismissed for this session only: typing on keeps it shut…
      type(mounted.editor, "b");
      expect(mounted.card()).toBeNull();
      // …and a fresh trigger opens it again.
      type(mounted.editor, " ");
      type(mounted.editor, "@");
      expect(mounted.card()).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * The candidates are the directory this replica already holds — no target
   * room is opened to offer one, which is also why an archived document is
   * simply absent rather than offered and then refused.
   */
  it("never offers an archived document, and picks up one that arrives", () => {
    const { ydoc: dir, context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      tombstoneDirectoryEntry(dir, HUB);
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      expect(mounted.labels()).toEqual(["Editing and blocks"]);

      act(() => {
        upsertDirectoryEntry(dir, {
          uuid: "9a1b2c3d-4444-4555-8666-777788889999",
          title: "Sync topology",
        });
      });
      expect(mounted.labels()).toEqual(["Editing and blocks", "Sync topology"]);
    } finally {
      mounted.unmount();
    }
  });

  /**
   * The hazard a stale position hides: the block the session belongs to is
   * deleted by a peer, and the saved range now points into its successor.
   * Splicing there would put a reference into somebody else's sentence.
   */
  it("refuses when the block the session was in has gone", () => {
    const { context } = directory();
    const { ydoc, ids } = docWith([
      { type: "paragraph", text: "" },
      { type: "paragraph", text: "a neighbour with content" },
    ]);
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      const trigger = mentionTriggerAt(mounted.editor);
      expect(trigger).not.toBeNull();

      act(() => {
        deleteBlock(peer, ids[0] ?? "");
      });

      expect(mounted.card()).toBeNull();
      expect(
        linkMentionAtTrigger(
          mounted.editor,
          trigger as MentionTrigger,
          HUB,
          context,
        ),
      ).toBe(false);
      expect(getBlocks(ydoc).map((block) => [block.id, block.text])).toEqual([
        [ids[1], "a neighbour with content"],
      ]);
    } finally {
      mounted.unmount();
      peer.destroy();
    }
  });

  /**
   * A session belongs to one `@`. A block can hold two, and a caret moved from
   * one to the other is a different mention: the card closes rather than
   * silently re-aiming at the occurrence the reader walked into.
   */
  it("closes when the caret moves to another mention in the same block", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "one @hub two ");
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.card()).not.toBeNull();

      // Onto the end of the *first* `@hub`, which is trigger-shaped too.
      caret(mounted.editor, 0, 8);
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "hub" });
      expect(mounted.card()).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * Typing the `@` over a selection is still typing it. The gate asks what this
   * transaction *wrote*, not what the block ended up holding — which is the
   * whole point, because selecting `@x` and typing `@` leaves the block's text
   * holding exactly as many `@` as before.
   */
  it("opens when the typed @ replaces a selection", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "see @x" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      act(() => {
        mounted.editor.commands.setTextSelection({ from: 5, to: 7 });
      });
      type(mounted.editor, "@");
      expect(getBlocks(ydoc)[0]?.text).toBe("see @");
      expect(mounted.card()).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * And the deletion form of the same question, which is the one gesture the
   * written-range test is alone in refusing: a peer's edit, an undo and a redo
   * are already a change from elsewhere, and a paste carries its `uiEvent`.
   * Deleting `notes` back off a week-old `@notes` leaves the caret exactly
   * where typing an `@` would have, having typed nothing.
   */
  it("never opens by deleting back onto an @ that was already prose", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "see @notes" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 10);
      for (let i = 0; i < 5; i += 1) backspace(mounted.editor);

      // Trigger-shaped, caret in it, and no picker: the text is prose that has
      // been there since last week.
      expect(getBlocks(ydoc)[0]?.text).toBe("see @");
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "" });
      expect(mounted.card()).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * The picker is this reader's, and only this reader's. A peer typing an `@`
   * into the block the caret sits in must not open one — that is a menu popping
   * up on somebody else's keystroke.
   */
  it("never opens on a peer's edit, an undo, a redo, or a paste", () => {
    const { context } = directory();
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "note " }]);
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 5);

      act(() => {
        editBlock(peer, ids[0] ?? "", "note ", "note @");
      });
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "" });
      expect(mounted.card()).toBeNull();

      // A paste that happens to end in `@` is content, not a request.
      act(() => {
        const { state } = mounted.editor;
        mounted.editor.view.dispatch(
          state.tr
            .insertText("see @", state.selection.from)
            .setMeta("uiEvent", "paste"),
        );
      });
      expect(mounted.card()).toBeNull();

      // And neither an undo that restores a trigger-looking text nor the redo
      // that puts it back is a request for a picker. Driven through
      // y-prosemirror's own `undo`/`redo`, which is what `Mod-z` is bound to:
      // an undo goes to the Y.Doc and comes back as a change from elsewhere,
      // exactly like the peer's edit above.
      act(() => {
        undo(mounted.editor.state);
      });
      expect(mounted.card()).toBeNull();
      act(() => {
        redo(mounted.editor.state);
      });
      expect(mounted.card()).toBeNull();
    } finally {
      mounted.unmount();
      peer.destroy();
    }
  });

  it("leaves composing Enter to ProseMirror", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.card()).not.toBeNull();

      act(() => {
        mounted.editor.view.dom.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
      });
      const enter = mounted.press("Enter", { isComposing: true });
      expect(enter.defaultPrevented).toBe(false);
      expect(delta(ydoc)).toEqual([{ insert: "@hub" }]);
      expect(getBlocks(ydoc)).toHaveLength(1);
      expect(mounted.card()).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});

describe("the picker in editable table cells", () => {
  it.each([0, 1])("writes the shared link in row %i, syncs and reloads it, and undoes the pick once", (row) => {
    const { context } = directory();
    const ydoc = tableDoc();
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, row, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.labels()).toEqual(["The hub"]);
      if (row === 0) mounted.pick("The hub");
      else expect(mounted.press("Enter").defaultPrevented).toBe(true);

      const expected = [{ insert: "The hub", attributes: { docLink: { docId: HUB } } }];
      expect(cellDelta(ydoc, row, 0)).toEqual(expected);
      expect(cellDelta(peer, row, 0)).toEqual(expected);
      expect(getBlocks(ydoc)[0]?.text).toContain(`[The hub](${HUB})`);
      expect(cellDelta(ydoc, row, 1)).toEqual([{ insert: row === 0 ? "Header" : "Body" }]);
      expect(mounted.card()).toBeNull();

      const restored = new Y.Doc();
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(ydoc));
      const reloaded = mountEditor(restored, { docLinks: context }).editor;
      try {
        expect(reloaded.view.dom.querySelector(`${row === 0 ? "th" : "td"} .ub-doclink`)?.textContent).toBe("The hub");
        expect(getBlocks(restored)).toEqual(getBlocks(ydoc));
      } finally {
        reloaded.destroy();
        restored.destroy();
      }

      act(() => { mounted.editor.commands.keyboardShortcut("Mod-z"); });
      expect(cellDelta(ydoc, row, 0)).toEqual([{ insert: "@hub" }]);
      expect(mounted.card()).toBeNull();
    } finally {
      mounted.unmount();
      peer.destroy();
      ydoc.destroy();
    }
  });

  it("shares directory filtering and keyboard highlights with prose while documents arrive", () => {
    const { ydoc: dir, context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      tombstoneDirectoryEntry(dir, HUB);
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      expect(mounted.labels()).toEqual(["Editing and blocks"]);
      const arrived = "9a1b2c3d-4444-4555-8666-777788889999";
      act(() => upsertDirectoryEntry(dir, { uuid: arrived, title: "Thé hub" }));
      expect(mounted.labels()).toEqual(["Editing and blocks", "Thé hub"]);
      mounted.press("ArrowDown");
      expect(screen.getByRole("option", { name: "Thé hub" }).getAttribute("aria-selected")).toBe("true");
      mounted.press("ArrowUp");
      expect(screen.getByRole("option", { name: "Editing and blocks" }).getAttribute("aria-selected")).toBe("true");
      type(mounted.editor, "THE");
      expect(mounted.labels()).toEqual(["Thé hub"]);
      mounted.press("Enter");
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: "Thé hub", attributes: { docLink: { docId: arrived } } }]);
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it("folds a multiline directory title into valid single-line cell text", () => {
    const { ydoc: dir, context } = directory();
    upsertDirectoryEntry(dir, { uuid: HUB, title: "The\r\nhub\nroom" });
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      mounted.press("Enter");
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: "The hub room", attributes: { docLink: { docId: HUB } } }]);
      expect(getBlocks(ydoc)[0]?.text).toContain(`[The hub room](${HUB})`);
      act(() => { mounted.editor.commands.keyboardShortcut("Mod-z"); });
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: "@hub" }]);
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it.each(["", "word ", "ben", "("])("keeps the prose boundary rule after %j", (prefix) => {
    const { context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      if (prefix !== "") type(mounted.editor, prefix);
      type(mounted.editor, "@");
      expect(mounted.card() !== null).toBe(prefix === "" || prefix.endsWith(" "));
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: `${prefix}@` }]);
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it.each(["Escape", "space", "caret"])("dismisses a cell session on %s without altering the query", (gesture) => {
    const { context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.card()).not.toBeNull();
      if (gesture === "Escape") mounted.press("Escape");
      else if (gesture === "space") type(mounted.editor, " ");
      else cellCaret(mounted.editor, 1, 1);
      expect(mounted.card()).toBeNull();
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: gesture === "space" ? "@hub " : "@hub" }]);
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it.each(["paste", "drop"])("does not open from a %s or its undo and redo", (uiEvent) => {
    const { context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      act(() => mounted.editor.view.dispatch(mounted.editor.state.tr.insertText("@").setMeta("uiEvent", uiEvent)));
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "" });
      expect(mounted.card()).toBeNull();
      act(() => { undo(mounted.editor.state); });
      expect(mounted.card()).toBeNull();
      act(() => { redo(mounted.editor.state); });
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "" });
      expect(mounted.card()).toBeNull();
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it("does not open from a peer insertion or deleting back to a stored @", () => {
    const { context } = directory();
    const ydoc = tableDoc([["Header", ""], ["@notes", ""]]);
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0, 6);
      for (let index = 0; index < 5; index += 1) backspace(mounted.editor);
      expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "" });
      expect(mounted.card()).toBeNull();
      cellCaret(mounted.editor, 1, 1);
      act(() => tableCellText(cell(peer, 1, 1))!.insert(0, "@"));
      expect(mounted.card()).toBeNull();
      expect(cellDelta(ydoc, 1, 1)).toEqual([{ insert: "@" }]);
    } finally { mounted.unmount(); peer.destroy(); ydoc.destroy(); }
  });

  it("refuses both a locked editor and a pick saved before it became locked", () => {
    const { context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      const trigger = mentionTriggerAt(mounted.editor)!;
      act(() => mounted.editor.setEditable(false));
      expect(mentionTriggerAt(mounted.editor)).toBeNull();
      expect(mounted.card()).toBeNull();
      expect(linkMentionAtTrigger(mounted.editor, trigger, HUB, context)).toBe(false);
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: "@hub" }]);
      cellCaret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      expect(mounted.card()).toBeNull();
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it.each(["closed", "empty"])("preserves TableKit keys when the picker is %s", (session) => {
    const { context } = directory();
    const ydoc = tableDoc();
    const mounted = mountPicker(ydoc, context);
    // jsdom has no text layout. These calls only matter after the picker has
    // yielded the keys to TableKit; browser tests cover physical arrow motion.
    const edge = vi.spyOn(mounted.editor.view, "endOfTextblock").mockReturnValue(false);
    const coords = vi.spyOn(mounted.editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "zzz");
      if (session === "closed") mounted.press("Escape");
      expect(mounted.labels()).toEqual([]);
      const before = getBlocks(ydoc);
      const at = mounted.editor.state.selection.from;
      mounted.press("ArrowUp");
      mounted.press("ArrowDown");
      mounted.press("Enter");
      expect(getBlocks(ydoc)).toEqual(before);
      expect(mounted.editor.state.selection.from).toBe(at);
      mounted.press("Tab");
      expect(mounted.editor.state.selection.from).toBe(cellPosition(mounted.editor, 1, 1));
      expect(getBlocks(ydoc)).toEqual(before);
      expect(mounted.card()).toBeNull();
    } finally { edge.mockRestore(); coords.mockRestore(); mounted.unmount(); ydoc.destroy(); }
  });

  it("does not re-aim a saved pick at the same query in another cell or occurrence", () => {
    const { context } = directory();
    const ydoc = tableDoc([["Header", ""], ["", "@hub"]]);
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "earlier @hub ");
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      const trigger = mentionTriggerAt(mounted.editor)!;
      for (const [row, column, offset] of [[1, 0, 12], [1, 1, 4]] as const) {
        cellCaret(mounted.editor, row, column, offset);
        expect(mentionTriggerAt(mounted.editor)).toMatchObject({ query: "hub" });
        expect(mounted.card()).toBeNull();
        const before = getBlocks(ydoc);
        expect(linkMentionAtTrigger(mounted.editor, trigger, HUB, context)).toBe(false);
        expect(getBlocks(ydoc)).toEqual(before);
      }
    } finally { mounted.unmount(); ydoc.destroy(); }
  });

  it.each(["caret", "peer"])("refuses a rendered pointer callback before React commits the %s change", (change) => {
    const { context } = directory();
    const ydoc = tableDoc([["Header", ""], ["", "@hub"]]);
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc, context);
    try {
      cellCaret(mounted.editor, 1, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      const option = screen.getByRole("option", { name: "The hub" });
      act(() => {
        if (change === "caret") mounted.editor.commands.setTextSelection(cellPosition(mounted.editor, 1, 1) + 4);
        else peer.transact(() => {
          const text = tableCellText(cell(peer, 1, 0))!;
          text.delete(0, 4);
          text.insert(0, "@hub");
        });
        // The old option and its callback still exist until this act commits.
        option.click();
      });
      expect(mounted.card()).toBeNull();
      expect(cellDelta(ydoc, 1, 0)).toEqual([{ insert: "@hub" }]);
      expect(cellDelta(ydoc, 1, 1)).toEqual([{ insert: "@hub" }]);
    } finally { mounted.unmount(); peer.destroy(); ydoc.destroy(); }
  });

  it.each(["deleteRow"] as const)(
    "a %s cannot send a saved pick to an identical query in another cell",
    (command) => {
      const { context } = directory();
      const ydoc = tableDoc([["@hub", "@hub"], ["", "@hub"], ["@hub", "@hub"]]);
      const mounted = mountPicker(ydoc, context);
      try {
        cellCaret(mounted.editor, 1, 0);
        type(mounted.editor, "@");
        type(mounted.editor, "hub");
        const trigger = mentionTriggerAt(mounted.editor)!;
        const original = cell(ydoc, 1, 0);
        act(() => { expect(mounted.editor.commands[command]()).toBe(true); });
        const before = getBlocks(ydoc);
        expect(linkMentionAtTrigger(mounted.editor, trigger, HUB, context)).toBe(false);
        expect(getBlocks(ydoc)).toEqual(before);
        if (mounted.card() !== null) {
          mounted.press("Enter");
          expect(tableCellText(original)?.toDelta()).toEqual([
            { insert: "The hub", attributes: { docLink: { docId: HUB } } },
          ]);
        }
        for (const candidate of tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement).flat()) {
          if (candidate !== original) expect(tableCellText(candidate)?.toDelta()).not.toEqual([
            { insert: "The hub", attributes: { docLink: { docId: HUB } } },
          ]);
        }
      } finally { mounted.unmount(); ydoc.destroy(); }
    },
  );

});

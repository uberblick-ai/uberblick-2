/**
 * The block-insertion menu: the slash path and the gutter path.
 *
 * What is worth defending here is the document, not the pixels. Three
 * contracts:
 *
 * 1. **The slash trigger is exact.** It opens on an empty paragraph and nowhere
 *    else — a slash typed mid-sentence is a slash, and a menu that opened there
 *    would eat the next Enter.
 * 2. **Converting keeps the block.** The block id survives the re-type (it is
 *    the same block, so every reference to it stays valid), the typed `/query`
 *    never reaches the saved text, and the whole gesture is one undo step.
 * 3. **Inserting makes exactly one new block**, below the one that was hovered,
 *    with an id of its own and the caret inside it.
 *
 * Everything is read back out of a real Y.Doc through the schema package: the
 * document is the deliverable, the menu is just how a reader asks for it.
 *
 * Layout is not asserted — jsdom has none. The gutter's "reveal without moving
 * the prose" claim is checked in the browser (`e2e/block-menu.spec.ts`).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { appendBlock, getBlocks, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "y-prosemirror";
import {
  BLOCK_MENU_ENTRIES,
  filterBlockMenu,
  slashTriggerAt,
} from "../src/editor/block-menu.js";
import { BlockMenu } from "../src/ui/BlockMenu.js";
import { mountEditor } from "./helpers.js";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

interface Mounted {
  editor: Editor;
  ydoc: Y.Doc;
  /** The frame the menu is positioned inside — its own DOM, queried below. */
  frame: HTMLElement;
  query: <T extends Element>(selector: string) => T | null;
  entryLabels: () => string[];
  /** A key, taken the way the browser delivers it: from inside the prose. */
  press: (key: string) => void;
  unmount: () => void;
}

/** An editor with the menu mounted over it, the way `EditorPane` wires them. */
function mountMenu(ydoc: Y.Doc): Mounted {
  const { editor, element } = mountEditor(ydoc);
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  // The frame stands in for `.ub-editor-frame`; the editor host is its child,
  // because the menu takes keys on the host in the capture phase.
  frame.appendChild(element);
  const root = createRoot(frame);
  act(() => {
    root.render(<BlockMenu editor={editor} host={{ current: frame }} />);
  });

  const query = <T extends Element>(selector: string): T | null =>
    frame.querySelector<T>(selector);
  return {
    editor,
    ydoc,
    frame,
    query,
    entryLabels: () =>
      [...frame.querySelectorAll(".ub-blockmenu-label")].map(
        (node) => node.textContent ?? "",
      ),
    press: (key: string) => {
      act(() => {
        editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    },
    unmount: () => {
      act(() => root.unmount());
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

function docWith(blocks: Array<{ type: "paragraph" | "heading"; text: string }>): {
  ydoc: Y.Doc;
  ids: string[];
} {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "menu-doc", title: "Menu" });
  const ids = blocks.map((block) =>
    block.type === "heading"
      ? appendBlock(ydoc, { type: "heading", text: block.text, level: 2 })
      : appendBlock(ydoc, { type: "paragraph", text: block.text }),
  );
  return { ydoc, ids };
}

/** Every block has an id, and no two are the same. */
function soundIds(ydoc: Y.Doc): string[] {
  const ids = getBlocks(ydoc).map((block) => block.id);
  expect(ids.every((id) => id !== "")).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

/**
 * End the UndoManager's capture window. It merges edits made within 500ms into
 * one stack item, so a synchronous test has to stand in for the pause a reader
 * takes between typing and picking an entry.
 */
function endUndoStep(editor: Editor): void {
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
}

describe("the registry", () => {
  it("offers the whole palette and nothing else", () => {
    expect(BLOCK_MENU_ENTRIES.map((entry) => entry.label)).toEqual([
      "Paragraph",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Code",
      "Mermaid",
    ]);
  });

  it("filters on label, hint and keyword alike", () => {
    const labels = (query: string): string[] =>
      filterBlockMenu(query).map((entry) => entry.label);
    expect(labels("")).toHaveLength(BLOCK_MENU_ENTRIES.length);
    expect(labels("he")).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(labels("h2")).toEqual(["Heading 2"]);
    expect(labels("##")).toEqual(["Heading 2", "Heading 3"]);
    expect(labels("```")).toEqual(["Code"]);
    expect(labels("diagram")).toEqual(["Mermaid"]);
    expect(labels("nothing here")).toEqual([]);
  });
});

describe("the slash trigger", () => {
  it("opens on an empty paragraph and stays shut mid-text", () => {
    const { ydoc } = docWith([
      { type: "paragraph", text: "" },
      { type: "paragraph", text: "already written" },
    ]);
    const { editor, unmount } = mountMenu(ydoc);
    try {
      // Empty block: the slash is a trigger.
      caret(editor, 0, 0);
      type(editor, "/he");
      expect(slashTriggerAt(editor)).toMatchObject({ query: "he" });

      // Mid-text: the same slash is a slash.
      caret(editor, 1, 7);
      type(editor, "/");
      expect(slashTriggerAt(editor)).toBeNull();
      expect(getBlocks(ydoc)[1]?.text).toBe("already/ written");
    } finally {
      unmount();
    }
  });

  it("closes when the query stops matching, and when a space is typed", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/zzz");
      expect(filterBlockMenu(slashTriggerAt(editor)?.query ?? "")).toEqual([]);

      caret(editor, 0, 0);
      act(() => {
        editor.commands.setContent("");
      });
      type(editor, "/a b");
      expect(slashTriggerAt(editor)).toBeNull();
    } finally {
      unmount();
    }
  });
});

describe("the slash menu", () => {
  it("filters as you type, converts on Enter, and keeps the block id", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, entryLabels, press, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/");
      expect(entryLabels()).toHaveLength(BLOCK_MENU_ENTRIES.length);

      type(editor, "he");
      expect(entryLabels()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);

      endUndoStep(editor);
      press("ArrowDown");
      press("Enter");

      // The document: one block, the same block, now a heading — and no slash
      // anywhere in the saved text.
      const blocks = getBlocks(ydoc);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ id: ids[0], type: "heading", level: 2 });
      expect(blocks[0]?.text).toBe("");
      expect(soundIds(ydoc)).toEqual([ids[0]]);
      expect(query(".ub-blockmenu")).toBeNull();

      // One gesture, one undo step: the block is a paragraph holding "/he"
      // again, not a heading holding it.
      act(() => {
        expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      });
      expect(getBlocks(ydoc)[0]).toMatchObject({
        id: ids[0],
        type: "paragraph",
        text: "/he",
      });
    } finally {
      unmount();
    }
  });

  it("leaves the slash as text when Esc dismisses it", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/co");
      expect(query(".ub-blockmenu")).not.toBeNull();

      press("Escape");
      expect(query(".ub-blockmenu")).toBeNull();
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "paragraph", text: "/co" });

      // Dismissed for this session only: typing on keeps the menu shut…
      type(editor, "de");
      expect(query(".ub-blockmenu")).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("/code");

      // …and clearing the block opens it again on the next slash.
      act(() => {
        editor.commands.setContent("");
      });
      caret(editor, 0, 0);
      type(editor, "/");
      expect(query(".ub-blockmenu")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("opens on typing, not on the caret landing in a block that reads like one", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "/co" }]);
    const { editor, query, unmount } = mountMenu(ydoc);
    try {
      // A paragraph that happens to start with a slash is prose. Clicking at
      // the end of it must not pop a menu nobody asked for.
      caret(editor, 0, 3);
      expect(query(".ub-blockmenu")).toBeNull();

      // Typing is the gesture that means "menu".
      type(editor, "d");
      expect(query(".ub-blockmenu")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("gives Enter back to the editor once nothing matches", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, query, press, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/nope");
      expect(query(".ub-blockmenu")).toBeNull();

      // Nothing intercepts the key, so ProseMirror splits the block.
      press("Enter");
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["/nope", ""]);
      soundIds(ydoc);
    } finally {
      unmount();
    }
  });
});

describe("the gutter menu", () => {
  /** Hover a block, then click the `+` its gutter reveals. */
  function openGutterMenu(mounted: Mounted, index: number): void {
    const block = mounted.editor.view.dom.children[index];
    if (block === undefined) throw new Error(`no block ${index}`);
    act(() => {
      block.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    const button = mounted.query<HTMLButtonElement>(".ub-gutter-add-on");
    if (button === null) throw new Error("the gutter button stayed hidden");
    act(() => button.click());
  }

  function pick(mounted: Mounted, label: string): void {
    const entry = [
      ...mounted.frame.querySelectorAll<HTMLButtonElement>(".ub-blockmenu-entry"),
    ].find((node) => node.textContent?.startsWith(label) === true);
    if (entry === undefined) throw new Error(`no entry ${label}`);
    act(() => entry.click());
  }

  it("stays hidden until a block is hovered", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc);
    try {
      // Mounted from the start — revealing it is a class change, never a
      // reflow — but not offered to the pointer or the tab order.
      expect(mounted.query(".ub-gutter-add")).not.toBeNull();
      expect(mounted.query(".ub-gutter-add-on")).toBeNull();
      expect(mounted.query(".ub-blockmenu")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("inserts an empty block below the hovered one, with the caret in it", () => {
    const { ydoc, ids } = docWith([
      { type: "heading", text: "Title" },
      { type: "paragraph", text: "Body" },
    ]);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      expect(mounted.entryLabels()).toHaveLength(BLOCK_MENU_ENTRIES.length);

      pick(mounted, "Code");

      const blocks = getBlocks(ydoc);
      expect(blocks.map((block) => block.type)).toEqual([
        "heading",
        "code",
        "paragraph",
      ]);
      expect(blocks.map((block) => block.text)).toEqual(["Title", "", "Body"]);
      // The old blocks keep their ids; the new one gets one of its own.
      const after = soundIds(ydoc);
      expect([after[0], after[2]]).toEqual(ids);
      expect(mounted.query(".ub-blockmenu")).toBeNull();

      // The caret is inside the new block, so the reader can just type.
      const { $head } = mounted.editor.state.selection;
      expect($head.depth).toBe(1);
      expect($head.parent.type.name).toBe("code");

      // One undo step, and the document is back where it started.
      act(() => {
        expect(mounted.editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      });
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual(ids);
    } finally {
      mounted.unmount();
    }
  });

  it("works on the last block of a document", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "Only" }]);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      pick(mounted, "Heading 3");

      expect(getBlocks(ydoc).map((block) => [block.type, block.level])).toEqual([
        ["paragraph", undefined],
        ["heading", 3],
      ]);
      soundIds(ydoc);
    } finally {
      mounted.unmount();
    }
  });

  it("filters from its own field, and Esc closes it without touching the doc", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "Only" }]);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      const field = mounted.query<HTMLInputElement>(".ub-blockmenu-search");
      if (field === null) throw new Error("no search field");

      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(field, "mer");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(mounted.entryLabels()).toEqual(["Mermaid"]);

      act(() => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(mounted.query(".ub-blockmenu")).toBeNull();
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual(ids);
    } finally {
      mounted.unmount();
    }
  });
});

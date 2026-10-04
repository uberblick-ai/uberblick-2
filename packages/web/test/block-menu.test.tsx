/**
 * The block-insertion menu: the slash path and the gutter path.
 *
 * What is worth defending here is the document, not the pixels. Four contracts:
 *
 * 1. **The slash trigger is exact.** It opens on this reader typing into an
 *    empty paragraph and nowhere else — a slash typed mid-sentence is a slash, a
 *    menu that opened there would eat the next Enter, and a menu that opened on
 *    a *peer's* keystroke would appear in the middle of someone else's sentence.
 * 2. **Converting keeps the block.** The block id survives the re-type (it is
 *    the same block, so every reference to it stays valid), the typed `/query`
 *    never reaches the saved text, and the whole gesture is one undo step.
 * 3. **Inserting makes exactly one new block**, below the one that was hovered,
 *    with an id of its own and the caret inside it.
 * 4. **Neither operation acts on a block that has moved or gone.** Both name
 *    their block by id and re-resolve it against live state; a concurrent delete
 *    makes the menu refuse, never edit whichever block took its place.
 *
 * Everything is read back out of a real Y.Doc through the schema package: the
 * document is the deliverable, the menu is just how a reader asks for it. The
 * concurrency tests use a second replica wired the way the hub wires two
 * clients, so a peer's edit arrives as the real thing — a remote transaction —
 * rather than as a local edit in disguise.
 *
 * Layout is not asserted — jsdom has none. The gutter's "reveal without moving
 * the prose" claim is checked in the browser (`e2e/block-menu.spec.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import {
  appendBlock,
  deleteBlock,
  editBlock,
  getBlocks,
  initDoc,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import {
  BLOCK_MENU_ENTRIES,
  convertBlockAtTrigger,
  filterBlockMenu,
  insertBlockBelow,
  slashTriggerAt,
} from "../src/editor/block-menu.js";
import type { SlashTrigger } from "../src/editor/block-menu.js";
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
  /**
   * A key, taken the way the browser delivers it: from inside the prose.
   * Returns the event, whose `defaultPrevented` says whether the menu claimed
   * it or let it through to ProseMirror.
   */
  press: (key: string, init?: KeyboardEventInit) => KeyboardEvent;
  unmountMenu: () => void;
  unmount: () => void;
}

/**
 * An editor with the menu mounted over it, the way `EditorPane` wires them.
 *
 * The React root gets a container beside the editor host: rendering into the
 * frame itself would have React clear the frame's children and detach the editor.
 * The card is a React portal, so queries also include document.body.
 */
function mountMenu(ydoc: Y.Doc, initiallyFocused = false): Mounted {
  const { editor, element } = mountEditor(ydoc);
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  frame.appendChild(element);
  const container = document.createElement("div");
  frame.appendChild(container);
  const root = createRoot(container);
  act(() => {
    if (initiallyFocused) editor.view.focus();
    root.render(<BlockMenu editor={editor} host={{ current: frame }} />);
  });

  const query = <T extends Element>(selector: string): T | null =>
    document.body.querySelector<T>(selector);
  let menuMounted = true;
  const unmountMenu = (): void => {
    if (!menuMounted) return;
    act(() => root.unmount());
    menuMounted = false;
  };
  return {
    editor,
    ydoc,
    frame,
    query,
    entryLabels: () =>
      [...document.body.querySelectorAll('[role="option"]')].map(
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
 * A second replica, wired the way the hub wires two clients. An edit made on it
 * reaches the editor as a *remote* transaction — which is the only way to test
 * what the menu does about one.
 */
function peerOf(local: Y.Doc): Y.Doc {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return remote;
}

/** A peer's edit, inside `act` because the editor re-renders the menu on it. */
function fromPeer(edit: () => void): void {
  act(edit);
}

describe("the registry", () => {
  it("offers the whole palette and nothing else", () => {
    expect(BLOCK_MENU_ENTRIES.map((entry) => entry.label)).toEqual([
      "Paragraph",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Quote",
      "Bullet list",
      "Numbered list",
      "Code",
      "Table",
      "Mermaid",
      "Terminal demo",
    ]);
  });

  /**
   * A `listbox` owns options and nothing else. The group headings are for the
   * eye scanning the column, so they are presentational — announced as children
   * of the list they would be a broken list rather than extra context.
   */
  it("renders a listbox whose every announced child is an option", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/");
      const list = query('[role="listbox"]');
      if (list === null) throw new Error("no list");
      expect(list.getAttribute("role")).toBe("listbox");

      const announced = [...list.children].filter(
        (child) => child.getAttribute("role") !== "presentation",
      );
      expect(announced).not.toHaveLength(0);
      expect(
        announced.every((child) => child.getAttribute("role") === "option"),
      ).toBe(true);
      expect(announced).toHaveLength(BLOCK_MENU_ENTRIES.length);
    } finally {
      unmount();
    }
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
    expect(labels("console")).toEqual(["Terminal demo"]);
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
  it("identifies the highlighted option, wrapping at both ends, until the menu closes", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, query, press, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/");
      const list = query('[role="listbox"]');
      if (list === null) throw new Error("no list");
      const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
      expect(options.every((option) => option.id !== "")).toBe(true);
      expect(editor.view.dom.getAttribute("aria-controls")).toBe(list.id);
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[0]?.id,
      );
      // Up from the first wraps to the last; Down from the last wraps back.
      press("ArrowUp");
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options.at(-1)?.id,
      );
      expect(options.at(-1)?.getAttribute("aria-selected")).toBe("true");
      press("ArrowDown");
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[0]?.id,
      );
      expect(options[0]?.getAttribute("aria-selected")).toBe("true");

      press("ArrowDown");
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[1]?.id,
      );
      press("ArrowUp");
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[0]?.id,
      );
      act(() => {
        options[2]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(
        options[2]?.id,
      );
      expect(options[2]?.getAttribute("aria-selected")).toBe("true");

      press("Escape");
      expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);
      expect(editor.view.dom.hasAttribute("aria-controls")).toBe(false);

      // Reopen the same query after a non-first selection: the previous menu's
      // position must not become this menu's initial selection.
      act(() => {
        editor.commands.setContent("");
      });
      caret(editor, 0, 0);
      type(editor, "/");
      const first = query<HTMLElement>('[role="option"]');
      expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(first?.id);
      expect(first?.getAttribute("aria-selected")).toBe("true");
    } finally {
      unmount();
    }
  });

  it("removes its keys and active descendant when the menu unmounts", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, unmountMenu, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");
      expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(true);

      unmountMenu();
      expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);
      expect(editor.view.dom.hasAttribute("aria-controls")).toBe(false);
      press("Enter");
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "/he"],
        ["paragraph", ""],
      ]);
    } finally {
      unmount();
    }
  });

  it("filters as you type, converts on Enter, and keeps the block id", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, entryLabels, press, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/");
      expect(entryLabels()).toHaveLength(BLOCK_MENU_ENTRIES.length);

      type(editor, "he");
      expect(entryLabels()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);

      // No pause is arranged: this is the real keyboard path, typed and picked
      // inside the UndoManager's half-second capture window. The boundary that
      // keeps the conversion its own undo step is the command's job, not the
      // test's — a test that called `stopCapturing` itself would be testing
      // nothing but its own arrangement (#105 review).
      press("ArrowDown");
      press("Enter");

      // The document: one block, the same block, now a heading — and no slash
      // anywhere in the saved text.
      const blocks = getBlocks(ydoc);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ id: ids[0], type: "heading", level: 2 });
      expect(blocks[0]?.text).toBe("");
      expect(soundIds(ydoc)).toEqual([ids[0]]);
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();

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
      expect(query('[data-slot="caret-menu-content"]')).not.toBeNull();

      press("Escape");
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "paragraph", text: "/co" });

      // Dismissed for this session only: typing on keeps the menu shut…
      type(editor, "de");
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("/code");

      // …and clearing the block opens it again on the next slash.
      act(() => {
        editor.commands.setContent("");
      });
      caret(editor, 0, 0);
      type(editor, "/");
      expect(query('[data-slot="caret-menu-content"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  /**
   * A paragraph *stored* as `/co` is prose — someone wrote it, and it has been
   * sitting in the document ever since. Neither putting the caret in it nor
   * carrying on typing in it is a request for a menu; only turning an empty
   * paragraph into a slash query is.
   */
  it("stays shut in a block that was already prose, however it is edited", () => {
    const { ydoc } = docWith([
      { type: "paragraph", text: "/co" },
      { type: "paragraph", text: "" },
    ]);
    const { editor, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 3);
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();

      // Typing on in it does not open one either: the block was not empty
      // before this keystroke, so the slash is text somebody wrote.
      type(editor, "d");
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("/cod");

      // The empty block below is where a slash *is* a command.
      caret(editor, 1, 0);
      type(editor, "/co");
      expect(query('[data-slot="caret-menu-content"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  /**
   * The menu is this reader's, and only this reader's. A peer typing into the
   * block the caret happens to sit in must not open one — that is a menu popping
   * up on someone else's keystroke, over a document the reader was reading.
   * Undo and paste are the same kind of "the document changed but nobody asked
   * for a menu" event, so they are pinned beside it.
   */
  it("never opens on a peer's edit, an undo, or a paste", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "/co" }]);
    const peer = peerOf(ydoc);
    const { editor, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 3);

      // A peer extends the very block the caret is in.
      fromPeer(() => {
        editBlock(peer, ids[0] ?? "", "/co", "/cod");
      });
      expect(getBlocks(ydoc)[0]?.text).toBe("/cod");
      expect(slashTriggerAt(editor)).toMatchObject({ query: "cod" });
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();

      // A paste that happens to be a slash command is content, not a command.
      act(() => {
        const { state } = editor;
        editor.view.dispatch(
          state.tr.insertText("e", state.selection.from).setMeta("uiEvent", "paste"),
        );
      });
      expect(getBlocks(ydoc)[0]?.text).toBe("/code");
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();

      // And an undo that restores a slash-looking block is not a request either.
      act(() => {
        editor.commands.keyboardShortcut("Mod-z");
      });
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
    } finally {
      unmount();
      peer.destroy();
    }
  });

  it("leaves composing Enter to ProseMirror", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");
      expect(query('[role="listbox"]')).not.toBeNull();

      act(() => {
        editor.view.dom.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
      });
      const enter = press("Enter", { isComposing: true });
      expect(enter.defaultPrevented).toBe(false);
      expect(getBlocks(ydoc)).toEqual([
        expect.objectContaining({ id: ids[0], type: "paragraph", text: "/he" }),
      ]);
      expect(query('[role="listbox"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  /**
   * The hazard a stale position hides: the block the menu was opened over is
   * deleted by a peer, and the saved number now points at its *successor*.
   * Acting on it would delete that block's content while looking, to the reader,
   * like the conversion worked.
   */
  it("refuses to convert when the trigger's block is gone", () => {
    const { ydoc, ids } = docWith([
      { type: "paragraph", text: "" },
      { type: "paragraph", text: "a neighbour with content" },
    ]);
    const peer = peerOf(ydoc);
    const { editor, query, press, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");
      const trigger = slashTriggerAt(editor);
      expect(trigger).not.toBeNull();
      expect(query('[data-slot="caret-menu-content"]')).not.toBeNull();

      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });

      // The session went with the block, so the menu is closed…
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
      // …and the command refuses the trigger it was holding, rather than
      // deleting the content of whatever now sits at that position.
      expect(
        convertBlockAtTrigger(
          editor,
          trigger as SlashTrigger,
          BLOCK_MENU_ENTRIES[1] as (typeof BLOCK_MENU_ENTRIES)[number],
        ),
      ).toBe(false);
      // Enter is the editor's again, and it does not convert anything either.
      press("Enter");
      const blocks = getBlocks(ydoc);
      expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
      expect(blocks[0]).toMatchObject({
        id: ids[1],
        text: "a neighbour with content",
      });
      soundIds(ydoc);
    } finally {
      unmount();
      peer.destroy();
    }
  });

  it("gives Enter back to the editor once nothing matches", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, query, press, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/nope");
      expect(query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);
      expect(editor.view.dom.hasAttribute("aria-controls")).toBe(false);

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
  /** Move the pointer over a block, the way the gutter button is revealed. */
  function hoverBlock(mounted: Mounted, index: number): void {
    const block = mounted.editor.view.dom.children[index];
    if (block === undefined) throw new Error(`no block ${index}`);
    act(() => {
      block.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    });
  }

  /** Hover a block, then click the `+` its gutter reveals. */
  function openGutterMenu(mounted: Mounted, index: number): void {
    hoverBlock(mounted, index);
    const button = mounted.query<HTMLButtonElement>('[aria-label="Insert block below"][aria-hidden="false"]');
    if (button === null) throw new Error("the gutter button stayed hidden");
    act(() => button.click());
  }

  function pick(mounted: Mounted, label: string): void {
    const entry = [
      ...mounted.frame.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((node) => node.getAttribute("aria-label") === label);
    if (entry === undefined) throw new Error(`no entry ${label}`);
    act(() => entry.click());
  }

  /** Pointer identity comes from the event, including on a mixed-input iPad. */
  function touchCaret(mounted: Mounted, index: number): void {
    const block = mounted.editor.view.dom.children[index];
    if (block === undefined) throw new Error(`no block ${index}`);
    act(() => {
      block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      mounted.editor.view.focus();
    });
    caret(mounted.editor, index, 0);
  }

  function visibleButton(mounted: Mounted): HTMLButtonElement | null {
    return mounted.query('[aria-label="Insert block below"][aria-hidden="false"]');
  }

  it("offers an existing caret on a coarse pointer before the first touch and lets mouse hover take over", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc, true);
    try {
      expect(visibleButton(mounted)).not.toBeNull();

      // The same iPad can switch to its trackpad: after a real mouse move an
      // edit drops the hover hint rather than following the caret as touch does.
      hoverBlock(mounted, 0);
      act(() => {
        mounted.editor.commands.insertContentAt(1, "x");
      });
      expect(visibleButton(mounted)).toBeNull();
      hoverBlock(mounted, 0);
      expect(visibleButton(mounted)).not.toBeNull();
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("follows a touch caret and inserts below its current block after an edit", () => {
    const { ydoc, ids } = docWith([
      { type: "paragraph", text: "First" },
      { type: "paragraph", text: "Second" },
    ]);
    const peer = peerOf(ydoc);
    const mounted = mountMenu(ydoc);
    try {
      touchCaret(mounted, 0);
      expect(visibleButton(mounted)).not.toBeNull();
      caret(mounted.editor, 1, 2);
      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });
      const button = visibleButton(mounted);
      if (button === null) throw new Error("the touch caret lost its gutter button");
      act(() => button.click());
      pick(mounted, "Code");

      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "Second"], ["code", ""],
      ]);
      expect(visibleButton(mounted)).not.toBeNull();
      soundIds(ydoc);
    } finally {
      mounted.unmount();
      peer.destroy();
    }
  });

  it("hides for a touch range or absent caret and ignores compatibility mouse events", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc);
    try {
      touchCaret(mounted, 0);
      expect(visibleButton(mounted)).not.toBeNull();
      act(() => {
        mounted.editor.commands.setTextSelection({ from: 1, to: 4 });
        mounted.editor.view.dom.firstElementChild?.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true }),
        );
      });
      expect(visibleButton(mounted)).toBeNull();

      caret(mounted.editor, 0, 0);
      expect(visibleButton(mounted)).not.toBeNull();
      act(() => mounted.editor.view.dom.blur());
      expect(visibleButton(mounted)).toBeNull();

      // A real trackpad move still reveals the hovered block after touch.
      hoverBlock(mounted, 0);
      expect(visibleButton(mounted)).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("keeps the touch target through blur and pointerup until its delayed native click", async () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc);
    try {
      touchCaret(mounted, 0);
      const button = visibleButton(mounted);
      if (button === null) throw new Error("no touch button");
      await act(async () => {
        button.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, pointerType: "touch",
        }));
        mounted.editor.view.dom.blur();
        button.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true, pointerType: "touch",
        }));
        // iOS can deliver the compatibility click in a later task. Losing
        // focus or reaching the next task must not remove its touch target.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(visibleButton(mounted)).toBe(button);
      act(() => button.click());
      expect(mounted.query('[role="combobox"][aria-label="Search blocks"]')).not.toBeNull();
      pick(mounted, "Mermaid");
      expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph", "mermaid"]);
    } finally {
      mounted.unmount();
    }
  });

  it("stays hidden until a block is hovered", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc);
    try {
      // Mounted from the start — revealing it is a class change, never a
      // reflow — but not offered to the pointer or the tab order.
      expect(mounted.query('[aria-label="Insert block below"]')).not.toBeNull();
      expect(mounted.query('[aria-label="Insert block below"][aria-hidden="false"]')).toBeNull();
      expect(mounted.query('[data-slot="caret-menu-content"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * A hovered button is a hint about a document that is still being edited, and
   * keeping it in place through every transaction costs a lookup and two layout
   * reads per keystroke — local or remote — for as long as the pointer rests
   * anywhere over the prose. It is not worth that: an edit hides it, and the
   * next pointer move puts it back. Safety does not depend on this, because the
   * insert re-resolves its block by id when it runs.
   */
  it("hides the hovered button on an edit, and shows it again on the next move", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "First" }]);
    const mounted = mountMenu(ydoc);
    try {
      hoverBlock(mounted, 0);
      expect(mounted.query('[aria-label="Insert block below"][aria-hidden="false"]')).not.toBeNull();

      act(() => {
        mounted.editor.commands.insertContentAt(1, "x");
      });
      expect(mounted.query('[aria-label="Insert block below"][aria-hidden="false"]')).toBeNull();

      hoverBlock(mounted, 0);
      expect(mounted.query('[aria-label="Insert block below"][aria-hidden="false"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * The gutter names its block by id too. A peer deleting the block the menu was
   * opened over must close it — an open menu aimed at a block that no longer
   * exists would insert relative to whatever moved into its place.
   */
  it("closes when a peer deletes the block it was opened over", () => {
    const { ydoc, ids } = docWith([
      { type: "paragraph", text: "First" },
      { type: "paragraph", text: "Second" },
    ]);
    const peer = peerOf(ydoc);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      expect(mounted.query('[data-slot="caret-menu-content"]')).not.toBeNull();

      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });

      expect(mounted.query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(mounted.query('[aria-label="Insert block below"][aria-hidden="false"]')).toBeNull();
      // The surviving block is untouched: nothing was inserted anywhere.
      expect(getBlocks(ydoc).map((block) => [block.id, block.text])).toEqual([
        [ids[1], "Second"],
      ]);
      // And the command itself refuses the vanished block rather than
      // inserting relative to whatever took its place.
      expect(
        insertBlockBelow(
          mounted.editor,
          ids[0] ?? "",
          BLOCK_MENU_ENTRIES[0] as (typeof BLOCK_MENU_ENTRIES)[number],
        ),
      ).toBe(false);
      expect(getBlocks(ydoc)).toHaveLength(1);
    } finally {
      mounted.unmount();
      peer.destroy();
    }
  });

  it("inserts below the block it was opened over, even after one moves above it", () => {
    const { ydoc, ids } = docWith([
      { type: "paragraph", text: "First" },
      { type: "paragraph", text: "Second" },
    ]);
    const peer = peerOf(ydoc);
    const mounted = mountMenu(ydoc);
    try {
      // The menu is opened over "Second"…
      openGutterMenu(mounted, 1);
      // …and then a peer deletes the block above it, moving every position
      // after it. A remembered position would now name the wrong block.
      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });
      expect(mounted.query('[data-slot="caret-menu-content"]')).not.toBeNull();

      pick(mounted, "Mermaid");

      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "Second"],
        ["mermaid", ""],
      ]);
      soundIds(ydoc);
    } finally {
      mounted.unmount();
      peer.destroy();
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
      expect(mounted.query('[data-slot="caret-menu-content"]')).toBeNull();

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

  /**
   * A `code` block is rendered by a NodeView whose root holds chrome (the copy
   * button, #103) outside the content — so the pointer resolves to a block whose
   * DOM is not simply its text. The gutter has to find it like any other.
   */
  it("resolves a block rendered by a node view", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "menu-doc", title: "Menu" });
    appendBlock(ydoc, { type: "paragraph", text: "Above" });
    const codeId = appendBlock(ydoc, {
      type: "code",
      text: "const x = 1;",
      language: "ts",
    });
    appendBlock(ydoc, { type: "paragraph", text: "Below" });
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 1);
      pick(mounted, "Mermaid");

      // Inserted below the code block, not below one of its neighbours.
      const blocks = getBlocks(ydoc);
      expect(blocks.map((block) => block.type)).toEqual([
        "paragraph",
        "code",
        "mermaid",
        "paragraph",
      ]);
      expect(blocks[1]?.id).toBe(codeId);
      soundIds(ydoc);
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
      const field = mounted.query<HTMLInputElement>('[role="combobox"]');
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
      expect(mounted.query('[data-slot="caret-menu-content"]')).toBeNull();
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual(ids);
    } finally {
      mounted.unmount();
    }
  });

  it("identifies the highlighted option from its focused search field", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "Only" }]);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      const field = mounted.query<HTMLInputElement>('[role="combobox"]');
      const list = mounted.query('[role="listbox"]');
      if (field === null || list === null) throw new Error("no search or list");
      const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(document.activeElement).toBe(field);
      expect(field.getAttribute("aria-controls")).toBe(list.id);
      expect(field.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
      act(() => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
      act(() => {
        options[2]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      expect(field.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
      expect(mounted.editor.view.dom.hasAttribute("aria-activedescendant")).toBe(
        false,
      );

      // Filtering replaces the list and resets the pointer's remembered index.
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "he");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const filteredFirst = mounted.query<HTMLElement>('[role="option"]');
      expect(field.getAttribute("aria-activedescendant")).toBe(filteredFirst?.id);
      expect(filteredFirst?.getAttribute("aria-selected")).toBe("true");

      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "nope");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field.hasAttribute("aria-activedescendant")).toBe(false);
      expect(field.hasAttribute("aria-controls")).toBe(false);
    } finally {
      mounted.unmount();
    }
  });

  it("leaves composing Enter in the search field to the input method", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "Only" }]);
    const mounted = mountMenu(ydoc);
    try {
      openGutterMenu(mounted, 0);
      const field = mounted.query<HTMLInputElement>('[role="combobox"]');
      if (field === null) throw new Error("no search");
      const enter = new KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true, isComposing: true,
      });
      act(() => field.dispatchEvent(enter));
      expect(enter.defaultPrevented).toBe(false);
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual(ids);
      expect(mounted.query('[role="listbox"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});

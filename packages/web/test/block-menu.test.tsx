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

import { beforeEach, describe, expect, it } from "vitest";
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
  /** An input method finishing a composition in the prose. */
  endComposition: () => void;
  unmount: () => void;
}

/**
 * An editor with the menu mounted over it, the way `EditorPane` wires them.
 *
 * The shape matters, not just the props: the frame stands in for
 * `.ub-editor-frame` and has to be a real ancestor of the ProseMirror DOM,
 * because that is how the menu hears keys (capture phase) and compositions
 * (bubbling) from the prose. So the React root gets a container of its own
 * beside the editor host — rendering into the frame itself would have React
 * clear the frame's children and quietly detach the editor from it.
 */
function mountMenu(ydoc: Y.Doc): Mounted {
  const { editor, element } = mountEditor(ydoc);
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  frame.appendChild(element);
  const container = document.createElement("div");
  frame.appendChild(container);
  const root = createRoot(container);
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
    endComposition: () => {
      act(() => {
        editor.view.dom.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "へ" }),
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
      "Mermaid",
    ]);
  });

  /**
   * A `listbox` owns options and nothing else. The group headings are for the
   * eye scanning the column, so they are presentational — announced as children
   * of the list they would be a broken list rather than extra context.
   */
  it("renders a listbox whose every announced child is an option", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, frame, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/");
      const list = frame.querySelector(".ub-blockmenu-list");
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
      expect(query(".ub-blockmenu")).toBeNull();

      // Typing on in it does not open one either: the block was not empty
      // before this keystroke, so the slash is text somebody wrote.
      type(editor, "d");
      expect(query(".ub-blockmenu")).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("/cod");

      // The empty block below is where a slash *is* a command.
      caret(editor, 1, 0);
      type(editor, "/co");
      expect(query(".ub-blockmenu")).not.toBeNull();
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
      expect(query(".ub-blockmenu")).toBeNull();

      // A paste that happens to be a slash command is content, not a command.
      act(() => {
        const { state } = editor;
        editor.view.dispatch(
          state.tr.insertText("e", state.selection.from).setMeta("uiEvent", "paste"),
        );
      });
      expect(getBlocks(ydoc)[0]?.text).toBe("/code");
      expect(query(".ub-blockmenu")).toBeNull();

      // And an undo that restores a slash-looking block is not a request either.
      act(() => {
        editor.commands.keyboardShortcut("Mod-z");
      });
      expect(query(".ub-blockmenu")).toBeNull();
    } finally {
      unmount();
      peer.destroy();
    }
  });

  /**
   * Typing Japanese, Chinese or Korean runs Enter and the arrows through the
   * IME's candidate list first. A menu that took those keys would make the
   * composition unfinishable inside a slash session — so a composing keystroke
   * is not the menu's to take, even while it is open.
   */
  it("leaves composing keystrokes to the input method", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, query, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");
      expect(query(".ub-blockmenu")).not.toBeNull();

      // The menu does not take it: nothing is converted, and the key travels
      // on past the menu to the editor — which is what a real IME needs, and
      // what jsdom shows here as ProseMirror's ordinary Enter (a browser's
      // ProseMirror would ignore it too, being mid-composition).
      press("Enter", { isComposing: true });
      expect(getBlocks(ydoc).some((block) => block.type === "heading")).toBe(false);
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["/he", ""]);
      expect(getBlocks(ydoc)[0]).toMatchObject({ id: ids[0], type: "paragraph" });

      // The same key, with nothing composing, is the menu's.
      type(editor, "/he");
      press("Enter");
      expect(getBlocks(ydoc)[1]).toMatchObject({ type: "heading", text: "" });
    } finally {
      unmount();
    }
  });

  /**
   * Safari's ordering, which no flag on the event describes: `compositionend`
   * arrives *before* the Enter that committed the candidate, and that Enter says
   * `isComposing: false` with ProseMirror's own flag already cleared. Taking it
   * would convert the block a reader was still typing into.
   *
   * The browser gate is ProseMirror's own (`/Apple Computer/` on the vendor
   * string), and jsdom presents exactly that — asserted here, so a future jsdom
   * that stops doing so fails loudly instead of quietly retiring this case.
   * What the two orderings actually turn on is the sequence below.
   */
  it("leaves an unconfirmed composition's next key to the editor", () => {
    expect(navigator.vendor).toMatch(/Apple Computer/);
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, endComposition, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");

      // compositionend with no commit key before it: the commit is still owed,
      // and it will arrive wearing no mark of one.
      endComposition();
      press("Enter");
      expect(getBlocks(ydoc).some((block) => block.type === "heading")).toBe(false);
      expect(getBlocks(ydoc)[0]).toMatchObject({ id: ids[0], type: "paragraph" });

      // The memory is one-shot: the *next* Enter is the menu's again. (The
      // first one reached ProseMirror and split the block, so the session is in
      // the second one now.)
      type(editor, "/he");
      press("Enter");
      expect(getBlocks(ydoc)[1]).toMatchObject({ type: "heading", text: "" });
    } finally {
      unmount();
    }
  });

  /**
   * The other ordering, and the reason the tail has to be scoped: Chrome and
   * Firefox deliver the committing Enter *before* `compositionend`. The guard
   * has already declined that Enter as composing, so nothing is owed — and a
   * reader who then presses Enter to pick an entry must get their entry, not a
   * split paragraph.
   */
  it("keeps the next key when the composition's commit already came through", () => {
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const { editor, press, endComposition, unmount } = mountMenu(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "/he");

      // The Chrome/Firefox sequence: the committing Enter arrives while still
      // composing — declined by the guard — and the composition ends after it.
      // (In a browser ProseMirror ignores that keydown as well; jsdom has no
      // composition to ignore, so it splits the block, which is harmless here.)
      press("Enter", { isComposing: true });
      endComposition();

      // Straight on to a session and a deliberate Enter, well inside the tail's
      // window. Nothing is owed to the IME, so this Enter is the menu's — an
      // over-armed tail would hand it to ProseMirror and split the paragraph
      // the reader was converting.
      type(editor, "/he");
      press("Enter");
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "/he"],
        ["heading", ""],
      ]);
    } finally {
      unmount();
    }
  });

  /**
   * A composition that ends somewhere else in the frame owes this menu nothing —
   * the tail is scoped to the surface its own session is typed into.
   */
  it("ignores a composition that ended outside the prose", () => {
    const { ydoc, ids } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountMenu(ydoc);
    const { editor, press, unmount } = mounted;
    try {
      caret(editor, 0, 0);
      type(editor, "/he");

      // Some other control inside the frame finishes a composition.
      const elsewhere = document.createElement("input");
      mounted.frame.appendChild(elsewhere);
      act(() => {
        elsewhere.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "へ" }),
        );
      });

      press("Enter");
      expect(getBlocks(ydoc)[0]).toMatchObject({ id: ids[0], type: "heading" });
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
      expect(query(".ub-blockmenu")).not.toBeNull();

      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });

      // The session went with the block, so the menu is closed…
      expect(query(".ub-blockmenu")).toBeNull();
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
  /** Move the pointer over a block, the way the gutter button is revealed. */
  function hoverBlock(mounted: Mounted, index: number): void {
    const block = mounted.editor.view.dom.children[index];
    if (block === undefined) throw new Error(`no block ${index}`);
    act(() => {
      block.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
  }

  /** Hover a block, then click the `+` its gutter reveals. */
  function openGutterMenu(mounted: Mounted, index: number): void {
    hoverBlock(mounted, index);
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
      expect(mounted.query(".ub-gutter-add-on")).not.toBeNull();

      act(() => {
        mounted.editor.commands.insertContentAt(1, "x");
      });
      expect(mounted.query(".ub-gutter-add-on")).toBeNull();

      hoverBlock(mounted, 0);
      expect(mounted.query(".ub-gutter-add-on")).not.toBeNull();
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
      expect(mounted.query(".ub-blockmenu")).not.toBeNull();

      fromPeer(() => {
        deleteBlock(peer, ids[0] ?? "");
      });

      expect(mounted.query(".ub-blockmenu")).toBeNull();
      expect(mounted.query(".ub-gutter-add-on")).toBeNull();
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
      expect(mounted.query(".ub-blockmenu")).not.toBeNull();

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

/**
 * The block-level markdown input rules.
 *
 * Three contracts are worth defending, and they are the whole of this file:
 *
 * 1. **The block survives its own conversion.** `# ` re-types the block it was
 *    typed in — same id, so every annotation anchor and backlink pointing at it
 *    stays valid. This is the invariant a naive `textblockTypeInputRule` breaks,
 *    and the reason this code exists at all.
 * 2. **A `#` in prose is a `#`.** The rule fires on a prefix and nothing else,
 *    and one undo gives back what was typed — which is how a reader writes a
 *    literal `# ` and keeps it.
 * 3. **Every trigger in the registry works, by construction.** The conversions
 *    are driven off `BLOCK_MENU_ENTRIES`, so the test is too: a #59 entry that
 *    fills in `trigger` is covered here without a line being added.
 *
 * Keystrokes go through `handleTextInput` the way prosemirror-view calls it on a
 * keypress, because that is the path the rules live on — an `insertContent` or a
 * dispatched transaction is a different door (an agent's write, a paste, a
 * peer's edit), and the difference is exactly what the last test is about.
 * Everything is read back out of the Y.Doc through the schema package: the
 * document is the deliverable.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, getBlocks, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { BLOCK_MENU_ENTRIES } from "../src/editor/block-menu.js";
import { mountEditor } from "./helpers.js";

/** The entries a reader can type their way to — the input rules' whole subject. */
const TRIGGERS = BLOCK_MENU_ENTRIES.filter((entry) => entry.trigger !== null);

function docWith(texts: string[]): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "rules-doc", title: "Rules" });
  const ids = texts.map((text) => appendBlock(ydoc, { type: "paragraph", text }));
  return { ydoc, ids };
}

/**
 * One keypress, delivered the way prosemirror-view delivers one: offer it to
 * `handleTextInput` first, insert it plainly when nothing claims it. Copied from
 * `editHandlers.keypress` because a test that dispatched an insertion directly
 * would never reach an input rule, and would be testing nothing.
 */
function press(editor: Editor, char: string): void {
  const { view } = editor;
  const { from, to } = view.state.selection;
  const deflt = (): ReturnType<typeof view.state.tr.insertText> =>
    view.state.tr.insertText(char, from, to);
  if (!view.someProp("handleTextInput", (f) => f(view, from, to, char, deflt))) {
    view.dispatch(deflt());
  }
}

/** Type `text` a character at a time, as a reader does. */
function type(editor: Editor, text: string): void {
  for (const char of text) press(editor, char);
}

/** Put the caret `offset` characters into block `index`. */
function caret(editor: Editor, index: number, offset: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos + offset);
}

describe("typing a markdown prefix", () => {
  /**
   * The id assertion is the point. A conversion that produced the right block
   * type under a *new* id would look identical on screen and orphan every
   * reference to the block — see the module comment in editor/input-rules.ts.
   */
  it.each(TRIGGERS)(
    "converts an empty paragraph to $label, keeping the block id",
    (entry) => {
      const { ydoc, ids } = docWith([""]);
      const { editor } = mountEditor(ydoc);
      try {
        caret(editor, 0, 0);
        type(editor, entry.trigger ?? "");

        const blocks = getBlocks(ydoc);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({
          id: ids[0],
          type: entry.type,
          // The prefix is consumed: it was syntax, not text.
          text: "",
          ...(entry.attrs.level === undefined ? {} : { level: entry.attrs.level }),
        });
        // And the caret is in the block that was just made, ready to be typed in.
        expect(editor.state.selection.$head.parent.type.name).toBe(entry.type);
      } finally {
        editor.destroy();
      }
    },
  );

  it("leaves a prefix typed anywhere but the start of the block as text", () => {
    const { ydoc } = docWith(["already written", "later"]);
    const { editor } = mountEditor(ydoc);
    try {
      // At the end of a sentence: a hash is a hash.
      caret(editor, 0, "already written".length);
      type(editor, " # ");
      expect(getBlocks(ydoc)[0]).toMatchObject({
        type: "paragraph",
        text: "already written # ",
      });

      // At the *start* of a block that already holds text, too: the prefix has
      // prose behind it, so the block is not a fresh one.
      caret(editor, 1, 0);
      type(editor, "# ");
      expect(getBlocks(ydoc)[1]).toMatchObject({
        type: "paragraph",
        text: "# later",
      });
    } finally {
      editor.destroy();
    }
  });

  /**
   * How a reader writes a literal `# `: type it, undo once. One step, not two —
   * the conversion is its own undo step, so the typing survives it. Nothing is
   * arranged here: the characters are typed straight through, well inside the
   * UndoManager's half-second capture window, which is the case the boundary in
   * the command exists for (#105 review).
   */
  it("gives the typed prefix back as text on a single undo", () => {
    const { ydoc, ids } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "## ");
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "heading", level: 2 });

      expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      expect(getBlocks(ydoc)[0]).toMatchObject({
        id: ids[0],
        type: "paragraph",
        text: "## ",
      });

      // And it stays text: carrying on typing does not re-fire the rule.
      caret(editor, 0, 3);
      type(editor, "x");
      expect(getBlocks(ydoc)[0]).toMatchObject({
        type: "paragraph",
        text: "## x",
      });
    } finally {
      editor.destroy();
    }
  });

  /**
   * The rules are this reader's keyboard and nothing else. A peer whose edit
   * happens to leave `# ` in a block, and a programmatic write (an agent's
   * `edit_block`, a paste — everything that arrives as a dispatched transaction
   * rather than as typing), must not convert someone's block underneath them.
   */
  it("never fires on a peer's edit or a programmatic write", () => {
    const { ydoc, ids } = docWith(["", ""]);
    // A second replica, wired the way the hub wires two clients, so its edit
    // reaches the editor as the real thing — a remote transaction.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
    ydoc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    const { editor } = mountEditor(ydoc);
    try {
      // A peer leaves the prefix in the block this reader's caret sits in.
      caret(editor, 0, 0);
      editBlock(peer, ids[0] ?? "", "", "# ");
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "paragraph", text: "# " });

      // And a write that goes straight to a transaction — an agent's edit, a
      // paste — is content, not typing.
      caret(editor, 1, 0);
      editor.commands.insertContent("```");
      expect(getBlocks(ydoc)[1]).toMatchObject({ type: "paragraph", text: "```" });
    } finally {
      editor.destroy();
    }
  });
});

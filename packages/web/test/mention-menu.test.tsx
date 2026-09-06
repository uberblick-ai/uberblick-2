/**
 * The `@` picker (#532).
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
 * Everything is read back out of a real Y.Doc through the schema package. The
 * input-method guard itself is pinned in `test/block-menu.test.tsx`, which is
 * the other menu built on it; one case here proves this picker is wired to it.
 * Layout is not asserted — jsdom has none; the caret-anchored gesture end to end
 * is `e2e/doc-link.spec.ts`.
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
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
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
import { MentionMenu } from "../src/ui/MentionMenu.js";
import { mountEditor, snapshotFragment } from "./helpers.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** The document being written in — never offered as a target. */
const DOC = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const HUB = "0189abcd-2222-4333-8444-555566667777";
const BLOCKS = "3f7d1e88-1111-4222-9333-444455556666";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

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
  blocks: Array<{ type: "paragraph" | "code"; text: string }>,
): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "References" });
  const ids = blocks.map((block) =>
    block.type === "code"
      ? appendBlock(ydoc, { type: "code", text: block.text })
      : appendBlock(ydoc, { type: "paragraph", text: block.text }),
  );
  return { ydoc, ids };
}

interface Mounted {
  editor: Editor;
  card: () => Element | null;
  labels: () => string[];
  /** Returns the event, whose `defaultPrevented` says whether the picker took it. */
  press: (key: string, init?: KeyboardEventInit) => KeyboardEvent;
  pick: (label: string) => void;
  unmount: () => void;
}

/** An editor with the picker mounted over it, the way `EditorPane` wires them. */
function mountPicker(ydoc: Y.Doc, context: DocLinkContext): Mounted {
  const { editor, element } = mountEditor(ydoc, { docLinks: context });
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  frame.appendChild(element);
  const container = document.createElement("div");
  frame.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MentionMenu
        editor={editor}
        host={{ current: frame }}
        docLinks={context}
        openDocId={DOC}
      />,
    );
  });

  return {
    editor,
    card: () => frame.querySelector(".ub-mentionmenu"),
    labels: () =>
      [...frame.querySelectorAll(".ub-mentionmenu .ub-blockmenu-label")].map(
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
    pick: (label: string) => {
      const entry = [
        ...frame.querySelectorAll<HTMLButtonElement>(
          ".ub-mentionmenu .ub-blockmenu-entry",
        ),
      ].find((node) => node.textContent === label);
      if (entry === undefined) throw new Error(`no entry ${label}`);
      act(() => entry.click());
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

describe("the picker", () => {
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

  /**
   * `code`, `mermaid` and `table` are source text: the schema gives them no
   * `docLink`, so offering one there would be offering something the block
   * cannot hold.
   */
  it("never opens in a source block", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "code", text: "const a = 1;" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 12);
      type(mounted.editor, " ");
      type(mounted.editor, "@");
      expect(mentionTriggerAt(mounted.editor)).toBeNull();
      expect(mounted.card()).toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe("const a = 1; @");
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
      expect(card?.querySelector(".ub-blockmenu-empty")?.textContent).toBe(
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
   * A click outside means the same thing as Esc, and the card needs its own
   * handler to hear it: an `@` sits inside a sentence, so a click further along
   * that same sentence leaves the trigger valid and would leave the card
   * hanging over prose the reader has moved on from.
   */
  it("closes on a click outside, and not on one inside the card", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hu");
      expect(mounted.card()).not.toBeNull();

      // Reaching for an entry is not dismissing the card that holds it.
      act(() => {
        mounted
          .card()
          ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(mounted.card()).not.toBeNull();

      act(() => {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(mounted.card()).toBeNull();
      expect(delta(ydoc)).toEqual([{ insert: "@hu" }]);

      // Dismissed for this session only, exactly as Esc is.
      type(mounted.editor, "b");
      expect(mounted.card()).toBeNull();
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

  /**
   * Enter commits an input method's candidate before it ever means "this
   * document". The guard itself is `ui/caret-menu.ts`, pinned in
   * `test/block-menu.test.tsx`; what this case defends is that the picker uses
   * it rather than taking every Enter it sees.
   */
  it("leaves composing keystrokes to the input method", () => {
    const { context } = directory();
    const { ydoc } = docWith([{ type: "paragraph", text: "" }]);
    const mounted = mountPicker(ydoc, context);
    try {
      caret(mounted.editor, 0, 0);
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      expect(mounted.card()).not.toBeNull();

      // Not taken: no reference is written, and the key travels on to the
      // editor — which is what a real input method needs, and what jsdom shows
      // here as ProseMirror's ordinary Enter splitting the paragraph.
      mounted.press("Enter", { isComposing: true });
      expect(delta(ydoc)).toEqual([{ insert: "@hub" }]);

      // The same key, with nothing composing, is the picker's. (The session is
      // in the second block now, where that first Enter left the caret.)
      type(mounted.editor, "@");
      type(mounted.editor, "hub");
      mounted.press("Enter");
      expect(snapshotFragment(ydoc)[1]?.delta).toEqual([
        { insert: "The hub", attributes: { docLink: { docId: HUB } } },
      ]);
    } finally {
      mounted.unmount();
    }
  });
});

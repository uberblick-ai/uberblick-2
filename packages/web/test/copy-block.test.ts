/**
 * The code/mermaid copy button (#103).
 *
 * Two things are worth defending. First, what lands on the clipboard is the
 * block's source verbatim — every line, no fence, no trailing decoration.
 * Second, the button is chrome: pressing it must leave the document, the
 * selection and the undo stack exactly as they were, which is the difference
 * between a copy affordance and a way to accidentally edit a shared document.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock } from "@uberblick/schema";
import { codeBlockChrome, sourceBlockView } from "../src/editor/source-chrome.js";
import type { NodeViewRendererProps } from "@tiptap/core";
import { mountEditor, snapshotFragment } from "./helpers.js";

const SHELL = "pnpm install\npnpm -r build\n";
const DIAGRAM = "graph TD;\n  A-->B;";

function documentWithSourceBlocks(): Y.Doc {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "code", text: SHELL, language: "sh" });
  appendBlock(ydoc, { type: "mermaid", text: DIAGRAM });
  return ydoc;
}

/** Replace `navigator.clipboard` with a recorder; returns what was written. */
function stubClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string): Promise<void> => {
        written.push(text);
        return Promise.resolve();
      },
    },
  });
  return written;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("copying a source block", () => {
  it("puts the block's own text on the clipboard and leaves the document alone", async () => {
    const written = stubClipboard();
    const ydoc = documentWithSourceBlocks();
    const before = snapshotFragment(ydoc);
    const { editor, element } = mountEditor(ydoc);

    let transactions = 0;
    editor.on("transaction", () => {
      transactions += 1;
    });

    const buttons = [...element.querySelectorAll<HTMLButtonElement>(".ub-copy")];
    expect(buttons).toHaveLength(2);

    // The caret never moves because the default on *mousedown* is prevented —
    // by click time the browser has already focused and placed it.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    buttons[0]!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    buttons[0]!.click();
    buttons[1]!.click();
    await vi.waitFor(() => expect(written).toHaveLength(2));

    expect(written[0]).toBe(SHELL);
    expect(written[1]).toBe(DIAGRAM);

    // No transaction means no step: nothing for the Yjs UndoManager to record,
    // and no selection change either.
    expect(transactions).toBe(0);
    expect(editor.isFocused).toBe(false);
    expect(snapshotFragment(ydoc)).toEqual(before);
    // The confirmation is the label, in the button's own reserved width.
    await vi.waitFor(() => expect(buttons[0]!.textContent).toBe("copied"));

    editor.destroy();
  });

  /**
   * The chrome hides exactly one thing from ProseMirror: its own label.
   *
   * This is not a detail. A browser rewrites the markup inside a source block
   * on its own — Chrome drops an emptied `<code>` and wraps the next keystroke
   * in a `<font>` — and ProseMirror repairs that only if it is told. An
   * `ignoreMutation` drawn one element too wide swallows the repair signal, and
   * the view then drifts away from the document with no error anywhere: every
   * later keystroke is on screen and in no replica. So the boundary is pinned.
   */
  it("hides the button's own mutations from ProseMirror, and nothing else", () => {
    const ydoc = documentWithSourceBlocks();
    const { editor } = mountEditor(ydoc);
    const view = sourceBlockView(codeBlockChrome)({
      node: editor.state.doc.child(0),
    } as NodeViewRendererProps);
    const button = view.dom.querySelector(".ub-copy")!;

    // Only `target` is read, so a stand-in record is enough to state the rule.
    const changed = (target: Node): MutationRecord =>
      ({ type: "childList", target }) as unknown as MutationRecord;

    expect(view.ignoreMutation!(changed(button))).toBe(true);
    expect(view.ignoreMutation!(changed(view.contentDOM!))).toBe(false);
    expect(view.ignoreMutation!(changed(view.dom))).toBe(false);

    view.destroy!();
    editor.destroy();
  });

  it("falls back to a selection copy where there is no clipboard API", async () => {
    // What a plain-http tailnet host looks like: no secure context, so
    // `navigator.clipboard` is simply not there (REMOTE.md).
    const ydoc = documentWithSourceBlocks();
    const { editor, element } = mountEditor(ydoc);
    let copied: string | null = null;
    const execCommand = vi.fn((command: string) => {
      const scratch = document.activeElement;
      if (command === "copy" && scratch instanceof HTMLTextAreaElement) {
        copied = scratch.value;
      }
      return true;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    // `finally`, because a failing assertion here would otherwise leave the
    // stub on `document` for every test after it in this file — and the next
    // failure would then be somewhere else entirely.
    try {
      element.querySelector<HTMLButtonElement>(".ub-copy")!.click();
      await vi.waitFor(() => expect(execCommand).toHaveBeenCalled());
      expect(copied).toBe(SHELL);
      // The scratch textarea is gone again; it exists only for the selection.
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
      editor.destroy();
    }
  });
});

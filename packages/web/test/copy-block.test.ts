/**
 * The code/mermaid copy button (#103).
 *
 * Two things are worth defending. First, what lands on the clipboard is the
 * block's source verbatim — every line, no fence, no trailing decoration.
 * Second, the button is chrome: pressing it must leave the document, the
 * selection and the undo stack exactly as they were, which is the difference
 * between a copy affordance and a way to accidentally edit a shared document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock } from "@uberblick/schema";
import { codeBlockChrome, sourceBlockView } from "../src/editor/source-chrome.js";
import type { NodeViewRendererProps } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import { mountEditor, snapshotFragment } from "./helpers.js";
import { notifyTransient } from "../src/notifications.js";

vi.mock("../src/notifications.js", () => ({ notifyTransient: vi.fn() }));

beforeEach(() => vi.mocked(notifyTransient).mockClear());

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
    await vi.waitFor(() => expect(notifyTransient).toHaveBeenCalledTimes(2));
    for (const [notice] of vi.mocked(notifyTransient).mock.calls) {
      expect(notice).toEqual({ key: "clipboard", message: "Copied to clipboard", severity: "success" });
    }
    for (const button of buttons) expect(button.textContent).toBe("copy");

    editor.destroy();
  });

  /**
   * The chrome hides only its copy label and language caption from ProseMirror.
   *
   * This is not a detail. A browser rewrites the markup inside a source block
   * on its own — Chrome drops an emptied `<code>` and wraps the next keystroke
   * in a `<font>` — and ProseMirror repairs that only if it is told. An
   * `ignoreMutation` drawn one element too wide swallows the repair signal, and
   * the view then drifts away from the document with no error anywhere: every
   * later keystroke is on screen and in no replica. So the boundary is pinned.
   */
  it("hides only copy and caption mutations and events, preserving source DOM repair", () => {
    const ydoc = documentWithSourceBlocks();
    const { editor } = mountEditor(ydoc);
    const view = sourceBlockView(codeBlockChrome)({
      node: editor.state.doc.child(0),
    } as NodeViewRendererProps);
    const button = view.dom.querySelector(".ub-copy")!;
    const caption = view.dom.querySelector(".ub-code-caption")!;
    const captionText = caption.firstChild!;
    const sourceText = document.createTextNode(SHELL);
    view.contentDOM!.appendChild(sourceText);
    expect(captionText.textContent).toBe("sh");
    expect((caption as HTMLElement).contentEditable).toBe("false");

    // Only `target` is read, so a stand-in record is enough to state the rule.
    const changed = (target: Node): MutationRecord =>
      ({ type: "childList", target }) as unknown as MutationRecord;

    expect(view.ignoreMutation!(changed(button))).toBe(true);
    expect(view.ignoreMutation!(changed(caption))).toBe(true);
    expect(view.ignoreMutation!(changed(captionText))).toBe(true);
    expect(view.ignoreMutation!(changed(view.contentDOM!))).toBe(false);
    expect(view.ignoreMutation!(changed(sourceText))).toBe(false);
    expect(view.ignoreMutation!(changed(view.dom))).toBe(false);

    const event = (target: Node): Event => ({ target }) as unknown as Event;
    expect(view.stopEvent!(event(button))).toBe(true);
    expect(view.stopEvent!(event(captionText))).toBe(true);
    expect(view.stopEvent!(event(view.contentDOM!))).toBe(false);
    expect(view.stopEvent!(event(sourceText))).toBe(false);
    expect(view.stopEvent!(event(view.dom))).toBe(false);

    // An editing engine can drop an emptied <code>. Refuse to update a detached
    // contentDOM so ProseMirror rebuilds it instead of writing invisible text.
    view.contentDOM!.parentNode!.removeChild(view.contentDOM!);
    expect(view.update!(editor.state.doc.child(0), [], DecorationSet.empty)).toBe(false);

    view.destroy?.();
    editor.destroy();
  });

  it.each(["missing", "refused"])("falls back to a selection copy when the clipboard API is %s", async (clipboard) => {
    // What a plain-http tailnet host looks like: no secure context, so
    // `navigator.clipboard` is simply not there (REMOTE.md).
    const ydoc = documentWithSourceBlocks();
    const { editor, element } = mountEditor(ydoc);
    if (clipboard === "refused") {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) },
      });
    }
    editor.commands.setTextSelection({ from: 2, to: 7 });
    const selection = editor.state.selection;
    // jsdom cannot measure a focused ProseMirror selection. Browser coverage
    // checks the editor; here defend the fallback's native focus restoration.
    const origin = document.createElement("input");
    origin.value = "Selected text";
    document.body.appendChild(origin);
    origin.focus();
    origin.setSelectionRange(2, 7);
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
      await vi.waitFor(() => expect(notifyTransient).toHaveBeenCalledWith({
        key: "clipboard", message: "Copied to clipboard", severity: "success",
      }));
      expect(document.activeElement).toBe(origin);
      expect([origin.selectionStart, origin.selectionEnd]).toEqual([2, 7]);
      expect(editor.state.selection.eq(selection)).toBe(true);
      expect(element.querySelector<HTMLButtonElement>(".ub-copy")!.textContent).toBe("copy");
      // The scratch textarea is gone again; it exists only for the selection.
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
      origin.remove();
      editor.destroy();
    }
  });

  it.each([false, "throws"])("reports failure only after both clipboard paths refuse (%s)", async (fallback) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) },
    });
    const execCommand = vi.fn(() => {
      if (fallback === "throws") throw new Error("Copy unavailable");
      return false;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const { editor, element } = mountEditor(documentWithSourceBlocks());
    try {
      element.querySelector<HTMLButtonElement>(".ub-copy")!.click();
      await vi.waitFor(() => expect(notifyTransient).toHaveBeenCalledWith({
        key: "clipboard", message: "Copy failed", severity: "error",
      }));
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(element.querySelector<HTMLButtonElement>(".ub-copy")!.textContent).toBe("copy");
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
      editor.destroy();
    }
  });
});

/**
 * Chrome for the two source-text blocks: a one-click copy button on `code` and
 * `mermaid` (#103).
 *
 * These blocks carry command sequences and diagram source — text people need to
 * take away verbatim. Dragging a selection across a collaboratively edited
 * document to get it is both fiddly and dangerous: a stray keystroke mid-select
 * edits the doc for everyone. So the affordance is a button, and the button
 * lives in the NodeView's chrome rather than in the content:
 *
 * - It is `contenteditable="false"` and its events are stopped before they
 *   reach ProseMirror (`stopEvent`), so clicking it does not focus the editor
 *   or move the caret.
 * - It changes its own label to confirm, which is a DOM mutation inside the
 *   NodeView but outside `contentDOM` — `ignoreMutation` is what stops
 *   ProseMirror reading that back as a document change. Nothing here dispatches
 *   a transaction, so there is no undo step to make either.
 *
 * The text copied is `node.textContent`: the block's own text, joined with
 * nothing, newlines intact. Not markdown, not a fence — the source.
 *
 * {@link sourceEditingPlugin} at the foot is the other half a source block that
 * draws itself needs, and it is here for the same reason: `table` and `mermaid`
 * decide which representation to show by exactly the same rule, and one copy of
 * that rule is one place for it to be wrong.
 */

import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeView } from "@tiptap/pm/view";

/** How long the confirmation stands before the label goes back to "copy". */
const CONFIRM_MS = 1_500;

/**
 * Put `text` on the clipboard, or report that we could not.
 *
 * `navigator.clipboard` exists only in a secure context. Serving the web client
 * over plain http on a tailnet host is a supported deployment (REMOTE.md), and
 * a copy button that is silently dead there is worse than no button, hence the
 * `execCommand` path behind it.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or no transient activation — try the old way.
    }
  }
  return copyViaSelection(text);
}

/**
 * The insecure-context fallback. `execCommand("copy")` copies the *selection*,
 * so it needs a real, selectable element: an off-screen textarea, focused just
 * long enough to be copied out of, with focus handed straight back to whatever
 * had it — which for a click on this button is the editor, caret untouched.
 */
function copyViaSelection(text: string): boolean {
  const previous = document.activeElement;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.readOnly = true;
  // Off-screen rather than hidden: `display: none` cannot hold a selection.
  scratch.style.position = "fixed";
  scratch.style.top = "-9999px";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  let copied = false;
  try {
    // Focus explicitly: `select()` alone leaves the selection on an unfocused
    // element in some engines, and `execCommand` then copies nothing.
    scratch.focus();
    scratch.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  scratch.remove();
  if (previous instanceof HTMLElement) previous.focus();
  return copied;
}

export function copyButton(source: () => string): {
  element: HTMLButtonElement;
  destroy: () => void;
} {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "ub-copy";
  element.contentEditable = "false";
  element.textContent = "copy";
  element.title = "Copy this block's source";
  let revert: ReturnType<typeof setTimeout> | null = null;

  // mousedown, not click: the browser moves focus and the caret on mousedown, so
  // preventing the default there is what keeps the editor untouched. By click
  // time the caret has already moved.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.preventDefault();
    void writeToClipboard(source()).then((copied) => {
      // Both words are six characters, and the button reserves the width for
      // them (styles.css) — the confirmation replaces the label in place.
      element.textContent = copied ? "copied" : "failed";
      if (revert !== null) clearTimeout(revert);
      revert = setTimeout(() => {
        element.textContent = "copy";
        revert = null;
      }, CONFIRM_MS);
    });
  });

  return {
    element,
    destroy: () => {
      if (revert !== null) clearTimeout(revert);
    },
  };
}

/** Mirror one node attribute onto the DOM, or remove it when unset. */
function mirrorAttribute(element: HTMLElement, name: string, value: unknown): void {
  if (typeof value === "string") element.setAttribute(name, value);
  else element.removeAttribute(name);
}

export interface SourceBlockChrome {
  /** The NodeView's root element, matching what `renderHTML` would emit. */
  root: () => HTMLElement;
  /** The element that holds the editable text. */
  content: () => HTMLElement;
  /** Node attributes to mirror onto the root, on create and on every update. */
  sync: (node: PMNode, root: HTMLElement) => void;
}

/**
 * A NodeView for a source-text block: the block as `renderHTML` draws it, plus
 * a copy button.
 */
export function sourceBlockView(chrome: SourceBlockChrome): NodeViewRenderer {
  return ({ node }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    const dom = chrome.root();
    const contentDOM = chrome.content();
    const button = copyButton(() => current.textContent);
    dom.append(button.element, contentDOM);
    chrome.sync(current, dom);

    return {
      dom,
      contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type) return false;
        // The browser's editing engine sometimes rewrites the markup around an
        // emptied inline element — Chrome drops an empty `<code>` and wraps the
        // next keystroke in a `<font>`. Patching the node in place then writes
        // into an element that is no longer in the tree, so hand the whole view
        // back to ProseMirror to rebuild instead.
        if (contentDOM.parentNode !== dom) return false;
        current = updated;
        chrome.sync(current, dom);
        return true;
      },
      // Only the button's own events. A click anywhere else in the block —
      // including the padding around the text — must still place the caret.
      stopEvent: (event: Event): boolean =>
        event.target instanceof Node && button.element.contains(event.target),
      // The label swap, and nothing else. Anything wider than this is a trap:
      // ignoring a mutation ProseMirror needed to see stops it repairing the
      // block's DOM at all, and the view then drifts silently away from the
      // document — every later keystroke lands on screen and nowhere else.
      ignoreMutation: (mutation: { target: Node }): boolean =>
        button.element.contains(mutation.target),
      destroy: button.destroy,
    };
  };
}

/** `<pre class="ub-code" data-language="…"><button …><code>…</code></pre>` */
export const codeBlockChrome: SourceBlockChrome = {
  root: () => {
    const pre = document.createElement("pre");
    pre.className = "ub-code";
    return pre;
  },
  content: () => document.createElement("code"),
  sync: (node, root) => {
    mirrorAttribute(root, "id", node.attrs.id);
    mirrorAttribute(root, "data-language", node.attrs.language);
  },
};

/** `<div class="ub-mermaid" data-block-type="mermaid"><button …><pre>…</pre></div>` */
export const mermaidChrome: SourceBlockChrome = {
  root: () => {
    const div = document.createElement("div");
    div.className = "ub-mermaid";
    div.setAttribute("data-block-type", "mermaid");
    return div;
  },
  content: () => document.createElement("pre"),
  sync: (node, root) => mirrorAttribute(root, "id", node.attrs.id),
};

/* ------------------------------------------------- the block under the caret */

/** The top-level block of type `typeName` the selection is in, or null. */
function selectedBlock(
  state: EditorState,
  typeName: string,
): { pos: number; node: PMNode } | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === typeName
      ? { pos: selection.from, node: selection.node }
      : null;
  }
  const { $head } = selection;
  if ($head.depth !== 1) return null;
  const node = $head.parent;
  return node.type.name === typeName ? { pos: $head.before(1), node } : null;
}

/**
 * Put `className` on the `typeName` block the selection sits in, so the
 * stylesheet can show that block's source and hide its rendering.
 *
 * The two blocks that draw themselves — `table` and `mermaid` — share this, and
 * they share the reason: which representation a reader sees is derived from the
 * selection on every draw rather than remembered, because a mode nobody stores
 * cannot get out of step with the document.
 */
export function sourceEditingPlugin(typeName: string, className: string): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet | null {
        const block = selectedBlock(state, typeName);
        if (block === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(block.pos, block.pos + block.node.nodeSize, {
            class: className,
          }),
        ]);
      },
    },
  });
}

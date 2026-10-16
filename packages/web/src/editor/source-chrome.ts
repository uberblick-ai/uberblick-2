/**
 * Copy verbatim node.textContent, never Markdown fences. Keep chrome outside
 * contentDOM, noneditable and isolated from PM events; copying must move no
 * caret and dispatch no transaction or undo step.
 */

import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeView } from "@tiptap/pm/view";
import { notifyTransient } from "../notifications.js";
import { codeLanguageLabel } from "./syntax-highlighting.js";

/**
 * Try the secure-context Clipboard API, then selection copy for supported plain
 * HTTP deployments or denied transient activation. Report failure explicitly.
 */
export async function writeToClipboard(text: string, fallbackReady?: Promise<void>): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission or activation refusal still permits selection-copy fallback.
    }
  }
  // Modal callers release their focus trap before the selection fallback.
  // Start the native API above while the original user gesture is still active.
  if (fallbackReady !== undefined) await fallbackReady;
  return copyViaSelection(text);
}

/**
 * execCommand copies selection: focus a selectable offscreen textarea and
 * restore the prior focus without disturbing the editor caret.
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
} {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "ub-copy";
  element.contentEditable = "false";
  element.textContent = "Copy";
  element.title = "Copy this block's source";

  // Prevent mousedown: by click time the browser has already moved the caret.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.preventDefault();
    void writeToClipboard(source()).then((copied) => {
      notifyTransient({
        key: "clipboard",
        message: copied ? "Source copied" : "Couldn't copy the source. Select the source text and copy it instead.",
        severity: copied ? "success" : "error",
      });
    });
  });

  return { element };
}

/** Shared, noneditable caption chrome for every framed source block. */
export function blockCaption(text: string): {
  row: HTMLSpanElement;
  label: HTMLSpanElement;
  actions: HTMLSpanElement;
} {
  const row = document.createElement("span");
  row.className = "ub-block-caption";
  row.contentEditable = "false";
  const label = document.createElement("span");
  label.className = "ub-block-label";
  label.textContent = text;
  const actions = document.createElement("span");
  actions.className = "ub-block-actions";
  row.append(label, actions);
  return { row, label, actions };
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
  /** Optional passive caption and mount point for the writable language picker. */
  caption?: (node: PMNode) => string;
}

/**
 * A NodeView for a source-text block: its editable source plus copy and an
 * optional language caption, all chrome outside contentDOM.
 */
export function sourceBlockView(chrome: SourceBlockChrome): NodeViewRenderer {
  return ({ node }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    const dom = chrome.root();
    const contentDOM = chrome.content();
    const button = copyButton(() => current.textContent);
    const header = blockCaption("");
    const caption = chrome.caption === undefined ? null : document.createElement("span");
    const captionText = caption === null ? null : document.createElement("span");
    if (caption !== null && captionText !== null) {
      caption.className = "ub-code-caption";
      caption.contentEditable = "false";
      captionText.className = "ub-code-caption-text";
      captionText.textContent = chrome.caption?.(current) ?? "";
      caption.append(captionText);
      header.label.append(caption);
    }
    header.actions.append(button.element);
    dom.append(header.row, contentDOM);
    chrome.sync(current, dom);

    return {
      dom,
      contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type) return false;
        // Browser editing can detach an emptied code element. Rebuild the view
        // rather than patching contentDOM outside the live tree.
        if (contentDOM.parentNode !== dom) return false;
        current = updated;
        chrome.sync(current, dom);
        const label = chrome.caption?.(current) ?? "";
        if (captionText !== null && captionText.textContent !== label) captionText.textContent = label;
        return true;
      },
      // Only the chrome's own events. A click anywhere else in the block —
      // including the padding around the text — must still place the caret.
      stopEvent: (event: Event): boolean =>
        event.target instanceof Node && header.row.contains(event.target),
      // Ignore only chrome mutations; suppressing contentDOM repair can make
      // later keystrokes visible without storing them in the document.
      ignoreMutation: (mutation: { target: Node }): boolean =>
        header.row.contains(mutation.target),
    };
  };
}

/** A code panel with a caption slot, copy button and scrolling source. */
export const codeBlockChrome: SourceBlockChrome = {
  root: () => {
    const pre = document.createElement("pre");
    pre.className = "ub-code ub-block-frame";
    return pre;
  },
  content: () => document.createElement("code"),
  caption: (node) => codeLanguageLabel(node.attrs.language),
  sync: (node, root) => {
    mirrorAttribute(root, "id", node.attrs.id);
    mirrorAttribute(root, "data-language", node.attrs.language);
  },
};

/** Literal Mermaid source and identity, shared with the diagram NodeView. */
export const mermaidChrome: SourceBlockChrome = {
  root: () => {
    const div = document.createElement("div");
    div.className = "ub-mermaid ub-block-frame";
    div.setAttribute("data-block-type", "mermaid");
    return div;
  },
  content: () => document.createElement("pre"),
  sync: (node, root) => mirrorAttribute(root, "id", node.attrs.id),
};

/**
 * Class the source pre separately: terminal playback contains other pre nodes
 * and shared selectors must not hide/style those instead.
 */
export const terminalChrome: SourceBlockChrome = {
  root: () => {
    const div = document.createElement("div");
    div.className = "ub-terminal ub-block-frame";
    div.setAttribute("data-block-type", "terminal");
    return div;
  },
  content: () => {
    const pre = document.createElement("pre");
    pre.className = "ub-terminal-source";
    return pre;
  },
  sync: (node, root) => mirrorAttribute(root, "id", node.attrs.id),
};

/** Chart output is derived chrome; the mapping alone is editable content. */
export const chartChrome: SourceBlockChrome = {
  root: () => {
    const div = document.createElement("div");
    div.className = "ub-chart ub-block-frame";
    div.setAttribute("data-block-type", "chart");
    return div;
  },
  content: () => {
    const pre = document.createElement("pre");
    pre.className = "ub-chart-source";
    return pre;
  },
  sync: (node, root) => mirrorAttribute(root, "id", node.attrs.id),
};

/* ------------------------------------------------- the block under the caret */

/**
 * Share the selected-block predicate between expensive renderers and CSS source
 * visibility so playback and the visible representation cannot disagree.
 */
export function selectedBlock(
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
 * Derive source visibility from the current selection on every draw; do not
 * store a mode that can drift from the document.
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

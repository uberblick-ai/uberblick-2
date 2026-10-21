/**
 * Copy verbatim node.textContent, never Markdown fences. Keep chrome outside
 * contentDOM, noneditable and isolated from PM events; copying must move no
 * caret and dispatch no transaction or undo step.
 */

import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import { toast } from "sonner";
import { codeLanguageLabel } from "./syntax-highlighting.js";

/**
 * Try the secure-context Clipboard API, then selection copy for supported plain
 * HTTP deployments or denied transient activation. Report failure explicitly.
 */
export async function writeToClipboard(text: string, fallbackReady?: Promise<void>, fallbackContainer?: HTMLElement): Promise<boolean> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission or activation refusal still permits selection-copy fallback.
    }
  }
  // Modal callers supply a container inside the trap, or release their focus
  // trap before the selection fallback.
  // Start the native API above while the original user gesture is still active.
  if (fallbackReady !== undefined) await fallbackReady;
  return copyViaSelection(text, fallbackContainer);
}

/**
 * execCommand copies selection: focus a selectable offscreen textarea and
 * restore the prior focus without disturbing the editor caret.
 */
function copyViaSelection(text: string, container: HTMLElement = document.body): boolean {
  const previous = document.activeElement;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.readOnly = true;
  // Off-screen rather than hidden: `display: none` cannot hold a selection.
  scratch.style.position = "fixed";
  scratch.style.top = "-9999px";
  scratch.style.opacity = "0";
  container.appendChild(scratch);
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
      toast[copied ? "success" : "error"](
        copied ? "Source copied" : "Couldn't copy the source. Select the source text and copy it instead.",
        { id: "clipboard" },
      );
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

/**
 * Place the caret inside the block, which shows its source. `editableOnly`
 * refuses in a read-only editor, for blocks whose Source is an authoring control.
 */
export function openSource(
  editor: Editor,
  getPos: () => number | undefined,
  editableOnly = false,
): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    if (editableOnly && !editor.isEditable) return;
    const pos = getPos();
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
    editor.view.focus();
  };
}

/** A Source button. Its mousedown is prevented, so only the click moves the caret. */
export function sourceButton(label: string, open: (event: Event) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Source";
  button.setAttribute("aria-label", label);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", open);
  return button;
}

/** Whether any of the block's text carries an annotation's anchor. */
export function carriesComment(node: PMNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.marks.some((mark) => mark.type.name === COMMENT_MARK)) found = true;
  });
  return found;
}

/**
 * Keep events and mutations inside chrome away from ProseMirror, and ignore the
 * root attributes the view writes outside an update. Everything else must reach
 * it: a click in the block's padding places the caret, and suppressed contentDOM
 * repair can show keystrokes that are never stored.
 */
export function chromeFilters(
  dom: HTMLElement,
  chrome: readonly HTMLElement[],
  rootAttributes: readonly string[] = [],
): Required<Pick<NodeView, "stopEvent" | "ignoreMutation">> {
  const inChrome = (target: EventTarget | Node | null): boolean =>
    target instanceof Node && chrome.some((element) => element.contains(target));
  return {
    stopEvent: (event) => inChrome(event.target),
    ignoreMutation: (mutation: ViewMutationRecord) => inChrome(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === dom && rootAttributes.includes(mutation.attributeName ?? "")),
  };
}

/**
 * Load a renderer when the first block needs it. Browsers cache a failed
 * dynamic import by URL, so a retry imports the bundled `url` with a fresh
 * query, which Vite must leave intact.
 */
export function lazyRenderer<T>(load: () => Promise<T>, url: string): {
  current: () => T | null;
  load: () => Promise<T>;
} {
  let module: T | null = null;
  let loading: Promise<T> | null = null;
  let failures = 0;
  return {
    current: () => module,
    load: () => {
      loading ??= (failures === 0 ? load() : import(/* @vite-ignore */ `${url}?retry=${failures}`) as Promise<T>).then(
        (loaded) => (module = loaded),
        (cause: unknown) => { failures += 1; loading = null; throw cause; },
      );
      return loading;
    },
  };
}

function listItem(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

/** List a renderer's source-line diagnostics, hiding the list when there are none. */
export function showDiagnostics(
  list: HTMLElement,
  diagnostics: readonly { line: number; severity: string; message: string }[],
): void {
  list.replaceChildren(...diagnostics.map((diagnostic) =>
    listItem(`Line ${diagnostic.line}: ${diagnostic.severity}: ${diagnostic.message}`)));
  list.hidden = diagnostics.length === 0;
}

/** Show why a preview could not load or draw in place of its diagnostics. */
export function showFailure(list: HTMLElement, prefix: string, cause: unknown): void {
  const message = cause !== null && typeof cause === "object" && "message" in cause
    ? String(cause.message) : String(cause);
  list.replaceChildren(listItem(`${prefix}: ${message}`));
  list.hidden = false;
}

/** Mirror one node attribute onto the DOM, or remove it when unset. */
function mirrorAttribute(element: HTMLElement, name: string, value: unknown): void {
  if (typeof value === "string") element.setAttribute(name, value);
  else element.removeAttribute(name);
}

interface SourceBlockChrome {
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
      ...chromeFilters(dom, [header.row]),
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

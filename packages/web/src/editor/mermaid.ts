/** The diagram is derived chrome; ProseMirror owns the literal source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import { copyButton, mermaidChrome, sourceEditingPlugin } from "./source-chrome.js";

export function mermaidBlockView(): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let revision = 0;
    let destroyed = false;
    const dom = mermaidChrome.root();
    dom.dataset.state = "loading";
    const header = document.createElement("div");
    header.className = "ub-mermaid-header";
    header.contentEditable = "false";
    const caption = document.createElement("span");
    caption.textContent = "Mermaid";
    const actions = document.createElement("div");
    actions.className = "ub-mermaid-actions";
    const source = document.createElement("button");
    source.type = "button";
    source.textContent = "Source";
    source.setAttribute("aria-label", "Open Mermaid source");
    const copy = copyButton(() => current.textContent);
    copy.element.textContent = "Copy";
    actions.append(copy.element, source);
    header.append(caption, actions);
    const panel = document.createElement("div");
    panel.className = "ub-mermaid-panel";
    panel.contentEditable = "false";
    panel.hidden = true;
    panel.tabIndex = 0;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Mermaid diagram");
    // SVG styles must never select app content, including another diagram.
    const drawing = panel.attachShadow({ mode: "open" });
    const error = document.createElement("p");
    error.className = "ub-mermaid-error";
    error.contentEditable = "false";
    error.hidden = true;
    const contentDOM = mermaidChrome.content();
    contentDOM.className = "ub-mermaid-source";
    dom.append(header, panel, error, contentDOM);

    const draw = async (requested: number): Promise<void> => {
      pending = null;
      if (destroyed || requested !== revision) return;
      const text = current.textContent;
      try {
        // ES2024 is the renderer's browser floor. A guarded import also catches
        // unsupported syntax, unavailable chunks and later layout failures.
        if (typeof Reflect.get(Promise, "withResolvers") !== "function" ||
          typeof Reflect.get(Object, "groupBy") !== "function") {
          throw new Error("This browser does not support the diagram renderer (Safari 17.4 or later is required)");
        }
        const renderer = await import("./mermaid-renderer.js");
        if (destroyed || requested !== revision) return;
        const dark = document.documentElement.dataset.theme === "dark" ||
          (document.documentElement.dataset.theme !== "light" && appearance?.matches === true);
        const svg = await renderer.renderMermaid(text, dark);
        if (destroyed || requested !== revision) return;
        drawing.innerHTML = svg;
        const diagram = drawing.querySelector("svg");
        if (diagram === null) throw new Error("The renderer returned no diagram");
        // Preserve label size; wider diagrams scroll inside the column.
        const width = diagram.viewBox.baseVal.width;
        diagram.style.width = width > 0 ? `${width}px` : "100%";
        diagram.style.maxWidth = "100%";
        diagram.style.minWidth = width > 0 ? `${width}px` : "0";
        diagram.style.height = "auto";
        diagram.style.display = "block";
        panel.hidden = false;
        error.hidden = true;
        dom.dataset.state = "ready";
      } catch (cause) {
        if (destroyed || requested !== revision) return;
        drawing.replaceChildren();
        panel.hidden = true;
        const message = cause !== null && typeof cause === "object" && "message" in cause
          ? String(cause.message) : String(cause);
        error.textContent = `Diagram cannot be drawn: ${message}`;
        error.hidden = false;
        dom.dataset.state = "error";
      }
    };
    const schedule = (): void => {
      if (destroyed) return;
      const requested = ++revision;
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => { void draw(requested); }, 200);
    };
    const open = (event: Event): void => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
      editor.view.focus();
    };
    source.addEventListener("mousedown", event => event.preventDefault());
    source.addEventListener("click", open);
    const sync = (): void => {
      mermaidChrome.sync(current, dom);
      let annotated = false;
      current.forEach(child => {
        if (child.marks.some(mark => mark.type.name === COMMENT_MARK)) annotated = true;
      });
      dom.dataset.annotated = String(annotated);
    };
    const appearance = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    appearance?.addEventListener("change", schedule);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void document.fonts?.ready.then(schedule);
    sync();
    schedule();
    return {
      dom, contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type || contentDOM.parentNode !== dom) return false;
        const changed = updated.textContent !== current.textContent;
        current = updated;
        sync();
        if (changed) schedule();
        return true;
      },
      stopEvent: event => event.target instanceof Node &&
        (header.contains(event.target) || panel.contains(event.target) || error.contains(event.target)),
      ignoreMutation: mutation => header.contains(mutation.target) || panel.contains(mutation.target) || error.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom &&
          ["id", "data-annotated", "data-state"].includes(mutation.attributeName ?? "")),
      destroy: () => {
        destroyed = true;
        revision++;
        if (pending !== null) clearTimeout(pending);
        theme.disconnect();
        appearance?.removeEventListener("change", schedule);
        source.removeEventListener("click", open);
      },
    };
  };
}

export const MermaidBlocks = Extension.create({
  name: "uberblickMermaidBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("mermaid", "ub-mermaid-editing")]; },
});

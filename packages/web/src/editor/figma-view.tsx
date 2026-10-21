import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { FIGMA_DEFAULT_HEIGHT, FIGMA_PROVIDER, normalizeFigmaLink } from "@uberblick/schema";
import { toast } from "sonner";
import { blockCaption } from "./source-chrome.js";
import { endUndoCapture } from "./blocks.js";
import { FigmaFields } from "./figma-fields.js";
import type { FigmaFieldValues } from "./figma-fields.js";
import { observeFigma } from "./figma-loading.js";
import { lookupFigma } from "./figma-lookup.js";
import type { FigmaLookup } from "./figma-lookup.js";
import { figmaResize } from "./figma-resize.js";

function appearance(): "light" | "dark" {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function frameTitle(node: PMNode, lookup: FigmaLookup | null): string {
  const { figma } = normalizeFigmaLink(node.attrs.url);
  return node.attrs.title || lookup?.title || figma.fileName || figma.file;
}

// Preserve a reader's Load choice when the editor remounts a moved block.
const privateLoads = new WeakMap<Document, Map<string, string>>();

function elements(): {
  dom: HTMLElement; contentDOM: HTMLElement; viewer: HTMLElement; placeholder: HTMLElement;
  shield: HTMLButtonElement; fields: HTMLElement; handle: HTMLButtonElement; print: HTMLElement;
  header: ReturnType<typeof blockCaption>; edit: HTMLButtonElement; expand: HTMLButtonElement;
  done: HTMLButtonElement; open: HTMLAnchorElement; title: HTMLSpanElement;
  message: HTMLSpanElement; load: HTMLButtonElement;
} {
  const dom = document.createElement("article");
  dom.className = "ub-figma ub-block-frame";
  dom.dataset.blockType = "figma";
  const header = blockCaption("Figma");
  const title = document.createElement("span");
  header.label.replaceChildren(title);
  const makeButton = (label: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    return button;
  };
  const edit = makeButton("Edit");
  const done = makeButton("Done");
  const expand = makeButton("Expand");
  const open = document.createElement("a");
  open.textContent = "Open in Figma";
  open.target = "_blank"; open.rel = "noopener noreferrer"; open.referrerPolicy = "no-referrer";
  header.actions.append(edit, done, expand, open);
  const viewer = document.createElement("div");
  viewer.className = "ub-figma-viewer";
  viewer.contentEditable = "false";
  const placeholder = document.createElement("div");
  placeholder.className = "ub-figma-placeholder";
  const message = document.createElement("span");
  const load = makeButton("Load");
  placeholder.append(message, load);
  const shield = makeButton("Click to interact");
  const hint = document.createElement("span");
  hint.textContent = "Click to interact";
  shield.replaceChildren(hint);
  shield.className = "ub-figma-shield";
  shield.setAttribute("aria-label", "Interact with Figma preview");
  viewer.append(placeholder, shield);
  const fields = document.createElement("div");
  fields.contentEditable = "false";
  fields.hidden = true;
  const contentDOM = document.createElement("div");
  const handle = makeButton("Resize Figma preview");
  handle.className = "ub-figma-resize";
  handle.contentEditable = "false";
  handle.tabIndex = -1;
  const print = document.createElement("div");
  print.className = "ub-figma-print";
  print.contentEditable = "false";
  dom.append(header.row, viewer, fields, print, contentDOM, handle);
  return { dom, contentDOM, viewer, placeholder, shield, fields, handle, print, header, edit, expand, done, open, title, message, load };
}

class FigmaView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private current: PMNode;
  private readonly ui = elements();
  private active = false;
  private editing = false;
  private fullscreen = false;
  private iframe: HTMLIFrameElement | null = null;
  private fieldsRoot: Root | null = null;
  private lookup: FigmaLookup | null = null;
  private lookupPending = false;
  private lookupGeneration = 0;
  private destroyed = false;
  private readonly privateLoads: Map<string, string>;
  private readonly visibility: ReturnType<typeof observeFigma>;
  private readonly resize: ReturnType<typeof figmaResize>;

  constructor(private readonly props: NodeViewRendererProps) {
    this.current = props.node;
    this.dom = this.ui.dom; this.contentDOM = this.ui.contentDOM;
    const owner = this.dom.ownerDocument;
    let loads = privateLoads.get(owner);
    if (loads === undefined) { loads = new Map(); privateLoads.set(owner, loads); }
    this.privateLoads = loads;
    if (loads.get(this.current.attrs.id) !== this.current.attrs.url) loads.delete(this.current.attrs.id);
    this.resize = figmaResize(this.ui.handle, () => this.height(), (height) => this.showHeight(height), (height) => this.save({ height: String(height) }));
    this.visibility = observeFigma({
      dom: this.dom, scroller: props.editor.view.dom.closest("section.ub-document-pane"),
      load: () => this.load(), unload: () => this.unload(),
      pinned: () => this.fullscreen,
      ready: () => this.ready(),
    });
    this.ui.load.addEventListener("click", () => {
      this.privateLoads.set(this.current.attrs.id, this.current.attrs.url);
      this.sync();
      this.visibility.refresh();
    });
    this.ui.shield.addEventListener("click", () => this.interact());
    this.ui.edit.addEventListener("click", () => this.openFields());
    this.ui.done.addEventListener("click", () => {
      if (this.editing) this.ui.fields.querySelector("form")?.requestSubmit();
      else { this.active = false; this.sync(); }
    });
    this.ui.expand.addEventListener("click", () => {
      this.fullscreen = true;
      void this.dom.requestFullscreen().catch(() => {
        this.fullscreen = false;
        this.visibility.refresh();
        toast.error("Couldn't open fullscreen. Use Open in Figma instead.", { id: "figma-fullscreen" });
      });
    });
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    window.addEventListener("online", this.sync);
    window.addEventListener("offline", this.sync);
    props.editor.on("update", this.sync);
    props.editor.on("transaction", this.sync);
    this.sync();
  }

  private height(): number { return Number(this.current.attrs.height ?? FIGMA_DEFAULT_HEIGHT); }
  private showHeight(height: number): void { this.ui.viewer.style.setProperty("--figma-height", `${height}px`); }

  private save(values: Partial<FigmaFieldValues>): void {
    if (!this.props.editor.isEditable) return;
    const at = this.props.getPos();
    if (at === undefined) return;
    const { state } = this.props.editor;
    const node = state.doc.nodeAt(at);
    if (node?.type.name !== "figma" || node.attrs.id !== this.current.attrs.id ||
      Object.entries(values).every(([key, value]) => node.attrs[key] === value)) return;
    endUndoCapture(state);
    this.props.editor.view.dispatch(state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...values }));
    endUndoCapture(this.props.editor.state);
  }

  private interact(): void {
    if (this.iframe === null || this.editing) return;
    this.active = true;
    this.sync();
    this.iframe.focus();
  }

  private outside = (event: PointerEvent): void => {
    if (event.target instanceof globalThis.Node && !this.dom.contains(event.target)) {
      this.active = false;
      this.sync();
    }
  };

  private fullscreenChanged = (): void => {
    this.fullscreen = document.fullscreenElement === this.dom;
    this.visibility.refresh();
  };

  private isPrivate(): boolean {
    return this.lookup?.private === true && this.privateLoads.get(this.current.attrs.id) !== this.current.attrs.url;
  }

  private ready(): boolean {
    if (this.lookup === null && !this.lookupPending) {
      this.lookupPending = true;
      const generation = this.lookupGeneration;
      void lookupFigma(this.current.attrs.url, this.dom.ownerDocument).then((lookup) => {
        if (this.destroyed || generation !== this.lookupGeneration) return;
        this.lookup = lookup;
        this.lookupPending = false;
        this.sync();
        this.visibility.refresh();
      });
    }
    return this.lookup !== null && !this.isPrivate();
  }

  private load(): void {
    if (this.iframe !== null) return;
    this.iframe = document.createElement("iframe");
    for (const [name, value] of Object.entries(FIGMA_PROVIDER.frameAttributes)) this.iframe.setAttribute(name, value);
    this.iframe.title = frameTitle(this.current, this.lookup);
    this.iframe.src = FIGMA_PROVIDER.embedAddress(this.current.attrs.url, appearance());
    this.ui.viewer.prepend(this.iframe);
    this.sync();
  }

  private unload(): void {
    this.iframe?.remove();
    this.iframe = null;
    this.active = false;
    this.sync();
  }

  private openFields(): void {
    if (!this.props.editor.isEditable || this.editing) return;
    this.editing = true;
    this.active = false;
    let baseline: FigmaFieldValues = {
      url: this.current.attrs.url, title: this.current.attrs.title, height: this.current.attrs.height,
    };
    this.fieldsRoot = createRoot(this.ui.fields);
    this.fieldsRoot.render(<FigmaFields url={this.current.attrs.url} title={this.current.attrs.title ?? ""}
      height={this.current.attrs.height ?? ""} focusLink onSave={(values) => {
        // Fields untouched in this local draft must not overwrite a peer's edit.
        const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => baseline[key as keyof FigmaFieldValues] !== value));
        this.save(changes);
        baseline = values;
      }}
      onDone={() => this.closeFields()} />);
    this.sync();
  }

  private closeFields(): void {
    this.editing = false;
    this.fieldsRoot?.unmount();
    this.fieldsRoot = null;
    this.sync();
  }

  private sync = (): void => {
    const writable = this.props.editor.isEditable;
    if (!writable && this.editing) { this.closeFields(); return; }
    const title = frameTitle(this.current, this.lookup);
    this.dom.id = this.current.attrs.id ?? "";
    this.dom.dataset.figmaActive = String(this.active);
    this.ui.title.textContent = `Figma · ${title}`;
    this.ui.open.href = this.current.attrs.url;
    this.ui.print.textContent = `${title}\n${this.current.attrs.url}`;
    this.ui.edit.hidden = !writable || this.editing;
    this.ui.done.hidden = !this.active && !this.editing;
    this.ui.expand.disabled = this.iframe === null || this.editing || this.dom.requestFullscreen === undefined;
    this.ui.viewer.hidden = this.editing;
    this.ui.fields.hidden = !this.editing;
    this.ui.shield.hidden = this.active || this.iframe === null;
    this.ui.placeholder.hidden = this.iframe !== null;
    const privateFile = this.isPrivate();
    this.ui.message.textContent = !navigator.onLine ? "The Figma preview needs a connection." : privateFile
      ? "Figma can't show this file publicly. If you have access, load it to sign in." : "Figma preview";
    this.ui.load.hidden = !privateFile || !navigator.onLine;
    this.ui.handle.hidden = !writable || this.editing;
    this.resize.setDisabled(!writable || this.editing);
    if (!this.resize.isDragging()) this.showHeight(this.height());
    if (this.iframe !== null) this.iframe.title = title;
  };

  update(updated: PMNode): boolean {
    if (updated.type !== this.current.type || updated.attrs.id !== this.current.attrs.id) return false;
    const changedLink = updated.attrs.url !== this.current.attrs.url;
    this.current = updated;
    if (changedLink) {
      this.lookupGeneration += 1;
      this.lookup = null;
      this.lookupPending = false;
      this.privateLoads.delete(this.current.attrs.id);
      this.visibility.reset();
    }
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof globalThis.Node && event.target !== this.dom && !this.contentDOM.contains(event.target);
  }
  ignoreMutation(mutation: { type: string; target: globalThis.Node }): boolean {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }
  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("pointerdown", this.outside, true);
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    window.removeEventListener("online", this.sync);
    window.removeEventListener("offline", this.sync);
    this.props.editor.off("update", this.sync);
    this.props.editor.off("transaction", this.sync);
    this.visibility.destroy();
    this.resize.destroy();
    this.fieldsRoot?.unmount();
  }
}

export const figmaBlockView: NodeViewRenderer = (props) => new FigmaView(props);

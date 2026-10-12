import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, editBlock, exportMarkdown, getBlocks, getBlocksFragment,
} from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { mermaidBlockView } from "../src/editor/mermaid.js";
import { renderMermaid } from "../src/editor/mermaid-renderer.js";
import { mountEditor, snapshotFragment, typeText } from "./helpers.js";

vi.mock("../src/editor/mermaid-renderer.js", () => ({ renderMermaid: vi.fn() }));

const SOURCE = "flowchart LR\n  A --> B";
const INVALID = "invalid Mermaid";
const cleanup: Array<() => void> = [];
const originalViewBox = Object.getOwnPropertyDescriptor(SVGSVGElement.prototype, "viewBox");

function svg(text: string): string {
  const drawing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  drawing.setAttribute("viewBox", "0 0 100 60");
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.textContent = text;
  drawing.append(label);
  return drawing.outerHTML;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(renderMermaid).mockReset().mockImplementation(async text => svg(text));
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
  // jsdom cannot measure SVG. Browser tests prove the actual rendered diagram.
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true, get: () => ({ baseVal: { width: 100 } }),
  });
});

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  if (originalViewBox) Object.defineProperty(SVGSVGElement.prototype, "viewBox", originalViewBox);
  else Reflect.deleteProperty(SVGSVGElement.prototype, "viewBox");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

function fixture(source = SOURCE, editable = true) {
  const doc = new Y.Doc();
  appendBlock(doc, { type: "paragraph", text: "Before" });
  const id = appendBlock(doc, { type: "mermaid", text: source });
  const before = snapshotFragment(doc);
  let updates = 0;
  doc.on("update", () => { updates += 1; });
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createUberblickEditor({
    element, fragment: getBlocksFragment(doc), editable, canWrite: () => editable,
  });
  cleanup.push(() => { if (!editor.isDestroyed) editor.destroy(); element.remove(); doc.destroy(); });
  return { doc, id, editor, element, before, updates: () => updates };
}

function root(element: HTMLElement): HTMLElement {
  const block = element.querySelector<HTMLElement>(".ub-mermaid");
  if (block === null) throw new Error("Mermaid block did not mount");
  return block;
}

function drawing(block: HTMLElement): ShadowRoot {
  const shadow = block.querySelector(".ub-mermaid-panel")?.shadowRoot;
  if (!shadow) throw new Error("Mermaid drawing did not mount");
  return shadow;
}

function position(editor: Editor, id: string): number {
  let found = -1;
  editor.state.doc.forEach((node, pos) => { if (node.attrs.id === id) found = pos; });
  if (found < 0) throw new Error("fixture block is missing");
  return found;
}

async function draw(milliseconds = 200): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await vi.dynamicImportSettled();
}

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe("Mermaid source and derived diagrams", () => {
  it.each([true, false])("draws and exposes source and Copy in editable=%s documents without a document update", async editable => {
    const fix = fixture(SOURCE, editable);
    const block = root(fix.element);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await draw();
    expect(block.dataset.state).toBe("ready");
    expect(drawing(block).textContent).toBe(SOURCE);
    expect(block.querySelector<HTMLElement>(".ub-mermaid-panel")?.contentEditable).toBe("false");
    expect(block.classList.contains("ub-mermaid-editing")).toBe(false);
    block.querySelector<HTMLButtonElement>('button[aria-label="Open Mermaid source"]')?.click();
    expect(fix.editor.state.selection.$head.parent.type.name).toBe("mermaid");
    expect(block.classList.contains("ub-mermaid-editing")).toBe(true);
    expect(fix.editor.view.dom.getAttribute("contenteditable")).toBe(String(editable));
    block.querySelector<HTMLButtonElement>(".ub-copy")?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(SOURCE);
    expect(snapshotFragment(fix.doc)).toEqual(fix.before);
    expect(fix.updates()).toBe(0);
    expect(exportMarkdown(fix.doc, { frontmatter: false })).toContain(`\`\`\`mermaid\n${SOURCE}\n\`\`\``);
    if (editable) {
      typeText(fix.editor, "%% Note\n");
      await draw();
      expect(getBlocks(fix.doc).find(block => block.id === fix.id)?.text).toBe(`%% Note\n${SOURCE}`);
      expect(drawing(block).textContent).toBe(`%% Note\n${SOURCE}`);
    }
  });

  it("debounces typing and redraws collaborator and MCP-shaped edits without echoing remote writes", async () => {
    const fix = fixture();
    const block = root(fix.element);
    await draw();
    vi.mocked(renderMermaid).mockClear();
    fix.editor.commands.setTextSelection(position(fix.editor, fix.id) + 1 + SOURCE.length);
    typeText(fix.editor, " --> C");
    await draw(199);
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(drawing(block).textContent).toBe(SOURCE);
    expect(block.querySelector<HTMLElement>(".ub-mermaid-panel")?.hidden).toBe(false);
    typeText(fix.editor, " --> D");
    await draw(199);
    expect(renderMermaid).not.toHaveBeenCalled();
    await draw(1);
    expect(drawing(block).textContent).toBe(`${SOURCE} --> C --> D`);
    expect(renderMermaid).toHaveBeenCalledTimes(1);

    const peer = new Y.Doc();
    cleanup.push(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fix.doc));
    let localWrites = 0;
    fix.doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => {
      if (transaction.local) localWrites += 1;
    });
    for (const text of ["flowchart LR\n  Peer --> B", "flowchart LR\n  MCP --> B"]) {
      const previous = getBlocks(peer).find(block => block.id === fix.id)?.text;
      if (previous === undefined) throw new Error("fixture source is missing");
      editBlock(peer, fix.id, previous, text);
      Y.applyUpdate(fix.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(fix.doc)));
      await draw(100);
      expect(drawing(block).textContent).toBe(`${SOURCE} --> C --> D`);
      expect(block.querySelector<HTMLElement>(".ub-mermaid-panel")?.hidden).toBe(false);
    }
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    await draw(100);
    expect(drawing(block).textContent).toBe("flowchart LR\n  MCP --> B");
    expect(renderMermaid).toHaveBeenCalledTimes(2);
    expect(localWrites).toBe(0);
  });

  it("discards an older asynchronous drawing after newer source has rendered", async () => {
    const old = deferred();
    vi.mocked(renderMermaid).mockImplementationOnce(() => old.promise);
    const fix = fixture();
    const block = root(fix.element);
    await draw();
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    const next = "flowchart LR\n  New --> Source";
    editBlock(fix.doc, fix.id, SOURCE, next);
    await draw();
    expect(drawing(block).textContent).toBe(next);
    const before = snapshotFragment(fix.doc);
    old.resolve(svg(SOURCE));
    await draw(0);
    expect(drawing(block).textContent).toBe(next);
    expect(block.dataset.state).toBe("ready");
    expect(snapshotFragment(fix.doc)).toEqual(before);
  });

  it("clears failed diagrams, preserves the parse message, isolates other blocks and recovers", async () => {
    vi.mocked(renderMermaid).mockImplementation(async text => {
      if (text === INVALID) throw new Error("Parse error on line 1: Unknown diagram type");
      return svg(text);
    });
    const fix = fixture();
    const other = appendBlock(fix.doc, { type: "mermaid", text: SOURCE });
    await draw();
    const blocks = [...fix.element.querySelectorAll<HTMLElement>(".ub-mermaid")];
    expect(blocks).toHaveLength(2);
    editBlock(fix.doc, fix.id, SOURCE, INVALID);
    expect(drawing(blocks[0]!).textContent).toBe(SOURCE);
    expect(blocks[0]?.querySelector<HTMLElement>(".ub-mermaid-panel")?.hidden).toBe(false);
    const before = snapshotFragment(fix.doc);
    await draw();
    expect(blocks[0]?.dataset.state).toBe("error");
    expect(drawing(blocks[0]!).querySelector("svg")).toBeNull();
    expect(blocks[0]?.querySelector<HTMLElement>(".ub-mermaid-error")?.hidden).toBe(false);
    expect(blocks[0]?.querySelector(".ub-mermaid-error")?.textContent).toContain("Parse error on line 1");
    expect(blocks[0]?.querySelector(".ub-mermaid-source")?.textContent).toBe(INVALID);
    expect(drawing(blocks[1]!).textContent).toBe(SOURCE);
    expect(getBlocks(fix.doc).find(block => block.id === other)?.text).toBe(SOURCE);
    expect(snapshotFragment(fix.doc)).toEqual(before);
    const recovered = deferred();
    vi.mocked(renderMermaid).mockImplementationOnce(() => recovered.promise);
    editBlock(fix.doc, fix.id, INVALID, SOURCE);
    expect(blocks[0]?.dataset.state).toBe("error");
    expect(blocks[0]?.querySelector<HTMLElement>(".ub-mermaid-error")?.hidden).toBe(false);
    expect(drawing(blocks[0]!).querySelector("svg")).toBeNull();
    await draw();
    expect(blocks[0]?.dataset.state).toBe("error");
    expect(blocks[0]?.querySelector<HTMLElement>(".ub-mermaid-error")?.hidden).toBe(false);
    recovered.resolve(svg(SOURCE));
    await draw(0);
    expect(blocks[0]?.dataset.state).toBe("ready");
    expect(blocks[0]?.querySelector<HTMLElement>(".ub-mermaid-error")?.hidden).toBe(true);
    expect(drawing(blocks[0]!).textContent).toBe(SOURCE);
  });

  it("keeps comment anchors in source without treating annotation or selection changes as redraws", async () => {
    const fix = fixture();
    const block = root(fix.element);
    await draw();
    vi.mocked(renderMermaid).mockClear();
    createAnnotation(fix.doc, fix.id, 0, 9, "reader", "Check this diagram");
    expect(block.dataset.annotated).toBe("true");
    expect(block.querySelector(".ub-mermaid-source .ub-comment")?.textContent).toBe("flowchart");
    const before = snapshotFragment(fix.doc);
    fix.editor.commands.setTextSelection(position(fix.editor, fix.id) + 1 + SOURCE.length);
    fix.editor.commands.setTextSelection(1);
    await draw();
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(block.dataset.annotated).toBe("true");
    expect(snapshotFragment(fix.doc)).toEqual(before);
    fix.editor.commands.setTextSelection(position(fix.editor, fix.id) + 1 + SOURCE.length);
    typeText(fix.editor, " --> C");
    await draw();
    expect(block.querySelector(".ub-mermaid-source .ub-comment")?.textContent).toBe("flowchart");
    expect(drawing(block).textContent).toBe(`${SOURCE} --> C`);
  });

  it("shows readable source when the browser cannot run the renderer", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object, "groupBy");
    Object.defineProperty(Object, "groupBy", { configurable: true, value: undefined });
    try {
      const fix = fixture();
      const block = root(fix.element);
      await draw();
      expect(renderMermaid).not.toHaveBeenCalled();
      expect(block.dataset.state).toBe("error");
      expect(drawing(block).querySelector("svg")).toBeNull();
      expect(block.querySelector(".ub-mermaid-source")?.textContent).toBe(SOURCE);
      expect(block.querySelector(".ub-mermaid-error")?.textContent).toContain("Safari 17.4");
    } finally {
      if (descriptor) Object.defineProperty(Object, "groupBy", descriptor);
      else Reflect.deleteProperty(Object, "groupBy");
    }
  });

  it("cancels scheduled redraws and ignores an in-flight drawing after the block is removed", async () => {
    const pending = deferred();
    vi.mocked(renderMermaid).mockImplementationOnce(() => pending.promise);
    const fix = fixture();
    const block = root(fix.element);
    await draw();
    editBlock(fix.doc, fix.id, SOURCE, `${SOURCE} --> C`);
    getBlocksFragment(fix.doc).delete(1, 1);
    const before = snapshotFragment(fix.doc);
    await draw();
    pending.resolve(svg(SOURCE));
    await draw(0);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(fix.element.querySelector(".ub-mermaid")).toBeNull();
    expect(drawing(block).querySelector("svg")).toBeNull();
    expect(snapshotFragment(fix.doc)).toEqual(before);
  });

  it("isolates diagram chrome while allowing ProseMirror to repair edited or detached source", () => {
    const doc = new Y.Doc();
    appendBlock(doc, { type: "paragraph", text: "Before" });
    const { editor } = mountEditor(doc);
    cleanup.push(() => { if (!editor.isDestroyed) editor.destroy(); doc.destroy(); });
    const node = editor.schema.nodes.mermaid!.create({ id: "diagram" }, editor.schema.text(SOURCE));
    const view = mermaidBlockView()({ node, editor, getPos: () => 0 } as NodeViewRendererProps);
    cleanup.push(() => view.destroy?.());
    const content = view.contentDOM!;
    const sourceText = document.createTextNode(SOURCE);
    content.append(sourceText);
    const changed = (target: Node): MutationRecord => ({ type: "childList", target }) as MutationRecord;
    const event = (target: Node): Event => ({ target }) as unknown as Event;
    for (const selector of [".ub-mermaid-header", ".ub-copy", ".ub-mermaid-panel", ".ub-mermaid-error"]) {
      const chrome = view.dom.querySelector(selector)!;
      expect(view.ignoreMutation!(changed(chrome))).toBe(true);
      expect(view.stopEvent!(event(chrome))).toBe(true);
    }
    for (const source of [content, sourceText, view.dom]) {
      expect(view.ignoreMutation!(changed(source))).toBe(false);
      expect(view.stopEvent!(event(source))).toBe(false);
    }
    content.remove();
    expect(view.update!(node, [], DecorationSet.empty)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, editBlock, exportMarkdown, getBlocks,
  getBlocksFragment, importMarkdown,
  blockRev,
} from "@uberblick/schema";
import { parseWireframe, renderWireframe } from "@uberblick/wireframe";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { mountEditor, snapshotFragment, typeText } from "./helpers.js";
import { dataRevision } from "../src/editor/render-state.js";

vi.mock("@uberblick/wireframe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/wireframe")>();
  return {
    ...actual,
    parseWireframe: vi.fn(actual.parseWireframe),
    renderWireframe: vi.fn(actual.renderWireframe),
  };
});

const SOURCE = "dialog Delete draft?\n  text It will be gone.\n  row.end\n    button.focus Cancel\n    button.danger Delete";
const INVALID = "dialog Delete draft?\n text Bad indentation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(parseWireframe).mockClear();
  vi.mocked(renderWireframe).mockClear();
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
});
afterEach(() => { vi.useRealTimers(); });

function position(editor: Editor, id: string): number {
  let found = -1;
  editor.state.doc.forEach((node, pos) => { if (node.attrs.id === id) found = pos; });
  if (found < 0) throw new Error("fixture block is missing");
  return found;
}

function fixture(source = SOURCE) {
  const doc = new Y.Doc();
  appendBlock(doc, { type: "paragraph", text: "Before" });
  const id = appendBlock(doc, { type: "code", language: "wireframe", text: source });
  const { editor, element } = mountEditor(doc);
  return { doc, id, editor, element };
}

function root(element: HTMLElement): HTMLElement {
  const node = element.querySelector<HTMLElement>(".ub-wireframe");
  if (node === null) throw new Error("wireframe did not mount");
  return node;
}

/** The renderer loads on first mount; later drawings are synchronous. */
async function draw(): Promise<void> {
  vi.advanceTimersByTime(200);
  await vi.dynamicImportSettled();
}

describe("wireframe code blocks", () => {
  it.each([true, false])("renders Markdown and MCP-shaped code in an editable=%s editor without changing stored content", async (editable) => {
    const fence = `\`\`\`wireframe\n${SOURCE}\n\`\`\`\n`;
    const doc = new Y.Doc();
    const imported = importMarkdown(fence);
    expect(imported.blocks).toEqual([{ type: "code", language: "wireframe", text: SOURCE }]);
    for (const block of imported.blocks) appendBlock(doc, block);
    appendBlock(doc, { type: "code", language: "wireframe", text: SOURCE });
    const before = snapshotFragment(doc);
    let localWrites = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => {
      if (transaction.local) localWrites += 1;
    });
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(doc), editable, canWrite: () => editable });
    try {
      await draw();
      expect(root(element).querySelectorAll(":scope > .ub-block-caption")).toHaveLength(1);
      expect(root(element).querySelector(".ub-block-label")?.textContent).toBe("Wireframe");
      expect([...root(element).querySelectorAll(".ub-block-actions > button")].map(button => button.textContent)).toEqual(["Copy", "Source"]);
      expect(element.querySelectorAll(".ub-wireframe-drawing .wf-root")).toHaveLength(2);
      expect(root(element).querySelector<HTMLElement>(".ub-wireframe-panel")?.contentEditable).toBe("false");
      expect(root(element).querySelector(".ub-wireframe-source")?.textContent).toBe(SOURCE);
      expect(root(element).querySelector(".wf-root")?.textContent).toContain("Delete draft?");
      expect(root(element).querySelector(".wf-root")?.querySelectorAll("button, input, a, script")).toHaveLength(0);
      expect(snapshotFragment(doc)).toEqual(before);
      expect(exportMarkdown(doc, { frontmatter: false })).toBe(`${fence}\n${fence}`);
      expect(localWrites).toBe(0);
    } finally {
      editor.destroy();
      element.remove();
      doc.destroy();
    }
  });

  it("debounces local typing and collaborator or agent text updates after the last edit", async () => {
    const fix = fixture();
    await draw();
    const drawing = root(fix.element).querySelector(".ub-wireframe-drawing");
    expect(drawing?.textContent).toContain("It will be gone.");
    const revision = blockRev({ type: "code", language: "wireframe", text: SOURCE });
    expect(root(fix.element).dataset).toMatchObject({ sourceRev: revision, dataRev: dataRevision(null), drawState: "success" });
    vi.mocked(parseWireframe).mockClear();
    vi.mocked(renderWireframe).mockClear();
    const start = position(fix.editor, fix.id) + 1;
    const end = SOURCE.indexOf("It will be gone.") + "It will be gone.".length;
    fix.editor.commands.setTextSelection(start + end);
    typeText(fix.editor, " Soon");
    expect(root(fix.element).querySelector(".ub-wireframe-source")?.textContent).toContain("It will be gone. Soon");
    vi.advanceTimersByTime(199);
    expect(parseWireframe).not.toHaveBeenCalled();
    expect(root(fix.element).dataset.sourceRev).toBe(revision);
    typeText(fix.editor, "!");
    vi.advanceTimersByTime(199);
    expect(renderWireframe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(parseWireframe).toHaveBeenCalledTimes(1);
    expect(renderWireframe).toHaveBeenCalledTimes(1);
    expect(drawing?.textContent).toContain("It will be gone. Soon!");
    expect(root(fix.element).dataset.sourceRev).toBe(blockRev({ type: "code", language: "wireframe",
      text: SOURCE.replace("It will be gone.", "It will be gone. Soon!") }));

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fix.doc));
    let localWrites = 0;
    fix.doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => {
      if (transaction.local) localWrites += 1;
    });
    for (const next of ["Updated by collaborator", "Updated by agent"]) {
      const current = getBlocks(peer).find((block) => block.id === fix.id)?.text;
      if (current === undefined) throw new Error("fixture source is missing");
      editBlock(peer, fix.id, current, SOURCE.replace("It will be gone.", next));
      Y.applyUpdate(fix.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(fix.doc)));
      vi.advanceTimersByTime(100);
    }
    expect(renderWireframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(99);
    expect(renderWireframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(renderWireframe).toHaveBeenCalledTimes(2);
    expect(drawing?.textContent).toContain("Updated by agent");
    expect(localWrites).toBe(0);
    fix.editor.destroy(); fix.doc.destroy(); peer.destroy();
  });

  it("keeps the last good drawing visibly stale on errors, then recovers without rewriting source", async () => {
    const fix = fixture();
    await draw();
    const wireframe = root(fix.element);
    const good = wireframe.querySelector(".wf-root");
    editBlock(fix.doc, fix.id, SOURCE, INVALID);
    const stored = snapshotFragment(fix.doc);
    await draw();
    expect(wireframe.querySelector(".wf-root")).toBe(good);
    expect(wireframe.querySelector<HTMLElement>(".ub-wireframe-stale")?.hidden).toBe(false);
    expect(wireframe.querySelector(".ub-wireframe-stale")?.textContent).toBe("Preview is stale");
    expect(wireframe.querySelector(".ub-wireframe-diagnostics")?.textContent).toMatch(/(?:line|Line) 2.*(?:error|Error)/);
    expect(snapshotFragment(fix.doc)).toEqual(stored);
    expect(wireframe.dataset).toMatchObject({
      sourceRev: blockRev({ type: "code", language: "wireframe", text: INVALID }), drawState: "error",
    });
    editBlock(fix.doc, fix.id, INVALID, SOURCE.replace("Delete draft?", "Delete another draft?"));
    await draw();
    expect(wireframe.querySelector(".wf-root")?.textContent).toContain("Delete another draft?");
    expect(wireframe.querySelector<HTMLElement>(".ub-wireframe-stale")?.hidden).toBe(true);
    expect(wireframe.querySelector<HTMLElement>(".ub-wireframe-diagnostics")?.hidden).toBe(true);
    expect(wireframe.dataset.drawState).toBe("success");
    fix.editor.destroy(); fix.doc.destroy();
  });

  it("shows diagnostics alone before any good preview and renders every warning with its line", async () => {
    const fix = fixture(INVALID);
    await draw();
    const wireframe = root(fix.element);
    expect(wireframe.querySelector(".wf-root")).toBeNull();
    expect(wireframe.querySelector<HTMLElement>(".ub-wireframe-stale")?.hidden).toBe(true);
    expect(wireframe.querySelector(".ub-wireframe-diagnostics")?.textContent).toMatch(/(?:line|Line) 2/);
    const warningSource = `dialog With warnings\n${Array.from({ length: 7 }, (_, i) => `  text.unknown Warning ${i + 1}`).join("\n")}`;
    editBlock(fix.doc, fix.id, INVALID, warningSource);
    await draw();
    expect(wireframe.querySelector(".wf-root")?.textContent).toContain("With warnings");
    expect(wireframe.querySelector(".wf-root")?.textContent).toContain("Warning 7");
    const diagnostics = wireframe.querySelector(".ub-wireframe-diagnostics");
    expect(diagnostics?.textContent).toMatch(/(?:line|Line) 2.*(?:warning|Warning)/);
    expect(diagnostics?.textContent).toMatch(/(?:line|Line) 8.*(?:warning|Warning)/);
    expect(diagnostics?.querySelectorAll("li")).toHaveLength(7);
    expect(wireframe.querySelector<HTMLElement>(".ub-wireframe-stale")?.hidden).toBe(true);
    expect(getBlocks(fix.doc).find((block) => block.id === fix.id)?.text).toBe(warningSource);
    fix.editor.destroy(); fix.doc.destroy();
  });

  it("reports a failed drawing for its attempted source and recovers on the next edit", async () => {
    const fix = fixture();
    await draw();
    vi.mocked(renderWireframe).mockImplementationOnce(() => { throw new Error("Cannot draw"); });
    const failed = SOURCE.replace("Delete draft?", "Changed title");
    editBlock(fix.doc, fix.id, SOURCE, failed);
    await draw();
    expect(root(fix.element).dataset).toMatchObject({ sourceRev: blockRev({ type: "code", language: "wireframe", text: failed }), drawState: "error" });
    expect(root(fix.element).querySelector(".ub-wireframe-diagnostics")?.textContent).toContain("Cannot draw");
    expect(root(fix.element).querySelector<HTMLElement>(".ub-wireframe-stale")?.hidden).toBe(false);
    editBlock(fix.doc, fix.id, failed, SOURCE);
    await draw();
    expect(root(fix.element).dataset.drawState).toBe("success");
    fix.editor.destroy(); fix.doc.destroy();
  });

  it("opens editable source from the preview and keeps annotated source anchored without redrawing", async () => {
    const fix = fixture();
    await draw();
    const wireframe = root(fix.element);
    expect(wireframe.classList.contains("ub-wireframe-editing")).toBe(false);
    const action = wireframe.querySelector<HTMLButtonElement>('button[aria-label="Open wireframe source"]');
    expect(action?.textContent).toBe("Source");
    const before = snapshotFragment(fix.doc);
    action?.click();
    expect(fix.editor.state.selection.$head.parent.type.name).toBe("code");
    expect(fix.editor.state.selection.$head.parent.attrs.language).toBe("wireframe");
    expect(wireframe.classList.contains("ub-wireframe-editing")).toBe(true);
    expect(snapshotFragment(fix.doc)).toEqual(before);
    fix.editor.commands.setTextSelection(1);
    expect(wireframe.classList.contains("ub-wireframe-editing")).toBe(false);
    createAnnotation(fix.doc, fix.id, 0, 6, "reader", "Please check the title");
    expect(wireframe.dataset.annotated).toBe("true");
    expect(wireframe.querySelector(".ub-wireframe-source .ub-comment")?.textContent).toBe("dialog");
    expect(wireframe.querySelector(".wf-root")).not.toBeNull();
    await draw();
    expect(parseWireframe).toHaveBeenCalledTimes(1);
    expect(renderWireframe).toHaveBeenCalledTimes(1);
    fix.editor.destroy(); fix.doc.destroy();
  });

  it("does no parse or render work for prose typing and selection changes with 100 previews", async () => {
    const doc = new Y.Doc();
    appendBlock(doc, { type: "paragraph", text: "Before" });
    const ids = Array.from({ length: 100 }, () => appendBlock(doc, { type: "code", language: "wireframe", text: SOURCE }));
    const { editor, element } = mountEditor(doc);
    await draw();
    expect(element.querySelectorAll(".wf-root")).toHaveLength(100);
    vi.mocked(parseWireframe).mockClear();
    vi.mocked(renderWireframe).mockClear();
    for (const character of "abcdefghijklmnopqrst") {
      editor.commands.setTextSelection(1);
      typeText(editor, character);
      editor.commands.setTextSelection(position(editor, ids[0] ?? "") + 1);
    }
    await draw();
    expect(parseWireframe).not.toHaveBeenCalled();
    expect(renderWireframe).not.toHaveBeenCalled();
    editor.destroy(); doc.destroy();
  });

  it("cancels pending source redraws when a wireframe view is destroyed", async () => {
    const fix = fixture();
    await draw();
    vi.mocked(parseWireframe).mockClear();
    vi.mocked(renderWireframe).mockClear();
    editBlock(fix.doc, fix.id, SOURCE, SOURCE.replace("Delete draft?", "Changed title"));
    fix.editor.destroy();
    await draw();
    expect(parseWireframe).not.toHaveBeenCalled();
    expect(renderWireframe).not.toHaveBeenCalled();
    fix.doc.destroy();
  });
});

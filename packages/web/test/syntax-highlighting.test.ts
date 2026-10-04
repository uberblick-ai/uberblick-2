/**
 * Syntax highlighting is a view of source, never document content.
 *
 * These checks pin the bundled grammar boundary, alias handling, remote redraw
 * and coexistence with the one mark source blocks may store. CSS appearance is
 * left to the browser proof; this file defends the document invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  initDoc,
  insertBlock,
  setBlockLanguage,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { redo, undo, yUndoPluginKey } from "y-prosemirror";
import { codeHighlightingKey } from "../src/editor/syntax-highlighting.js";
import { threadIdFromTarget } from "../src/ui/threads.js";
import { mountEditor, snapshotFragment } from "./helpers.js";

const editors: Editor[] = [];
const calls = vi.hoisted(() => ({ highlight: vi.fn() }));

// Observe work at the existing dependency boundary without adding a production
// API or replacing the grammar/token output that these tests must preserve.
vi.mock("lowlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lowlight")>();
  return {
    ...actual,
    createLowlight: (...args: Parameters<typeof actual.createLowlight>) => {
      const instance = actual.createLowlight(...args);
      const highlight = instance.highlight.bind(instance);
      instance.highlight = (...input) => {
        calls.highlight(input[0], input[1]);
        return highlight(...input);
      };
      return instance;
    },
  };
});

beforeEach(() => calls.highlight.mockClear());

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors.length = 0;
});

function mount(ydoc: Y.Doc): { editor: Editor; element: HTMLElement } {
  const { editor, element } = mountEditor(ydoc);
  editors.push(editor);
  return { editor, element };
}

function code(element: HTMLElement, language: string): HTMLElement {
  const block = element.querySelector<HTMLElement>(
    `.ub-code[data-language="${language}"]`,
  );
  if (block === null) throw new Error(`no ${language} code block`);
  return block;
}

function highlightingState(editor: Editor) {
  const decorations = codeHighlightingKey.getState(editor.state);
  if (decorations === undefined) throw new Error("no syntax-highlighting plugin");
  return decorations.decorations;
}

function blockPosition(editor: Editor, id: string): number {
  let found = -1;
  editor.state.doc.forEach((node, pos) => {
    if (node.attrs.id === id) found = pos;
  });
  if (found < 0) throw new Error(`no block ${id}`);
  return found;
}

function expectKeywords(element: HTMLElement, expected: string[]): void {
  expect([...element.querySelectorAll(".hljs-keyword")].map((token) => token.textContent))
    .toEqual(expected);
}

describe("code syntax highlighting", () => {
  it("colours the common web and shell grammars, including their aliases", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "highlight-languages", title: "Languages" });
    for (const [language, text] of [
      ["ts", "const answer: number = 42;"],
      ["html", "<main>hello</main>"],
      ["css", ".card { color: red; }"],
      ["bash", 'echo "$HOME"'],
      ["sh", 'echo "$HOME"'],
      ["unknown", "plain text"],
      ["", "also plain"],
    ] as const) {
      appendBlock(ydoc, { type: "code", language, text });
    }

    const { element } = mount(ydoc);
    expect(code(element, "ts").querySelector(".hljs-keyword")?.textContent).toBe(
      "const",
    );
    expect(code(element, "html").querySelector(".hljs-name")?.textContent).toBe(
      "main",
    );
    expect(
      code(element, "css").querySelector(".hljs-selector-class")?.textContent,
    ).toBe(".card");
    for (const language of ["bash", "sh"]) {
      expect(
        code(element, language).querySelector(".hljs-built_in")?.textContent,
      ).toBe("echo");
    }

    expect(code(element, "unknown").querySelector("[class^=hljs-]")).toBeNull();
    const empty = element.querySelector<HTMLElement>('.ub-code[data-language=""]');
    expect(empty?.querySelector("[class^=hljs-]")).toBeNull();
    expect(code(element, "unknown").textContent).toContain("plain text");
    expect(empty?.textContent).toContain("also plain");
  });

  it("redraws external edits while highlighting writes nothing and comments stay usable", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "highlight-live", title: "Live source" });
    const source = "const answer = 42;";
    const blockId = appendBlock(ydoc, {
      type: "code",
      language: "ts",
      text: source,
    });
    const thread = createAnnotation(ydoc, blockId, 6, 12, "reviewer", "why?");
    const before = snapshotFragment(ydoc);
    const markdown = exportMarkdown(ydoc, { frontmatter: false });

    const { element } = mount(ydoc);
    const highlighted = code(element, "ts");
    expect(highlighted.querySelector(".hljs-keyword")?.textContent).toBe("const");
    const anchor = highlighted.querySelector<HTMLElement>("[data-comment-thread]");
    expect(anchor?.textContent).toBe("answer");
    expect(threadIdFromTarget(anchor ?? null)).toBe(thread.id);
    expect(snapshotFragment(ydoc)).toEqual(before);
    expect(exportMarkdown(ydoc, { frontmatter: false })).toBe(markdown);

    const live = new Y.Doc();
    initDoc(live, { uuid: "highlight-remote", title: "Remote source" });
    const liveBlockId = appendBlock(live, {
      type: "code",
      language: "unknown",
      text: "plain words",
    });
    const { element: liveElement } = mount(live);
    expect(code(liveElement, "unknown").querySelector("[class^=hljs-]")).toBeNull();

    setBlockLanguage(live, liveBlockId, "typescript");
    editBlock(live, liveBlockId, "plain words", 'const ready = "yes";');

    const updated = code(liveElement, "typescript");
    expect(updated.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(updated.querySelector(".hljs-string")?.textContent).toBe('"yes"');
    expect(exportMarkdown(live, { frontmatter: false })).toBe(
      '```typescript\nconst ready = "yes";\n```\n',
    );
  });

  it("reuses decorations for selection changes and refreshes them for document edits", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "highlight-updates", title: "Updates" });
    appendBlock(ydoc, {
      type: "code",
      language: "ts",
      text: "const answer = 42;",
    });
    const { editor } = mount(ydoc);

    const initial = highlightingState(editor);
    editor.commands.setTextSelection(2);
    expect(highlightingState(editor)).toBe(initial);

    editor.commands.insertContent(" ");
    expect(highlightingState(editor)).not.toBe(initial);
  });

  it("highlights only changed source on local edits, including language, undo and redo", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "highlight-local", title: "Local" });
    const prose = appendBlock(ydoc, { type: "paragraph", text: "before" });
    const first = appendBlock(ydoc, { type: "code", language: "ts", text: "const first = 1;" });
    appendBlock(ydoc, { type: "code", language: "ts", text: "let second = 2;" });
    const { editor, element } = mount(ydoc);
    calls.highlight.mockClear();

    editor.view.dispatch(editor.state.tr.insertText("prose ", blockPosition(editor, prose) + 1));
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);
    undo(editor.state);
    redo(editor.state);
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();

    editor.view.dispatch(editor.state.tr.insertText("const third = 3;\n", blockPosition(editor, first) + 1));
    expect(calls.highlight.mock.calls).toEqual([["ts", "const third = 3;\nconst first = 1;"]]);
    expectKeywords(element, ["const", "const", "let"]);
    calls.highlight.mockClear();
    undo(editor.state);
    expect(calls.highlight.mock.calls).toEqual([["ts", "const first = 1;"]]);
    expectKeywords(element, ["const", "let"]);
    calls.highlight.mockClear();
    redo(editor.state);
    expect(calls.highlight.mock.calls).toEqual([["ts", "const third = 3;\nconst first = 1;"]]);
    expectKeywords(element, ["const", "const", "let"]);

    calls.highlight.mockClear();
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
    const pos = blockPosition(editor, first);
    const node = editor.state.doc.nodeAt(pos);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node?.attrs, language: "javascript" }));
    expect(calls.highlight.mock.calls).toEqual([["javascript", "const third = 3;\nconst first = 1;"]]);
    expectKeywords(element, ["const", "const", "let"]);
    calls.highlight.mockClear();
    undo(editor.state);
    expect(calls.highlight.mock.calls).toEqual([["ts", "const third = 3;\nconst first = 1;"]]);
    expectKeywords(element, ["const", "const", "let"]);
    calls.highlight.mockClear();
    redo(editor.state);
    expect(calls.highlight.mock.calls).toEqual([["javascript", "const third = 3;\nconst first = 1;"]]);
    expectKeywords(element, ["const", "const", "let"]);

    calls.highlight.mockClear();
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)?.attrs, id: "renamed-code" }));
    const comment = editor.schema.marks.comment?.create({ threadId: "local-comment" });
    if (comment === undefined) throw new Error("no comment mark");
    editor.view.dispatch(editor.state.tr.addMark(pos + 1, pos + 6, comment));
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "const", "let"]);
  });

  it("keeps remote replacements and moved blocks coloured without highlighting unchanged inputs or writing Yjs", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "highlight-two-clients", title: "Remote" });
    const prose = appendBlock(ydoc, { type: "paragraph", text: "before" });
    const first = appendBlock(ydoc, { type: "code", language: "ts", text: "const first = 1;" });
    const second = appendBlock(ydoc, { type: "code", language: "ts", text: "let second = 2;" });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const { editor, element } = mount(ydoc);
    calls.highlight.mockClear();
    const updates = vi.fn();
    ydoc.on("update", updates);
    const receive = (): void => {
      updates.mockClear();
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
      // Only the inbound update: decoration recomputation adds no write.
      expect(updates).toHaveBeenCalledTimes(1);
      expect(snapshotFragment(ydoc)).toEqual(snapshotFragment(peer));
      expect(exportMarkdown(ydoc, { frontmatter: false })).toBe(exportMarkdown(peer, { frontmatter: false }));
    };

    editBlock(peer, prose, "before", "a longer paragraph before the code");
    receive();
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);
    const shifted = blockPosition(editor, first);
    const inserted = insertBlock(peer, null, { type: "paragraph", text: "new above" });
    receive();
    expect(blockPosition(editor, first)).toBeGreaterThan(shifted);
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);
    deleteBlock(peer, inserted);
    receive();
    expect(blockPosition(editor, first)).toBe(shifted);
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);

    createAnnotation(peer, first, 0, 5, "reviewer", "keyword comment");
    receive();
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const", "let"]);

    setBlockLanguage(peer, first, "javascript");
    receive();
    expect(calls.highlight.mock.calls).toEqual([["javascript", "const first = 1;"]]);
    expectKeywords(element, ["const", "let"]);
    calls.highlight.mockClear();
    editBlock(peer, second, "let second = 2;", "const second = 20;");
    receive();
    expect(calls.highlight.mock.calls).toEqual([["ts", "const second = 20;"]]);
    expectKeywords(element, ["const", "const"]);
    calls.highlight.mockClear();
    deleteBlock(peer, first);
    receive();
    expect(calls.highlight).not.toHaveBeenCalled();
    expectKeywords(element, ["const"]);
    peer.destroy();
  });
});

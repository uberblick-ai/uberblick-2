/**
 * Syntax highlighting is a view of source, never document content.
 *
 * These checks pin the bundled grammar boundary, alias handling, remote redraw
 * and coexistence with the one mark source blocks may store. CSS appearance is
 * left to the browser proof; this file defends the document invariant.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  exportMarkdown,
  initDoc,
  setBlockLanguage,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { threadIdFromTarget } from "../src/ui/threads.js";
import { mountEditor, snapshotFragment } from "./helpers.js";

const editors: Editor[] = [];

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
});

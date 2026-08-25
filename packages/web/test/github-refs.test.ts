/**
 * GitHub issue/PR links, shortened for display (#58).
 *
 * Two contracts, and the second is the one that matters:
 *
 * 1. {@link shortGitHubRef} shortens a canonical issue or PR URL and nothing
 *    else — same repo `#62`, another repo `org/repo#62`, everything else
 *    `null`, which is how "untouched" is spelled.
 * 2. The document is not edited. A pasted URL *renders* short while the Y.Doc
 *    goes on holding the full URL as both the text and the link's href — which
 *    is what agents read and what `export_markdown` emits. The editor tests
 *    read the document back through the schema package to say so.
 *
 * The fixtures are built with the schema package rather than by pasting: a
 * paste of a bare URL leaves exactly this state behind — the link mark's paste
 * rule takes the matched URL as both the text and the href (see marks.ts) —
 * and jsdom has no `ClipboardEvent` to drive Tiptap's paste plumbing with. What
 * is under test here is what the editor draws over that state, not how the
 * state got there.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  getBlockInline,
  getBlockText,
  initDoc,
} from "@uberblick/schema";
import { GITHUB_REPO } from "../src/config.js";
import { shortGitHubRef } from "../src/editor/github-refs.js";
import { mountEditor } from "./helpers.js";

const PR = `https://github.com/${GITHUB_REPO}/pull/62`;
const ISSUE = `https://github.com/${GITHUB_REPO}/issues/58`;
const FOREIGN = "https://github.com/yjs/yjs/issues/1234";

describe("shortGitHubRef", () => {
  it.each([
    [PR, "#62"],
    [ISSUE, "#58"],
    [FOREIGN, "yjs/yjs#1234"],
  ])("shortens %s to %s", (href, expected) => {
    expect(shortGitHubRef(href)).toBe(expected);
  });

  it.each([
    // Not GitHub at all.
    ["https://example.com/uberblick-ai/uberblick-2/pull/62"],
    // GitHub, but not an issue or a PR.
    ["https://github.com/uberblick-ai/uberblick-2/tree/main/packages/web"],
    // Points *into* a pull request rather than at it — `#62` would say
    // something the link does not.
    ["https://github.com/uberblick-ai/uberblick-2/pull/62#issuecomment-1"],
    // Not a URL at all, which is the one input that would throw rather than
    // decline.
    ["not a url"],
  ])("leaves %s alone", (href) => {
    expect(shortGitHubRef(href)).toBeNull();
  });
});

let editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
});

interface Mounted {
  ydoc: Y.Doc;
  id: string;
  editor: Editor;
  element: HTMLElement;
}

/** The document position at the start of block `index`. */
function startOf(editor: Editor, index: number): number {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos;
}

/**
 * A linked paragraph, plus an empty one to park the caret in — the caret
 * inside a link is itself a case, so no test may leave it there by accident.
 */
function mount(text: string, href: string): Mounted {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "gh-refs-doc", title: "Refs" });
  const id = appendBlock(ydoc, {
    type: "paragraph",
    inline: [{ text, marks: { link: href } }],
  });
  appendBlock(ydoc, { type: "paragraph", text: "" });
  const { editor, element } = mountEditor(ydoc);
  editors.push(editor);
  editor.commands.setTextSelection(startOf(editor, 1));
  return { ydoc, id, editor, element };
}

/** The shortened reference on screen, or `null` when nothing is shortened. */
function reference(element: HTMLElement): HTMLAnchorElement | null {
  return element.querySelector<HTMLAnchorElement>("a.ub-gh-ref");
}

/** The link the document actually holds, as the reader sees it drawn. */
function linkText(element: HTMLElement): string | undefined {
  return element.querySelector<HTMLAnchorElement>("a.ub-link:not(.ub-gh-ref)")
    ?.textContent ?? undefined;
}

describe("a pasted GitHub link", () => {
  it("renders as #N while the document keeps the URL", () => {
    const { ydoc, id, element } = mount(PR, PR);

    const ref = reference(element);
    expect(ref?.textContent).toBe("#62");
    // Hover and click still reach the real thing.
    expect(ref?.getAttribute("href")).toBe(PR);
    // The URL is hidden, not removed: a decoration cannot delete text, and this
    // asserts that none was.
    expect(element.querySelector(".ub-gh-url")?.textContent).toBe(PR);

    // The deliverable. What an agent reads and what `export_markdown` emits is
    // this, and it is the full URL.
    expect(getBlockText(ydoc, id)).toBe(PR);
    expect(getBlockInline(ydoc, id)).toEqual([{ text: PR, marks: { link: PR } }]);
  });

  it("names the repository when it is not this one", () => {
    const { element } = mount(FOREIGN, FOREIGN);
    expect(reference(element)?.textContent).toBe("yjs/yjs#1234");
  });

  it("leaves a link that is not an issue or a PR alone", () => {
    const url = "https://github.com/yjs/yjs";
    const { element } = mount(url, url);
    expect(reference(element)).toBeNull();
    expect(linkText(element)).toBe(url);
  });

  /**
   * A comment splits the link into two text nodes, neither of which is the
   * whole URL. It is still one link whose text is its href, and a reference
   * that went long here would do so for a reason no reader could see.
   *
   * The wrapper is the second half of it: the reference is drawn inside the
   * marks in force where it sits, so an annotated URL reads `#62` *and* is
   * still the thing a reader clicks to reach the thread.
   */
  it("is still one reference, inside the comment, when a comment splits it", () => {
    const { ydoc, id, editor, element } = mount(PR, PR);
    const annotation = createAnnotation(ydoc, id, 0, 10, "tester", "which PR?");
    editor.commands.setTextSelection(startOf(editor, 1));

    const ref = reference(element);
    expect(ref?.textContent).toBe("#62");
    expect(ref?.closest("span[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(
      annotation.id,
    );
    expect(getBlockText(ydoc, id)).toBe(PR);
  });

  it("keeps a label the reader wrote", () => {
    const { ydoc, id, element } = mount("the fix", PR);
    expect(reference(element)).toBeNull();
    expect(linkText(element)).toBe("the fix");
    expect(getBlockText(ydoc, id)).toBe("the fix");
  });

  it("shows the URL again while the caret is in it", () => {
    const { editor, element } = mount(PR, PR);
    expect(reference(element)).not.toBeNull();

    // Into the middle of the link: a reader who cannot see the text they are
    // editing cannot edit it.
    editor.commands.setTextSelection(startOf(editor, 0) + 4);
    expect(reference(element)).toBeNull();
    expect(element.querySelector(".ub-gh-url")).toBeNull();
    expect(linkText(element)).toBe(PR);

    // And back out again.
    editor.commands.setTextSelection(startOf(editor, 1));
    expect(reference(element)?.textContent).toBe("#62");
  });
});

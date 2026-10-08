/**
 * Inline document references in the browser (#444).
 *
 * Four contracts, and they are the whole file:
 *
 * 1. **A reference stores a uuid and nothing else.** Whatever door it came in
 *    through — typed, pasted as markdown, pasted as content from another
 *    document — what lands in the Y.Doc is a `docLink` under its bare key with a
 *    canonical uuid, and the label beside it is ordinary text. A hashed key or a
 *    smuggled `href` would both be the document meaning something the schema
 *    package cannot read.
 * 2. **The shorthand borrows a label once.** `[<uuid>]` takes the title the
 *    directory advertises at that moment, as *text*; a target the directory
 *    cannot name contributes its uuid, so nothing is ever written label-less.
 * 3. **Availability is re-read, never stored.** Unresolved and archived are two
 *    different things, both re-evaluated when the directory changes, over the
 *    directory room alone.
 * 4. **One gesture, one action.** A click on a reference follows it; a click on
 *    the comment highlight around it opens the thread; a modified click is the
 *    browser's.
 *
 * Everything is read back out of the Y.Doc through the schema package, because
 * the document is the deliverable. What is *not* here: that a real browser
 * routes the click and that Back returns — `e2e/doc-link.spec.ts` — and the
 * two-replica merge of both link marks, which is #443's test in
 * `test/palette.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { act, renderSettled } from "./react-render.js";
import * as Y from "yjs";
import {
  appendBlock,
  getBlocks,
  getBlocksFragment,
  getMeta,
  initDoc,
  tombstoneDirectoryEntry,
  tableCellText,
  tableRows,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { createDocLinkContext } from "../src/editor/doc-links.js";
import type { DocLinkContext } from "../src/editor/doc-links.js";
import { EditorPane } from "../src/ui/EditorPane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import {
  mountEditor,
  pastePlainText,
  snapshotFragment,
  typeText,
} from "./helpers.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
/** The document every reference here points at. */
const TARGET = "0189abcd-2222-4333-8444-555566667777";
/** One the directory has never heard of. */
const UNKNOWN = "3f7d1e88-1111-4222-9333-444455556666";

/** A document with one empty paragraph, and the caret in it. */
function emptyDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC, title: "References" });
  appendBlock(ydoc, { type: "paragraph", text: "" });
  return ydoc;
}

function caretAtStart(editor: Editor): void {
  editor.commands.setTextSelection(1);
}

/** What ProseMirror's clipboard parser makes of an HTML fragment. */
function parsePastedHtml(html: string): Array<Record<string, unknown>> {
  const dom = new DOMParser().parseFromString(`<p>${html}</p>`, "text/html");
  const node = ProseMirrorDOMParser.fromSchema(uberblickSchema).parse(dom.body);
  const runs: Array<Record<string, unknown>> = [];
  node.descendants((child) => {
    if (child.isText) {
      runs.push({
        text: child.text ?? "",
        marks: child.marks.map((mark) => mark.type.name),
      });
    }
    return true;
  });
  return runs;
}

/** The first block's delta — text and marks together, as Yjs holds them. */
function delta(ydoc: Y.Doc): Array<Record<string, unknown>> {
  return snapshotFragment(ydoc)[0]?.delta ?? [];
}

/** A directory with a title for `TARGET`, and a context over it. */
function directoryWith(
  entries: Array<{ uuid: string; title: string }>,
): { directory: Y.Doc; context: DocLinkContext; opened: string[] } {
  const directory = new Y.Doc();
  for (const entry of entries) upsertDirectoryEntry(directory, entry);
  const opened: string[] = [];
  const context = createDocLinkContext({
    directory,
    href: (uuid) => `/${WORKSPACE}/${uuid}`,
    open: (uuid) => opened.push(uuid),
  });
  return { directory, context, opened };
}

describe("making a reference", () => {
  /**
   * The wire contract, through the door a person actually uses. The bare
   * `docLink` key is the assertion that matters: y-prosemirror writes a hashed
   * key for a mark that does not exclude itself, and the schema package reads
   * only the bare one — so a self-exclusion regression would show up here as a
   * document no MCP tool can see the reference in.
   */
  it("turns a typed [label](<uuid>) into a docLink, canonically", () => {
    const ydoc = emptyDoc();
    const { editor } = mountEditor(ydoc);
    try {
      caretAtStart(editor);
      // Shouted, because an upper-cased uuid names the same document and must
      // not become a second identity for it.
      typeText(editor, `see [the hub](${TARGET.toUpperCase()}) today`);

      expect(delta(ydoc)).toEqual([
        { insert: "see " },
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
        { insert: " today" },
      ]);
      // The label is text, and the target is not in it: `edit_block` still sees
      // the sentence a reader wrote.
      expect(getBlocks(ydoc)[0]?.text).toBe("see the hub today");
    } finally {
      editor.destroy();
    }
  });

  it("uses the same typed document link and workspace-derived anchor in a table cell", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC, title: "Cell references" });
    appendBlock(ydoc, { type: "table", text: "|  | other |\n| --- | --- |" });
    const { directory, context } = directoryWith([{ uuid: TARGET, title: "The hub" }]);
    const { editor, element } = mountEditor(ydoc, { docLinks: context });
    try {
      editor.commands.setTextSelection(4);
      typeText(editor, `see [the hub](${TARGET.toUpperCase()}) today`);
      const cell = tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement)[0]![0]!;
      expect(tableCellText(cell)!.toDelta()).toEqual([
        { insert: "see " },
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
        { insert: " today" },
      ]);
      const anchor = element.querySelector("th a.ub-doclink");
      expect(anchor?.getAttribute("href")).toBe(`/${WORKSPACE}/${TARGET}`);
      expect(anchor?.getAttribute("data-doc-link-state")).toBe("resolved");
    } finally { editor.destroy(); ydoc.destroy(); directory.destroy(); }
  });

  /** The external rule is untouched: a URL target is still an external link. */
  it("leaves [label](https://…) an external link", () => {
    const ydoc = emptyDoc();
    const { editor } = mountEditor(ydoc);
    try {
      caretAtStart(editor);
      typeText(editor, "[docs](https://example.com/a)");
      expect(delta(ydoc)).toEqual([
        {
          insert: "docs",
          attributes: { link: { href: "https://example.com/a" } },
        },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("fills the shorthand from the directory, and falls back to the uuid", () => {
    const ydoc = emptyDoc();
    const { context } = directoryWith([
      { uuid: TARGET, title: "Editorial contract" },
    ]);
    const { editor } = mountEditor(ydoc, { docLinks: context });
    try {
      caretAtStart(editor);
      typeText(editor, `[${TARGET}] and [${UNKNOWN}]`);

      expect(delta(ydoc)).toEqual([
        {
          insert: "Editorial contract",
          attributes: { docLink: { docId: TARGET } },
        },
        { insert: " and " },
        // Not empty, and not silent: a target this replica cannot name yet
        // shows the identity it was written with.
        { insert: UNKNOWN, attributes: { docLink: { docId: UNKNOWN } } },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * A directory title is somebody else's writing, and this is the one path that
   * copies it into a document. `schema.text` cannot make it anything but text —
   * asserted through the rendered DOM, because that is where it would matter.
   */
  it("inserts a directory title as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const ydoc = emptyDoc();
    const { context } = directoryWith([{ uuid: TARGET, title: hostile }]);
    const { editor, element } = mountEditor(ydoc, { docLinks: context });
    try {
      caretAtStart(editor);
      typeText(editor, `[${TARGET}]`);

      expect(getBlocks(ydoc)[0]?.text).toBe(hostile);
      expect(element.querySelector("img")).toBeNull();
      expect(element.querySelector("a.ub-doclink")?.textContent).toBe(hostile);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Source blocks hold source. Both doors are asked, because they are two
   * different runners with two different reasons for standing down — and a
   * reference inside a `code` block would be a mark the schema forbids there,
   * which is a document the editor then refuses to bind at all.
   */
  it("writes no reference inside a code block, typed or pasted", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC, title: "Sources" });
    appendBlock(ydoc, { type: "code", text: "", language: "md" });
    const { context } = directoryWith([{ uuid: TARGET, title: "The hub" }]);
    const { editor } = mountEditor(ydoc, { docLinks: context });
    try {
      caretAtStart(editor);
      typeText(editor, `[a](${TARGET})`);
      pastePlainText(editor, ` [${TARGET}]`);

      expect(getBlocks(ydoc)[0]?.text).toBe(`[a](${TARGET}) [${TARGET}]`);
      expect(delta(ydoc)).toEqual([
        { insert: `[a](${TARGET}) [${TARGET}]` },
      ]);
    } finally {
      editor.destroy();
    }
  });
});

describe("pasting a reference", () => {
  it("reads both markdown spellings out of pasted plain text", () => {
    const ydoc = emptyDoc();
    const { context } = directoryWith([
      { uuid: TARGET, title: "Editorial contract" },
    ]);
    const { editor } = mountEditor(ydoc, { docLinks: context });
    try {
      caretAtStart(editor);
      pastePlainText(editor, `see [the hub](${TARGET}) and [${TARGET}]`);

      expect(delta(ydoc)).toEqual([
        { insert: "see " },
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
        { insert: " and " },
        {
          insert: "Editorial contract",
          attributes: { docLink: { docId: TARGET } },
        },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Content copied out of another document, which is a `docLink` already: the
   * identity has to survive, and the address it was rendered with must not be
   * read back as an external link — a `link` is `http(s)` and an in-app path is
   * not one.
   */
  it("keeps the identity of pasted content, and trusts no href", () => {
    const ydoc = emptyDoc();
    const { editor } = mountEditor(ydoc);
    try {
      caretAtStart(editor);
      editor.commands.insertContent(
        `<a href="/${WORKSPACE}/${TARGET}" data-doc-id="${TARGET.toUpperCase()}">the hub</a>`,
      );
      expect(delta(ydoc)).toEqual([
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * The two doors on one element. A pasted anchor can carry both a valid
   * `data-doc-id` and an href, and `link` is declared before `docLink` — so
   * without a rule precedence the general `a[href]` door consumes it first and
   * the reference becomes a link to whatever the clipboard said. A
   * `data-doc-id` that is not a document is not a reference at all, and still
   * falls through to that same external door.
   */
  it("prefers a valid document reference over the href beside it", () => {
    const ydoc = emptyDoc();
    const { editor } = mountEditor(ydoc);
    try {
      caretAtStart(editor);
      editor.commands.insertContent(
        `<a data-doc-id="${TARGET}" href="https://evil.example/">the hub</a>` +
          '<a data-doc-id="../../etc/passwd" href="https://example.com/">elsewhere</a>',
      );
      expect(delta(ydoc)).toEqual([
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
        {
          insert: "elsewhere",
          attributes: { link: { href: "https://example.com/" } },
        },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Asked of the clipboard parser itself, which is the door pasted HTML comes
   * through: the text survives, the mark does not, and nothing downstream is
   * handed a target nobody validated.
   */
  it("refuses a pasted target that is not a document", () => {
    expect(
      parsePastedHtml(
        '<a data-doc-id="javascript:alert(1)">one</a>' +
          '<a data-doc-id="../../etc/passwd">two</a>' +
          `<a data-doc-id="${TARGET}">three</a>`,
      ),
      // Two refused anchors and one accepted. The refused text arrives as a
      // single unmarked run, because nothing separates it any more.
    ).toEqual([
      { text: "onetwo", marks: [] },
      { text: "three", marks: ["docLink"] },
    ]);
  });
});

describe("what a reference says about its target", () => {
  /**
   * Availability is read from the directory on every change and stored nowhere,
   * which is what lets an unresolved link become a resolved one when the
   * directory finally syncs — without the document being rewritten, and without
   * the target's own room ever being opened (this test has no such room, and
   * the anchor resolves anyway).
   */
  it("tells unresolved from archived, live, and keeps the same anchor", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC, title: "References" });
    appendBlock(ydoc, {
      type: "paragraph",
      inline: [{ text: "the hub", marks: { docLink: TARGET } }],
    });
    const { directory, context } = directoryWith([]);
    const { editor, element } = mountEditor(ydoc, { docLinks: context });
    try {
      const anchor = element.querySelector<HTMLAnchorElement>("a.ub-doclink");
      // A real anchor with a real address, derived from the workspace on
      // screen — which is what makes cmd-click a new tab.
      expect(anchor?.getAttribute("href")).toBe(`/${WORKSPACE}/${TARGET}`);
      expect(anchor?.getAttribute("data-doc-link-state")).toBe("unresolved");
      expect(anchor?.getAttribute("title")).toBe(
        "This document has not reached this page's directory yet — the link opens it as soon as it arrives.",
      );

      upsertDirectoryEntry(directory, { uuid: TARGET, title: "The hub" });
      expect(anchor?.getAttribute("data-doc-link-state")).toBe("resolved");
      expect(anchor?.getAttribute("title")).toBeNull();

      // A tombstone is not an absence: the document is still readable, and the
      // link still opens it — it just says which of the two it is.
      tombstoneDirectoryEntry(directory, TARGET);
      expect(anchor?.getAttribute("data-doc-link-state")).toBe("archived");

      // The same element throughout: a restyle is a repaint, not a rebind, so
      // nothing under the reader's caret was torn down.
      expect(element.querySelector("a.ub-doclink")).toBe(anchor);
      // And the document was not rewritten by any of it.
      expect(delta(ydoc)).toEqual([
        { insert: "the hub", attributes: { docLink: { docId: TARGET } } },
      ]);
    } finally {
      editor.destroy();
    }
  });
});

const LIVE: RoomStatus = {
  connected: true,
  synced: true,
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function connectionFor(
  ydoc: Y.Doc,
  status: RoomStatus = LIVE,
): RoomConnection {
  return {
    room: `${WORKSPACE}/${DOC}`,
    ydoc,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}

describe("an unwritable document room", () => {
  it("keeps every document-local editor surface read-only and says not saved", async () => {
    const ydoc = emptyDoc();
    const connection = connectionFor(ydoc, {
      ...LIVE,
      connected: false,
      synced: false,
      writable: false,
    });
    const { container: host } = await renderSettled(
      <EditorPane
        connection={connection}
        segment={WORKSPACE}
        presence={[]}
        author="tester"
        archived={false}
        docLinks={null}
        onRestore={() => {}}
        onSelectThread={() => {}}
      />,
    );
    const title = host.querySelector<HTMLInputElement>(".ub-title");
    expect(title?.readOnly).toBe(true);
    expect(host.querySelector(".ub-tag-add")).toBeNull();
    expect(host.querySelector(".ub-editor [contenteditable=true]")).toBeNull();
    expect(
      host.querySelector('.ub-editor [role="textbox"]')?.getAttribute("aria-readonly"),
    ).toBe("true");
    expect(host.querySelector(".ub-status")?.textContent).toContain("not saved");

    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(title, "Browser only");
    act(() => title?.dispatchEvent(new Event("input", { bubbles: true })));
    expect(getMeta(ydoc).title).toBe("References");
  });
});

describe("following a reference", () => {
  /**
   * The overlap is the point. A `comment` highlight and a `docLink` can cover
   * the same words, and both are read by delegation on the same host element —
   * so one click could plausibly navigate *and* open a thread. The reference
   * wins on the words it covers, the highlight keeps everything else, and a
   * modified click is left to the browser, which is what the real `href` on the
   * anchor is for.
   */
  it("navigates in-app, and never also opens the thread it sits in", async () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC, title: "References" });
    appendBlock(ydoc, {
      type: "paragraph",
      inline: [
        { text: "see ", marks: {} },
        { text: "the hub", marks: { docLink: TARGET } },
      ],
    });
    // The whole sentence is annotated, so the highlight really does wrap the
    // reference rather than merely sitting beside it.
    const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    (block.firstChild as Y.XmlText).format(0, 11, {
      comment: { threadId: "t-1" },
    });

    const { directory, context, opened } = directoryWith([
      { uuid: TARGET, title: "The hub" },
    ]);
    const selected: string[] = [];
    const { container: host } = await renderSettled(
      <EditorPane
        connection={connectionFor(ydoc)}
        segment={WORKSPACE}
        presence={[]}
        author="tester"
        archived={false}
        docLinks={context}
        onRestore={() => {}}
        onSelectThread={(threadId) => selected.push(threadId)}
      />,
    );

    const anchor = host.querySelector<HTMLAnchorElement>("a.ub-doclink");
    expect(anchor?.textContent).toBe("the hub");

    const click = (
      target: Element | null | undefined,
      init: MouseEventInit = {},
    ): MouseEvent => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        target?.dispatchEvent(event);
      });
      return event;
    };

    // ---- the reference owns its own words ----
    const followed = click(anchor);
    expect(opened).toEqual([TARGET]);
    expect(selected).toEqual([]);
    // The app navigated, so the browser must not: a real anchor would
    // otherwise reload the whole client on its href.
    expect(followed.defaultPrevented).toBe(true);

    // ---- a modified click is the browser's ----
    // Read whether the app left it alone once it has bubbled past the app,
    // then stand in for the browser: jsdom cannot open a new tab, and logs
    // "Not implemented: navigation" when a click asks it to.
    let leftToBrowser: boolean | undefined;
    window.addEventListener(
      "click",
      (event) => {
        leftToBrowser = !event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    click(anchor, { metaKey: true });
    expect(opened).toEqual([TARGET]);
    expect(leftToBrowser).toBe(true);

    // ---- and the thread is still reachable from the rest of the highlight ----
    const highlight = host.querySelector("[data-comment-thread]");
    expect(highlight).not.toBeNull();
    click(highlight);
    expect(selected).toEqual(["t-1"]);
    expect(opened).toEqual([TARGET]);

    // ---- and an archived target is still somewhere you can go ----
    // Archiving says which document this is, not whether it opens: the read
    // view is still the destination (#146), so the click keeps navigating.
    tombstoneDirectoryEntry(directory, TARGET);
    expect(anchor?.getAttribute("data-doc-link-state")).toBe("archived");
    expect(click(anchor).defaultPrevented).toBe(true);
    expect(opened).toEqual([TARGET, TARGET]);
  });
});

/**
 * Comment threads, write side: starting one from a selection, replying to one,
 * and resolving one.
 *
 * Everything is read back out of a real Y.Doc through the schema package, and
 * the second replica is the one that matters — a comment nobody else can see is
 * not a comment. The UI's own state is asserted only where it *is* the contract:
 * the rail's open count, and the resolved range fading in the prose.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act, render } from "./react-render.js";
import { screen, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  exportMarkdown,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  setAnnotationResolved,
  tableCellText,
  tableRows,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { CommentComposer } from "../src/ui/CommentComposer.js";
import { ThreadsPane } from "../src/ui/ThreadsPane.js";
import { cellTextTargetOf, commentTargetOf } from "../src/editor/selection.js";
import { withMention } from "../src/ui/CommentForm.js";
import { resolvedHighlightCss } from "../src/ui/threads.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor, snapshotFragment } from "./helpers.js";
import { useThreads } from "../src/ui/hooks.js";

/**
 * `ThreadsPane` over a live document — the wiring the app shell provides.
 *
 * The pane takes its threads as a prop now (the shell observes them once, for
 * the rail and the pane-edge handle together), so a test that mutates the
 * document under a mounted rail has to supply the same subscription. This is
 * that subscription, and it is the app's own hook doing it.
 */
function LiveThreadsPane(
  props: Omit<ComponentProps<typeof ThreadsPane>, "threads">,
): ReactElement | null {
  return <ThreadsPane {...props} threads={useThreads(props.connection)} />;
}


/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/** Offsets used below: "quick brown" is [4, 15), "jumps" is [20, 25). */
const PARAGRAPH = "The quick brown fox jumps.";

function annotatedDoc(): { ydoc: Y.Doc; blocks: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Annotated" });
  appendBlock(ydoc, { type: "heading", text: "Sync", level: 2 });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  appendBlock(ydoc, { type: "paragraph", text: "Second paragraph." });
  return { ydoc, blocks: getBlocks(ydoc).map((block) => block.id) };
}

/** A second replica, connected the way the hub connects two clients. */
function mirrorOf(local: Y.Doc): Y.Doc {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return remote;
}

/** Exchange state between two replicas that have been editing apart. */
function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** The rail reads the Y.Doc and nothing else. */
function stubConnection(ydoc: Y.Doc): RoomConnection {
  return {
    room: `${WORKSPACE}/doc-1`,
    ydoc,
    status: { writable: true },
  } as unknown as RoomConnection;
}

/** The document position of `offset` characters into block `index`. */
function posIn(editor: Editor, index: number, offset: number): number {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos + offset;
}

/**
 * Select a range, the way a reader dragging over the prose does — within one
 * block, or on into a later one by naming `toBlock`. Inside `act` because the
 * composer listens to the editor: the selection is what makes it appear.
 */
function select(
  editor: Editor,
  block: number,
  from: number,
  to: number,
  toBlock = block,
): void {
  act(() => {
    editor.commands.setTextSelection({
      from: posIn(editor, block, from),
      to: posIn(editor, toBlock, to),
    });
  });
}

/**
 * Run a gesture and let the rail catch up. The rail's observer coalesces onto a
 * microtask — one recompute per transaction, however many things it touched —
 * so a write is on screen only after that microtask has run.
 */
async function settle(gesture: () => void): Promise<void> {
  await act(async () => {
    gesture();
  });
}

/** The confirming key may arrive either side of compositionend. */
function composingKey(
  field: HTMLTextAreaElement | HTMLInputElement,
  key: string,
  afterCompositionEnd: boolean,
): void {
  act(() => {
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    if (afterCompositionEnd) {
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }
    field.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: !afterCompositionEnd,
      ...(afterCompositionEnd ? { keyCode: 229 } : {}),
    }));
    if (!afterCompositionEnd) {
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

/** Mount the composer over a mounted editor, and drive it the way a reader does. */
function mountComposer(
  ydoc: Y.Doc,
  options: { author?: string; mentions?: string[]; contentReadOnly?: boolean } = {},
): {
  editor: Editor;
  created: string[];
  open: () => void;
  type: (text: string) => void;
  submit: () => void;
  unmount: () => void;
} {
  const { editor, element } = mountEditor(ydoc);
  const created: string[] = [];
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  const view = render(
    <CommentComposer
      editor={editor}
      contentReadOnly={options.contentReadOnly ?? false}
      ydoc={ydoc}
      author={options.author ?? "ben"}
      mentions={options.mentions ?? []}
      host={{ current: frame }}
      onCreated={(threadId) => created.push(threadId)}
    />,
    { container: frame },
  );
  return {
    editor,
    created,
    open: () => act(() => screen.getByRole<HTMLButtonElement>("button", { name: /^Comment(?: on .+)?$/ }).click()),
    type: (text: string) => {
      const field = screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /);
      if (field === null) throw new Error("no composer field");
      act(() => {
        // React listens for `input`, and setting `.value` skips its tracker.
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    submit: () =>
      act(() => {
        screen.getByRole<HTMLButtonElement>("button", { name: "Comment" }).click();
      }),
    unmount: () => {
      view.unmount();
      editor.destroy();
      element.remove();
    },
  };
}

describe("the selection a thread anchors to", () => {
  it("is the block and the character offsets the annotation API takes", () => {
    const { ydoc, blocks } = annotatedDoc();
    const { editor, element } = mountEditor(ydoc);
    try {
      expect(commentTargetOf(editor, ydoc)).toBeNull();

      select(editor, 1, 4, 15);
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
        blockId: blocks[1],
        start: 4,
        end: 15,
        text: "quick brown",
        blockType: "paragraph",
        blockIndex: 1,
        clamped: false,
      });
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  /**
   * A thread has exactly one anchor block, so a selection spanning several is
   * clamped to the first block of the range — and says so, which is what lets
   * the composer quote back exactly what it is about to mark.
   *
   * The *first block of the range*, not the block the gesture started in: the
   * target is read off `$from`, so a backwards drag clamps to where it ended.
   * One rule for both directions, and it is the one a reader can check against
   * the highlight.
   */
  it("clamps a multi-block selection to the first block of the range", () => {
    const { ydoc, blocks } = annotatedDoc();
    const { editor, element } = mountEditor(ydoc);
    try {
      // From inside the first block, on into the next one.
      select(editor, 1, 20, 6, 2);
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
        blockId: blocks[1],
        start: 20,
        end: PARAGRAPH.length,
        text: "jumps.",
        clamped: true,
      });

      // The same range dragged the other way: anchor in the later block, head
      // in the earlier one.
      act(() => {
        const { state } = editor;
        editor.view.dispatch(
          state.tr.setSelection(
            TextSelection.create(state.doc, posIn(editor, 2, 6), posIn(editor, 1, 20)),
          ),
        );
      });
      expect(editor.state.selection.anchor).toBeGreaterThan(
        editor.state.selection.head,
      );
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
        blockId: blocks[1],
        start: 20,
        end: PARAGRAPH.length,
        text: "jumps.",
        clamped: true,
      });
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  /**
   * The palette gate runs once, before the editor binds, so it cannot speak for
   * a shape that arrives afterwards — and a block element holding two Y.XmlText
   * children passes it anyway, since both children are plain text carrying
   * declared marks. ProseMirror then shows the two texts as one run while the
   * annotation API indexes only the first, so every offset read off the editor
   * would name the wrong characters. Nothing is offered on such a block.
   */
  it("refuses a block whose Y text the editor is not showing one-for-one", () => {
    const { ydoc } = annotatedDoc();
    const { editor, element: host } = mountEditor(ydoc);
    try {
      // A peer writes a second Y.XmlText into the paragraph. The editor renders
      // "…jumps.BBBB", the schema still reads only up to the full stop.
      const remote = mirrorOf(ydoc);
      act(() => {
        const extra = new Y.XmlText();
        extra.insert(0, "BBBB");
        (getBlocksFragment(remote).get(1) as Y.XmlElement).insert(1, [extra]);
      });
      expect(editor.state.doc.child(1).textContent).toBe(`${PARAGRAPH}BBBB`);
      expect(getBlocks(ydoc)[1]?.text).toBe(PARAGRAPH);

      select(editor, 1, 4, 15);
      expect(commentTargetOf(editor, ydoc)).toBeNull();
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});

/** The unnamed portal frame has no accessible handle, across its three modes. */
function querySelectionComposer(): HTMLElement | null {
  // Positive assertions below exercise this same query before hiding the frame.
  // Checking the frame also catches an empty mounted composer, in any mode.
  return document.querySelector<HTMLElement>('[data-slot="selection-composer"]');
}

/** Scope quoted prose and clamp text to the portal, away from the editor. */
function commentComposer(): HTMLElement {
  const composer = querySelectionComposer();
  if (composer === null) throw new Error("no selection composer");
  return composer;
}

function tool(label: string): HTMLButtonElement {
  return within(screen.getByRole("toolbar", { name: "Text formatting and comment" }))
    .getByRole<HTMLButtonElement>("button", { name: label });
}

/** Change the link field through the browser event React listens to. */
function linkValue(value: string): void {
  const field = screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" });
  if (field === null) throw new Error("no external link field");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the prose selection toolbar", () => {
  it("shows full, empty and mixed mark state, and preserves compatible marks", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 9);
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("false");
      const selected = {
        from: view.editor.state.selection.from,
        to: view.editor.state.selection.to,
      };
      act(() => tool("Bold").click());
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("true");
      expect(view.editor.state.selection).toMatchObject(selected);

      // Extend from "quick" to "quick brown": one run carries bold and one
      // does not, so the button says mixed. Activating mixed applies it all.
      select(view.editor, 1, 4, 15);
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("mixed");
      act(() => tool("Bold").click());
      act(() => tool("Italic").click());
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("true");
      expect(tool("Italic").getAttribute("aria-pressed")).toBe("true");

      const marked = snapshotFragment(ydoc)[1]?.delta.find(
        (run) => run.insert === "quick brown",
      );
      expect(marked?.attributes).toMatchObject({ bold: {}, italic: {} });

      // A full-state click removes only its own mark.
      act(() => tool("Bold").click());
      const italic = snapshotFragment(ydoc)[1]?.delta.find(
        (run) => run.insert === "quick brown",
      );
      expect(italic?.attributes).toMatchObject({ italic: {} });
      expect(italic?.attributes).not.toHaveProperty("bold");
    } finally {
      view.unmount();
    }
  });

  it("keeps a toolbar command out of the nearby typing undo item", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      act(() => {
        view.editor.commands.setTextSelection(posIn(view.editor, 1, PARAGRAPH.length));
        view.editor.commands.insertContent(" Fresh");
      });
      select(view.editor, 1, 4, 15);
      // No timer or test-owned stopCapturing: the command owns the boundary.
      act(() => tool("Inline code").click());

      act(() => {
        expect(view.editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      });
      expect(getBlocks(ydoc)[1]?.text).toBe(`${PARAGRAPH} Fresh`);
      expect(
        snapshotFragment(ydoc)[1]?.delta.some(
          (run) =>
            typeof run.attributes === "object" &&
            run.attributes !== null &&
            "inlineCode" in run.attributes,
        ),
      ).toBe(false);

      act(() => {
        expect(view.editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      });
      expect(getBlocks(ydoc)[1]?.text).toBe(PARAGRAPH);
    } finally {
      view.unmount();
    }
  });

  it("creates and edits only http(s) links without replacing document links", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 15);
      act(() => tool("Bold").click());
      expect(tool("External link").getAttribute("aria-pressed")).toBeNull();
      act(() => tool("External link").click());
      linkValue("mailto:ben@example.com");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(screen.queryByRole("alert")?.textContent).toContain("http");
      expect(snapshotFragment(ydoc)[1]?.delta).not.toContainEqual(
        expect.objectContaining({ attributes: expect.objectContaining({ link: {} }) }),
      );

      linkValue("https://example.com/first");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      const linked = snapshotFragment(ydoc)[1]?.delta.find(
        (run) => run.insert === "quick brown",
      );
      expect(linked?.attributes).toMatchObject({
        bold: {},
        link: { href: "https://example.com/first" },
      });

      act(() => tool("External link").click());
      expect(screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" })?.value).toBe(
        "https://example.com/first",
      );
      linkValue("https://example.com/cancelled");
      act(() =>
        within(screen.getByRole("form", { name: "External link" })).queryByRole<HTMLButtonElement>("button", { name: "Cancel" })
          ?.click(),
      );
      expect(snapshotFragment(ydoc)[1]?.delta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            insert: "quick brown",
            attributes: expect.objectContaining({
              link: { href: "https://example.com/first" },
            }),
          }),
        ]),
      );

      act(() => tool("External link").click());
      linkValue("https://example.com/edited");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(
        snapshotFragment(ydoc)[1]?.delta.find(
          (run) => run.insert === "quick brown",
        )?.attributes,
      ).toMatchObject({ link: { href: "https://example.com/edited" } });

      const { from, to } = view.editor.state.selection;
      const docLink = view.editor.state.schema.marks.docLink;
      if (docLink === undefined) throw new Error("docLink mark is unavailable");
      act(() => {
        view.editor.view.dispatch(
          view.editor.state.tr.addMark(
            from,
            to,
            docLink.create({ docId: "11111111-2222-3333-4444-555555555555" }),
          ),
        );
      });
      act(() => tool("External link").click());
      linkValue("https://example.com/replacement");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(screen.queryByRole("alert")?.textContent).toContain(
        "document link",
      );
      expect(
        snapshotFragment(ydoc)[1]?.delta.find(
          (run) => run.insert === "quick brown",
        )?.attributes,
      ).toMatchObject({
        docLink: { docId: "11111111-2222-3333-4444-555555555555" },
      });
    } finally {
      view.unmount();
    }
  });

  it("keeps source and cross-block ranges on the Comment-only path", () => {
    const { ydoc } = annotatedDoc();
    appendBlock(ydoc, { type: "code", text: "const x = 1", language: "ts" });
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 20, 6, 2);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      expect(screen.queryByRole<HTMLButtonElement>("button", { name: /^Comment(?: on .+)?$/ })?.textContent).toBe(
        "Comment on Paragraph 2",
      );

      select(view.editor, 3, 0, 5);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      expect(screen.queryByRole<HTMLButtonElement>("button", { name: /^Comment(?: on .+)?$/ })?.textContent).toBe(
        "Comment on Code block 4",
      );
    } finally {
      view.unmount();
    }
  });

  it("leaves link mode when the selection changes to a cross-block range", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 15);
      act(() => tool("External link").click());
      linkValue("https://example.com/pending");
      expect(screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" })).not.toBeNull();

      select(view.editor, 1, 20, 6, 2);
      expect(screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" })).toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();

      select(view.editor, 1, 4, 15);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      expect(screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" })).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("dismisses on Escape and stays out of an active IME composition", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 15);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      view.open();
      // The form's unnamed div groups its field and actions; it has no role/name.
      expect(commentComposer().querySelector(".ub-comment-form")).not.toBeNull();
      act(() => {
        screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      expect(view.editor.state.selection.empty).toBe(false);

      act(() => {
        view.editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(querySelectionComposer()).toBeNull();
      expect(view.editor.state.selection.empty).toBe(false);

      // A transaction at the dismissed range must not reopen it; only a new
      // selection ends the dismissal.
      act(() => view.editor.view.dispatch(view.editor.state.tr));
      expect(querySelectionComposer()).toBeNull();

      select(view.editor, 1, 20, 25);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      act(() => {
        view.editor.view.dom.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
      });
      expect(querySelectionComposer()).toBeNull();
      act(() => {
        view.editor.view.dom.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        );
      });
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      expect(view.editor.state.selection.empty).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe("the table-cell selection toolbar", () => {
  const source = "| Alpha beta | **Neighbour** |\n| --- | --- |\n| Gamma delta | *Untouched* |";
  const flags = ["Bold", "Italic", "Strikethrough", "Inline code"];

  function tableDoc(): Y.Doc {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "cell-selection", title: "Cells" });
    appendBlock(ydoc, { type: "table", text: source });
    appendBlock(ydoc, { type: "paragraph", text: "After the table." });
    return ydoc;
  }

  /** Positions from the actual editor tree, header cells followed by body cells. */
  function cells(editor: Editor): Array<{ pos: number; start: number; length: number }> {
    const result: Array<{ pos: number; start: number; length: number }> = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
        result.push({ pos, start: pos + 2, length: node.textContent.length });
      }
    });
    return result;
  }

  function selectCell(editor: Editor, cell: number, from: number, to: number): void {
    const target = cells(editor)[cell]!;
    act(() => editor.commands.setTextSelection({
      from: target.start + from,
      to: target.start + to,
    }));
  }

  function cellDeltas(ydoc: Y.Doc): Array<Array<Record<string, unknown>>> {
    const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    return tableRows(table).flatMap((row) => row.map((cell) =>
      tableCellText(cell)!.toDelta() as Array<Record<string, unknown>>,
    ));
  }

  function key(editor: Editor, value: string, shiftKey = false): void {
    act(() => editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: value,
      shiftKey,
      bubbles: true,
      cancelable: true,
    })));
  }

  it.each([0, 2])("starts a replicated thread over exactly the selected cell %s text without changing table content", (index) => {
    const ydoc = tableDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc);
    try {
      const before = getBlocks(ydoc)[0]!;
      selectCell(view.editor, index, 0, 5);
      expect(within(screen.getByRole("toolbar", { name: "Text formatting and comment" }))
        .getAllByRole("button").at(-1)?.textContent).toBe("Comment");
      view.open();
      expect(within(commentComposer()).queryByText(index === 0 ? "Alpha" : "Gamma")?.textContent).toBe(index === 0 ? "Alpha" : "Gamma");
      view.type("Discuss these characters");
      view.submit();
      expect(view.created).toHaveLength(1);
      expect(listAnnotationRanges(remote, before.id)).toMatchObject([{
        threadId: view.created[0], row: index === 0 ? 0 : 1, column: 0, start: 0, end: 5,
      }]);
      expect(view.editor.view.dom.querySelector(`[data-comment-thread="${view.created[0]}"]`)?.textContent).toBe(index === 0 ? "Alpha" : "Gamma");
      expect(getBlocks(remote)[0]).toEqual(before);
    } finally { view.unmount(); remote.destroy(); ydoc.destroy(); }
  });

  it("clamps rectangular selections to the first covered cell even when neither endpoint is that cell", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    try {
      const positions = cells(view.editor);
      act(() => view.editor.view.dispatch(view.editor.state.tr.setSelection(
        CellSelection.create(view.editor.state.doc, positions[1]!.pos, positions[2]!.pos),
      )));
      expect(commentTargetOf(view.editor, ydoc)).toMatchObject({ row: 0, column: 0, text: "Alpha beta", clamped: true });
      view.open();
      view.type("First cell");
      view.submit();
      expect(listAnnotationRanges(ydoc, getBlocks(ydoc)[0]!.id)).toMatchObject([{
        row: 0, column: 0, start: 0, end: 10,
      }]);
    } finally { view.unmount(); ydoc.destroy(); }
  });

  it("anchors visible cell offsets across concurrent Y text children", () => {
    const ydoc = tableDoc();
    const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    const cell = tableRows(table)[1]![0]!;
    const paragraph = cell.firstChild as Y.XmlElement;
    ydoc.transact(() => {
      tableCellText(cell)!.delete(0, 11);
      tableCellText(cell)!.insert(0, "Gamma");
      const second = new Y.XmlText();
      paragraph.insert(1, [second]);
      second.insert(0, " delta");
    });
    const view = mountComposer(ydoc);
    try {
      selectCell(view.editor, 2, 3, 8);
      expect(commentTargetOf(view.editor, ydoc)).toMatchObject({ row: 1, column: 0, start: 3, end: 8, text: "ma de" });
      view.open();
      view.type("Across both text children");
      view.submit();
      expect(view.editor.view.dom.querySelector(`[data-comment-thread="${view.created[0]}"]`)?.textContent).toBe("ma de");
      expect(listAnnotationRanges(ydoc, getBlocks(ydoc)[0]!.id)).toMatchObject([{ row: 1, column: 0, start: 3, end: 8 }]);
    } finally { view.unmount(); ydoc.destroy(); }
  });

  it("names exact cell ranges and clamps cross-cell comments while refusing cross-cell formatting", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    const { editor } = view;
    try {
      const positions = cells(editor);
      expect(cellTextTargetOf(editor)).toBeNull();
      for (const index of [0, 2]) {
        selectCell(editor, index, 0, 5);
        expect(cellTextTargetOf(editor)).toMatchObject({
          kind: "cell",
          blockId: getBlocks(ydoc)[0]!.id,
          contentStart: positions[index]!.start,
          start: 0,
          end: 5,
          text: index === 0 ? "Alpha" : "Gamma",
        });
        expect(commentTargetOf(editor, ydoc)).toMatchObject({
          row: index === 0 ? 0 : 1, column: 0, start: 0, end: 5, clamped: false,
        });
      }

      // Triple click selects the cell itself, rather than a TextSelection.
      act(() => editor.view.dispatch(editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, positions[0]!.pos),
      )));
      expect(cellTextTargetOf(editor)).toMatchObject({ start: 0, end: 10, text: "Alpha beta" });
      act(() => tool("Bold").click());
      expect(editor.state.selection).toBeInstanceOf(CellSelection);
      expect(cellDeltas(ydoc)[0]).toEqual([{ insert: "Alpha beta", attributes: { bold: {} } }]);
      expect(cellDeltas(ydoc)[2]).toEqual([{ insert: "Gamma delta" }]);

      // Multi-cell selections expose ordinary endpoints only in their head
      // cell. The guard must inspect their actual coverage.
      const multi = CellSelection.create(editor.state.doc, positions[0]!.pos, positions[1]!.pos);
      expect(multi.$from.node(3)).toBe(multi.$to.node(3));
      act(() => editor.view.dispatch(editor.state.tr.setSelection(multi)));
      expect(cellTextTargetOf(editor)).toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      expect(commentTargetOf(editor, ydoc)).toMatchObject({ row: 0, column: 0, text: "Alpha beta", clamped: true });
      view.open();
      expect(within(commentComposer()).queryByText(/first (?:cell|block) only/)?.textContent).toBe("first cell only");
      expect(within(commentComposer()).queryByText("Alpha beta")?.textContent).toBe("Alpha beta");
      key(editor, "Escape");

      for (const [from, to] of [
        [positions[0]!.start + 2, positions[1]!.start + 3],
        [positions[1]!.start + 3, positions[0]!.start + 2],
        [positions[2]!.start + 2, posIn(editor, 1, 3)],
      ]) {
        act(() => editor.view.dispatch(editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, from!, to!),
        )));
        expect(cellTextTargetOf(editor)).toBeNull();
        expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
        expect(commentTargetOf(editor, ydoc)).toMatchObject({
          column: 0, start: 2, clamped: true,
          text: from === positions[2]!.start + 2 ? "mma delta" : "pha beta",
        });
      }
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

  it.each([0, 2])("formats only selected text in cell %s, reports mixed states and shares the existing cell marks", (index) => {
    const ydoc = tableDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc);
    try {
      const before = cellDeltas(ydoc);
      selectCell(view.editor, index, 0, 5);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })?.getAttribute("aria-label")).toBe("Text formatting and comment");
      expect(screen.queryByRole("button", { name: "Comment" })).not.toBeNull();
      expect(within(screen.getByRole("toolbar", { name: "Text formatting and comment" })).getAllByRole("button")).toHaveLength(6);
      const selection = { from: view.editor.state.selection.from, to: view.editor.state.selection.to };
      for (const label of flags) {
        expect(tool(label).getAttribute("aria-pressed")).toBe("false");
        act(() => tool(label).click());
        expect(tool(label).getAttribute("aria-pressed")).toBe("true");
        expect(view.editor.state.selection).toMatchObject(selection);
      }
      expect(cellDeltas(remote)[index]).toEqual([
        { insert: index === 0 ? "Alpha" : "Gamma", attributes: { bold: {}, italic: {}, strike: {}, inlineCode: {} } },
        { insert: index === 0 ? " beta" : " delta" },
      ]);
      for (const other of [0, 1, 2, 3].filter((cell) => cell !== index)) {
        expect(cellDeltas(remote)[other]).toEqual(before[other]);
      }
      expect(getBlocks(remote)[0]!.text).toBe(getBlocks(ydoc)[0]!.text);
      expect(exportMarkdown(remote, { frontmatter: false })).toBe(exportMarkdown(ydoc, { frontmatter: false }));
      expect(getBlocks(remote)[0]!.text).toContain(index === 0 ? "***~~`Alpha`~~*** beta" : "***~~`Gamma`~~*** delta");

      selectCell(view.editor, index, 0, cells(view.editor)[index]!.length);
      for (const label of flags) expect(tool(label).getAttribute("aria-pressed")).toBe("mixed");
      act(() => tool("Bold").click());
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("true");
      expect(tool("Italic").getAttribute("aria-pressed")).toBe("mixed");
      act(() => tool("Bold").click());
      expect(tool("Bold").getAttribute("aria-pressed")).toBe("false");
      expect(cellDeltas(remote)[index]?.[0]?.attributes).toEqual({ italic: {}, strike: {}, inlineCode: {} });
    } finally {
      view.unmount();
      remote.destroy();
      ydoc.destroy();
    }
  });

  it("rejects incomplete or non-http links and preserves a document link anywhere in the cell range", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    try {
      selectCell(view.editor, 2, 0, 5);
      act(() => tool("Bold").click());
      act(() => tool("External link").click());
      for (const invalid of ["https://", "mailto:ben@example.com"]) {
        linkValue(invalid);
        act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
        expect(screen.queryByRole("alert")?.textContent).toContain("http");
        expect(cellDeltas(ydoc)[2]?.[0]?.attributes).toEqual({ bold: {} });
      }
      linkValue("https://example.com/cell");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(cellDeltas(ydoc)[2]?.[0]?.attributes).toEqual({
        bold: {},
        link: { href: "https://example.com/cell" },
      });
      act(() => tool("External link").click());
      expect(screen.queryByRole<HTMLInputElement>("textbox", { name: "External link URL" })?.value).toBe("https://example.com/cell");
      linkValue("http://example.com/edited");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(cellDeltas(ydoc)[2]?.[0]?.attributes).toMatchObject({ link: { href: "http://example.com/edited" } });

      const target = cells(view.editor)[2]!;
      act(() => view.editor.view.dispatch(view.editor.state.tr.addMark(
        target.start,
        target.start + 2,
        view.editor.state.schema.marks.docLink!.create({ docId: "11111111-2222-3333-4444-555555555555" }),
      )));
      const before = cellDeltas(ydoc);
      act(() => tool("External link").click());
      linkValue("https://example.com/replacement");
      act(() => screen.queryByRole<HTMLButtonElement>("button", { name: "Apply" })?.click());
      expect(screen.queryByRole("alert")?.textContent).toContain("document link");
      expect(cellDeltas(ydoc)).toEqual(before);
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

  it("keeps each cell formatting action separate from typing on both sides in undo", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    const undo = (): void => act(() => { expect(view.editor.commands.keyboardShortcut("Mod-z")).toBe(true); });
    try {
      selectCell(view.editor, 0, 10, 10);
      act(() => view.editor.commands.insertContent("!"));
      selectCell(view.editor, 0, 0, 5);
      act(() => tool("Bold").click());
      act(() => tool("Italic").click());
      selectCell(view.editor, 0, 11, 11);
      act(() => view.editor.commands.insertContent("?"));

      undo();
      expect(cells(view.editor)[0]!.length).toBe(11);
      expect(cellDeltas(ydoc)[0]?.[0]?.attributes).toEqual({ bold: {}, italic: {} });
      undo();
      expect(cellDeltas(ydoc)[0]?.[0]?.attributes).toEqual({ bold: {} });
      expect(cells(view.editor)[0]!.length).toBe(11);
      undo();
      expect(cellDeltas(ydoc)[0]).toEqual([{ insert: "Alpha beta!" }]);
      undo();
      expect(getBlocks(ydoc)[0]!.text).toBe(source);
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

  it("tracks shortcuts, suppresses caret, Tab and composition chrome, and keeps cross-cell comments", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    try {
      expect(querySelectionComposer()).toBeNull();
      selectCell(view.editor, 0, 0, 0);
      expect(querySelectionComposer()).toBeNull();
      selectCell(view.editor, 0, 0, 5);
      for (const [shortcut, label] of [
        ["Mod-b", "Bold"], ["Mod-i", "Italic"],
        ["Mod-Shift-s", "Strikethrough"], ["Mod-e", "Inline code"],
      ]) {
        act(() => { expect(view.editor.commands.keyboardShortcut(shortcut!)).toBe(true); });
        expect(tool(label!).getAttribute("aria-pressed")).toBe("true");
      }
      key(view.editor, "Tab");
      expect(view.editor.state.selection.empty).toBe(false);
      expect(view.editor.state.doc.textBetween(view.editor.state.selection.from, view.editor.state.selection.to)).toBe("Neighbour");
      expect(querySelectionComposer()).toBeNull();
      // Touching a scrollport is pending input, not a new selection. Neither
      // an unchanged transaction nor a document edit may revive Tab's range.
      act(() => view.editor.view.dom.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      act(() => view.editor.view.dispatch(view.editor.state.tr));
      expect(querySelectionComposer()).toBeNull();
      const neighbour = cells(view.editor)[1]!;
      act(() => view.editor.view.dispatch(view.editor.state.tr.addMark(
        neighbour.start, neighbour.start + 1,
        view.editor.state.schema.marks.italic!.create(),
      )));
      expect(querySelectionComposer()).toBeNull();
      key(view.editor, "Tab", true);
      expect(view.editor.state.doc.textBetween(view.editor.state.selection.from, view.editor.state.selection.to)).toBe("Alpha beta");
      expect(querySelectionComposer()).toBeNull();

      // A deliberate new selection ends the navigation suppression.
      act(() => view.editor.view.dom.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      selectCell(view.editor, 0, 1, 5);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      const positions = cells(view.editor);
      act(() => view.editor.view.dispatch(view.editor.state.tr.setSelection(
        CellSelection.create(view.editor.state.doc, positions[0]!.pos, positions[1]!.pos),
      )));
      expect(querySelectionComposer()).not.toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      act(() => view.editor.view.dispatch(view.editor.state.tr.setSelection(
        TextSelection.create(view.editor.state.doc, positions[0]!.start + 1, positions[1]!.start + 2),
      )));
      expect(querySelectionComposer()).not.toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();

      selectCell(view.editor, 2, 0, 5);
      act(() => view.editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      expect(querySelectionComposer()).toBeNull();
      act(() => view.editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      selectCell(view.editor, 2, 5, 5);
      expect(querySelectionComposer()).toBeNull();
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

  it("keeps Escape dismissal in its cell and offers only Comment in read-only content", () => {
    const ydoc = tableDoc();
    const view = mountComposer(ydoc);
    try {
      selectCell(view.editor, 0, 0, 5);
      key(view.editor, "Escape");
      expect(view.editor.state.selection.empty).toBe(false);
      expect(querySelectionComposer()).toBeNull();
      act(() => view.editor.view.dispatch(view.editor.state.tr));
      expect(querySelectionComposer()).toBeNull();
      // Same offsets and table id, a different cell: Escape must not leak.
      selectCell(view.editor, 2, 0, 5);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      act(() => view.editor.setEditable(false));
      selectCell(view.editor, 2, 1, 5);
      expect(querySelectionComposer()).not.toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      expect(getBlocks(ydoc)[0]!.text).toBe(source);
    } finally {
      view.unmount();
    }

    const decided = mountComposer(ydoc, { contentReadOnly: true });
    try {
      selectCell(decided.editor, 0, 0, 5);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).toBeNull();
      expect(screen.queryByRole<HTMLButtonElement>("button", { name: "Comment" })?.textContent).toBe("Comment");
      decided.open();
      decided.type("Still discussable");
      decided.submit();
      expect(getBlocks(ydoc)[0]!.text).toBe(source);
      expect(listAnnotationRanges(ydoc, getBlocks(ydoc)[0]!.id)).toMatchObject([{ row: 0, column: 0, start: 0, end: 5 }]);
      expect(decided.created).toHaveLength(1);
    } finally {
      decided.unmount();
      ydoc.destroy();
    }
  });
});

describe("starting a thread from the prose", () => {
  // Safari's order, which only the IME keyCode still marks as composing.
  it("keeps a composing Enter after compositionend in the comment field, then sends on Enter", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("日本語のコメント");
      const field = screen.getByPlaceholderText<HTMLTextAreaElement>(/^Comment as /);

      composingKey(field, "Enter", true);
      expect(listAnnotations(ydoc)).toEqual([]);
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)).toBe(field);
      expect(field.value).toBe("日本語のコメント");
      expect(document.activeElement).toBe(field);

      act(() => field.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", shiftKey: true, bubbles: true, cancelable: true,
      })));
      expect(listAnnotations(ydoc)).toEqual([]);
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)).toBe(field);

      act(() => field.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true,
      })));
      expect(listAnnotations(ydoc)).toHaveLength(1);
      expect(listAnnotations(ydoc)[0]?.comments[0]?.text).toBe("日本語のコメント");
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("keeps a composing Escape before compositionend in the comment field, then returns to the toolbar", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("日本語のコメント");
      const field = screen.getByPlaceholderText<HTMLTextAreaElement>(/^Comment as /);

      // Dispatch through the composer frame, whose capture listener sees
      // Escape before the field's own handler can preserve the draft.
      composingKey(field, "Escape", false);
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)).toBe(field);
      expect(field.value).toBe("日本語のコメント");
      expect(document.activeElement).toBe(field);
      expect(listAnnotations(ydoc)).toEqual([]);

      act(() => field.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      })));
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)).toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("marks the selected range and shows the thread to a second client", () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc, { author: "ben" });
    try {
      // No selection, no composer.
      expect(querySelectionComposer()).toBeNull();

      select(view.editor, 1, 4, 15);
      expect(screen.queryByRole("toolbar", { name: "Text formatting and comment" })).not.toBeNull();
      expect(screen.queryByRole<HTMLButtonElement>("button", { name: /^Comment(?: on .+)?$/ })?.textContent).toBe("Comment");

      view.open();
      // The card quotes exactly the range the mark will cover.
      expect(within(commentComposer()).queryByText("quick brown")?.textContent).toBe("quick brown");
      view.type("why quick?");
      view.submit();

      const [thread] = listAnnotations(ydoc);
      expect(thread).toMatchObject({ blockId: blocks[1] });
      expect(thread?.comments).toEqual([
        { author: "ben", text: "why quick?", createdAt: expect.any(String) },
      ]);
      expect(view.created).toEqual([thread?.id]);

      // The mark is on the range, and the second replica has both halves of it.
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 4, end: 15 },
      ]);
      expect(getAnnotation(remote, thread!.id)?.comments).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

  /**
   * A refusal is not a reason to lose what someone wrote. The error names the
   * range, so it goes when the reader aims at another one, and the comment
   * itself waits in the field for the range that will take it.
   */
  it("refuses a range that already belongs to another thread, and keeps the text", () => {
    const { ydoc, blocks } = annotatedDoc();
    createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "mine");
    const view = mountComposer(ydoc, { author: "ben" });
    try {
      // Overlapping the existing thread by a single character is enough.
      select(view.editor, 1, 10, 19);
      view.open();
      view.type("mine too");
      view.submit();

      expect(listAnnotations(ydoc)).toHaveLength(1);
      expect(within(commentComposer()).queryByText(/already part of another thread/)?.textContent).toContain(
        "already part of another thread",
      );
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)?.value).toBe(
        "mine too",
      );

      // Aim at a free range and the refusal no longer applies…
      select(view.editor, 1, 20, 25);
      expect(within(commentComposer()).queryByText(/already part of another thread/)).toBeNull();
      // …and the same text, never retyped, lands there.
      view.submit();
      expect(
        listAnnotations(ydoc).find((thread) => thread.comments[0]?.author === "ben")
          ?.comments[0]?.text,
      ).toBe("mine too");
      expect(listAnnotationRanges(ydoc, blocks[1]!)).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });

  /**
   * Everything on the card is derived from the selection as it stands *now*.
   * Extending a selection off the end of its first block changes neither the
   * offsets nor the quoted text — only whether the range is being clamped — so
   * a card that re-reads only when those change would go on claiming it was
   * annotating the whole gesture.
   */
  it("re-reads the target on every transaction, so the clamp shows up", () => {
    const { ydoc, blocks } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      // "jumps." — the tail of the block, so running past it leaves start, end
      // and quoted text exactly as they were.
      select(view.editor, 1, 20, PARAGRAPH.length);
      view.open();
      expect(within(commentComposer()).queryByText(/first (?:cell|block) only/)).toBeNull();

      select(view.editor, 1, 20, 6, 2);
      expect(within(commentComposer()).queryByText(/first (?:cell|block) only/)?.textContent).toBe("first block only");
      expect(within(commentComposer()).queryByText("jumps.")?.textContent).toBe("jumps.");

      view.type("the tail only");
      view.submit();
      const [thread] = listAnnotations(ydoc);
      expect(listAnnotationRanges(ydoc, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 20, end: PARAGRAPH.length },
      ]);
      // The caret goes to the end of what was marked — in the first block, not
      // in the block the selection happened to run into.
      expect(view.editor.state.selection.from).toBe(
        posIn(view.editor, 1, PARAGRAPH.length),
      );
    } finally {
      view.unmount();
    }
  });

  /**
   * The card follows the moving range: a remote edit above the selection shifts
   * every offset in it, which is a *new* target for the same open field. What
   * must not happen is the field closing and taking half a written comment with
   * it — the commonest way to lose a comment nobody typed twice.
   */
  it("keeps a half-written comment while a remote edit moves the range", () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc, { author: "ben" });
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("why quick?");

      // A second client prepends to the same block: every offset shifts by 10.
      act(() => {
        editBlock(remote, blocks[1]!, PARAGRAPH, `Actually, ${PARAGRAPH}`);
      });

      // Still open, still holding what was typed…
      expect(screen.queryByPlaceholderText<HTMLTextAreaElement>(/^Comment as /)?.value).toBe(
        "why quick?",
      );
      // …and quoting the same words at their new offsets.
      expect(within(commentComposer()).queryByText("quick brown")?.textContent).toBe("quick brown");

      view.submit();
      const [thread] = listAnnotations(ydoc);
      expect(thread?.comments[0]?.text).toBe("why quick?");
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 14, end: 25 },
      ]);
    } finally {
      view.unmount();
    }
  });

  it("types a mention as plain text into the comment", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc, { mentions: ["agent-a"] });
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("look at this");
      act(() => within(commentComposer()).queryByRole<HTMLButtonElement>("button", { name: "@agent-a" })?.click());
      view.submit();

      expect(listAnnotations(ydoc)[0]?.comments[0]?.text).toBe(
        "look at this @agent-a",
      );
    } finally {
      view.unmount();
    }
    // The convention, in one place: a separating space where one is needed.
    expect(withMention("", "a")).toBe("@a ");
    expect(withMention("hi ", "a")).toBe("hi @a ");
  });
});

describe("the rail writes back", () => {
  function renderRail(
    ydoc: Y.Doc,
    author = "ben",
  ): {
    cards: () => HTMLElement[];
    card: (excerpt: string) => HTMLElement;
    count: () => string | null;
    resolvedCss: () => string;
    type: (text: string) => Promise<void>;
    unmount: () => void;
  } {
    const view = render(
      <LiveThreadsPane
        connection={stubConnection(ydoc)}
        focused={null}
        author={author}
        onFocus={() => {}}
      />,
    );
    const host = view.container;
    const region = (): HTMLElement => within(host).getByRole("region", { name: "Threads" });
    const cards = (): HTMLElement[] => within(region()).getAllByRole("listitem");
    return {
      cards,
      card: (excerpt) => {
        const control = within(region()).getByRole("button", { name: new RegExp(excerpt) });
        const found = cards().find((card) => card.contains(control));
        if (found === undefined) throw new Error(`no card quoting ${excerpt}`);
        return found;
      },
      count: () => within(within(region()).getByText("Threads", { exact: true }))
        .getByText(/^\d+$/).textContent,
      resolvedCss: () =>
        // This generated stylesheet, rather than a visible control, is the contract.
        host.querySelector("[data-resolved-highlights]")?.textContent ?? "",
      type: (text) =>
        settle(() => {
          const field = within(region()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…");
          if (field === null) throw new Error("no reply field");
          // React listens for `input`, and setting `.value` skips its tracker.
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set?.call(field, text);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      unmount: () => {
        view.unmount();
      },
    };
  }

  /** The button in a card's action row whose label is `label`. */
  function action(card: HTMLElement, label: string): HTMLButtonElement {
    return within(card).getByRole<HTMLButtonElement>("button", { name: label });
  }

  /** Submit the visible reply form on this card. */
  function submitReply(card: HTMLElement): void {
    within(card).getByPlaceholderText("Reply…");
    action(card, "Reply").click();
  }

  function threadButton(card: HTMLElement): HTMLButtonElement {
    return within(card).getByRole<HTMLButtonElement>("button", { name: /^Paragraph \d/ });
  }

  it("appends a reply authored by this client, live to a second client", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc, "loitering otter");
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      await view.type("because it is a pangram");
      await settle(() => submitReply(view.cards()[0]!));

      expect(getAnnotation(remote, thread.id)?.comments).toEqual([
        { author: "agent-a", text: "why?", createdAt: expect.any(String) },
        {
          author: "loitering otter",
          text: "because it is a pangram",
          createdAt: expect.any(String),
        },
      ]);
      // The form closes, and the card shows the reply it just wrote.
      expect(within(view.cards()[0]!).queryByPlaceholderText("Reply…")).toBeNull();
      expect(
        within(view.cards()[0]!).getAllByRole("time").map(
          (time) => within(time.parentElement!.parentElement!).getByText(/^(why\?|because it is a pangram)$/).textContent,
        ),
      ).toEqual(["why?", "because it is a pangram"]);
    } finally {
      view.unmount();
    }
  });

  /**
   * A reply form open on a thread another client then resolves. The reply
   * belongs to a conversation that is over, so the form goes — and expanding
   * the resolved card to read it back must not quietly offer it again.
   */
  it("takes back an open reply form when another client resolves the thread", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc);
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      expect(within(view.cards()[0]!).queryByPlaceholderText("Reply…")).not.toBeNull();

      await settle(() => setAnnotationResolved(remote, thread.id, true));
      expect(within(view.cards()[0]!).queryByPlaceholderText("Reply…")).toBeNull();

      // Expanding the resolved card shows the conversation, and no form.
      await settle(() =>
        threadButton(view.cards()[0]!).click(),
      );
      expect(within(view.cards()[0]!).queryByText("why?")?.textContent).toBe(
        "why?",
      );
      expect(within(view.cards()[0]!).queryByPlaceholderText("Reply…")).toBeNull();

      // Reopened by that same client: the reply was let go, not merely hidden,
      // so the form does not come back — and does not steal the caret with it.
      await settle(() => setAnnotationResolved(remote, thread.id, false));
      expect(within(view.cards()[0]!).queryByPlaceholderText("Reply…")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  /**
   * The other half of the same race. The card under the pointer is always a
   * render old, so the resolve can land in the *same task* as the click, before
   * the rail has been told to take the form away. The handler is then looking
   * at a card that still says "open" — and a reply written into a conversation
   * someone else has just closed is the kind of write nobody sees again.
   *
   * So the thread is re-read at submit and the reply refused, which is what
   * `CommentForm`'s false return means: the text stays where it was typed.
   */
  it("refuses a reply to a thread another client resolved in the same task", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc);
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      await view.type("because it is a pangram");

      // One task: the rail's observer only queues a microtask, so the click is
      // handled against the render that still shows an open thread.
      await settle(() => {
        setAnnotationResolved(remote, thread.id, true);
        submitReply(view.card("quick brown"));
      });

      // Nothing was appended, on either replica…
      expect(getAnnotation(remote, thread.id)?.comments).toHaveLength(1);
      expect(getAnnotation(ydoc, thread.id)?.comments).toHaveLength(1);
      // …and the card says why, on the card rather than in a form that is gone.
      expect(
        within(view.card("quick brown")).queryByText("This thread was resolved while you wrote — reopen it to reply.")?.textContent,
      ).toBe("This thread was resolved while you wrote — reopen it to reply.");
      expect(within(view.card("quick brown")).queryByPlaceholderText("Reply…")).toBeNull();

      // The message is about a thread that reads as resolved, and whoever
      // settled it can reopen it from anywhere. Nobody clicks anything here:
      // the reopen arrives from the other replica and the message goes with the
      // state that justified it.
      await settle(() => setAnnotationResolved(remote, thread.id, false));
      expect(within(view.card("quick brown")).queryByText("This thread was resolved while you wrote — reopen it to reply.")).toBeNull();
      await settle(() => action(view.card("quick brown"), "Reply").click());
      await view.type("because it is a pangram");
      await settle(() => submitReply(view.card("quick brown")));
      expect(getAnnotation(remote, thread.id)?.comments).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });

  it("resolves a thread: out of the count, still in the rail, faded in the prose", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    createAnnotation(ydoc, blocks[2]!, 0, 6, "ben", "and this");
    const { editor, element } = mountEditor(ydoc);
    const view = renderRail(ydoc);
    try {
      expect(view.count()).toBe("2");

      await settle(() => action(view.cards()[0]!, "Resolve").click());

      // The document, as a second client reads it.
      expect(getAnnotation(remote, thread.id)?.resolved).toBe(true);
      // The mark stays: a resolved thread is still anchored to its range.
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread.id, start: 4, end: 15 },
      ]);

      // One open thread left, and the resolved one is still on screen.
      expect(view.count()).toBe("1");
      expect(view.cards()).toHaveLength(2);
      const resolved = view
        .cards()
        .find((card) => within(card).queryByText("resolved"));
      expect(within(resolved!).queryByText("resolved")?.textContent).toBe("resolved");
      // Collapsed, but expandable — the conversation is not lost.
      expect(within(resolved!).queryByText("why?")).toBeNull();
      await settle(() =>
        threadButton(resolved!).click(),
      );
      expect(
        within(view.cards().find((card) => within(card).queryByText("resolved"))!)
          .queryByText("why?")?.textContent,
      ).toBe("why?");

      // The highlight in the prose fades: still there, no amber ground.
      expect(
        element.querySelector(`[data-comment-thread="${thread.id}"]`),
      ).not.toBeNull();
      expect(view.resolvedCss()).toContain(`[data-comment-thread="${thread.id}"]`);
      expect(view.resolvedCss()).toContain("background:transparent");

      // …and reopening puts it back in the count.
      const reopen = view
        .cards()
        .find((card) => within(card).queryByText("resolved"))!;
      await settle(() => action(reopen, "Reopen").click());
      expect(getAnnotation(remote, thread.id)?.resolved).toBe(false);
      expect(view.count()).toBe("2");
      expect(view.resolvedCss()).toBe("");
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });

  /**
   * That a `comment` mark survives a block split is the schema package's own
   * property, pinned by its own tests. What is this rail's business is that a
   * resolve it wrote lands on a thread whose anchor moved underneath it: the
   * state reaches the other replica, and the card is still in the rail.
   */
  it("survives a remote block split landing on a thread being resolved", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");

    // A second replica, editing apart: no updates flow until syncDocs below.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const { editor, element } = mountEditor(remote, {
      newBlockId: () => "split-1",
    });
    const view = renderRail(ydoc);
    try {
      // Remote: Enter inside the annotated range, splitting "quick| brown".
      editor.commands.setTextSelection(posIn(editor, 1, 9));
      editor.commands.splitBlock();
      // Local, concurrently: resolve the thread.
      await settle(() => action(view.cards()[0]!, "Resolve").click());

      await settle(() => syncDocs(ydoc, remote));

      expect(getAnnotation(remote, thread.id)?.resolved).toBe(true);
      // …and the rail still finds it, anchored to the first half.
      expect(view.cards()).toHaveLength(1);
      expect(view.count()).toBe("0");
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });

  /**
   * A thread id is a key in a Y.Map, so any client can make one up — including
   * one that would close the CSS string the fade rule puts it in. An id outside
   * the shape the schema package generates gets no rule at all: its highlight
   * stays amber, which is loud rather than dangerous.
   */
  it("writes no stylesheet rule for a thread id it cannot vouch for", () => {
    const hostile = '"]{}\n*{display:none}';
    expect(resolvedHighlightCss([hostile])).toBe("");
    expect(resolvedHighlightCss([hostile, "b3d1f0e2-4c5a-11ee-be56-0242ac120002"]))
      .toBe(
        '[data-comment-thread="b3d1f0e2-4c5a-11ee-be56-0242ac120002"]{background:transparent;border-bottom:1px dotted var(--muted-foreground);}',
      );
    // Harmless characters, hostile size: a uuid is 36 characters, and an id
    // that goes on for a megabyte is a megabyte of selector on every render.
    expect(resolvedHighlightCss(["a".repeat(100_000)])).toBe("");
  });
});

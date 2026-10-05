/** Legacy normalization and the palette gate on the actual bound page. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, exportMarkdown, getBlocks, getBlocksFragment, getBlocksWithInline, initDoc, tableCellText, tableRows, writeGfmTable } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as editorFactory from "../src/editor/create-editor.js";
import { BLOCK_MENU_ENTRIES, convertBlockAtTrigger, slashTriggerAt } from "../src/editor/block-menu.js";
import { EditorPane } from "../src/ui/EditorPane.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const SOURCE = "| name | count |\n| --- | --- |\n| alpha | 1 |";
const LIVE: RoomStatus = { connected: true, synced: true, writable: true,
  hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
  unsyncedChanges: 0, protocolMismatch: null, authFailed: false, tokenMissing: false };
const roots: Array<() => void> = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});
afterEach(() => { for (const destroy of roots.splice(0)) destroy(); vi.restoreAllMocks(); });

function legacy(id: string, source = SOURCE): Y.XmlElement {
  const block = new Y.XmlElement("table"); block.setAttribute("id", id);
  block.insert(0, [new Y.XmlText(source)]); return block;
}
function legacyDoc(source = SOURCE): Y.Doc {
  const ydoc = new Y.Doc(); initDoc(ydoc, { uuid: UUID, title: "Tables" });
  getBlocksFragment(ydoc).insert(0, [legacy("table-one", source)]);
  return ydoc;
}
function fixture(status = LIVE, ydoc = legacyDoc()) {
  const listeners = new Set<(reading: RoomStatus) => void>();
  const connection = { room: `${WORKSPACE}/${UUID}`, ydoc, provider: { awareness: null }, status: { ...status },
    onStatusChange(listener: (reading: RoomStatus) => void) {
      listeners.add(listener); listener(connection.status); return () => { listeners.delete(listener); };
    },
  } as unknown as RoomConnection;
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(() => { act(() => root.unmount()); host.remove(); ydoc.destroy(); });
  const selectThread = () => {};
  act(() => root.render(<EditorPane connection={connection} segment={WORKSPACE} presence={[]}
    author="Reader" archived={false} docLinks={null} onRestore={null} onSelectThread={selectThread} />));
  return { host, ydoc, connection, status(patch: Partial<RoomStatus>) {
    act(() => { Object.assign(connection.status, patch); for (const listener of listeners) listener(connection.status); });
  } };
}

it("waits for writable and synchronized state, then converts and binds without reloading", () => {
  const fix = fixture({ ...LIVE, writable: false, synced: false });
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  expect((getBlocksFragment(fix.ydoc).get(0) as Y.XmlElement).firstChild).toBeInstanceOf(Y.XmlText);
  fix.status({ writable: true });
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  fix.status({ synced: true });
  expect(fix.host.querySelectorAll(".ub-table th")).toHaveLength(2);
  expect(fix.host.querySelectorAll(".ub-table td")).toHaveLength(2);
  expect(getBlocks(fix.ydoc)[0]).toMatchObject({ id: "table-one", text: SOURCE });
});

it("binds initially writable legacy content and rebinds after a late legacy write", () => {
  const fix = fixture();
  expect(fix.host.querySelectorAll(".ub-table")).toHaveLength(1);
  act(() => getBlocksFragment(fix.ydoc).insert(1, [legacy("late-table")]));
  expect(fix.host.querySelectorAll(".ub-table")).toHaveLength(2);
  expect(getBlocks(fix.ydoc).map((block) => block.id)).toEqual(["table-one", "late-table"]);
});

it("keeps malformed table content intact behind the disabled fallback", () => {
  const fix = fixture();
  const table = getBlocksFragment(fix.ydoc).get(0) as Y.XmlElement;
  const cell = tableRows(table)[0]![0]!;
  act(() => (cell as unknown as { setAttribute(key: string, value: unknown): void }).setAttribute("rowspan", 2));
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  expect(cell.getAttribute("rowspan")).toBe(2);
  expect(getBlocks(fix.ydoc)[0]?.text).toBe(SOURCE);
  expect(fix.host.textContent).toContain("Editor disabled");
});

it.each([SOURCE, "This legacy source is not a table."])(
  "two bound pages converge after simultaneously converting %j",
  (source) => {
    const seed = legacyDoc(source);
    const fragment = getBlocksFragment(seed);
    for (const [index, id, text] of [[0, "before", "Before"], [2, "after", "After"]] as const) {
      const sibling = new Y.XmlElement("paragraph"); sibling.setAttribute("id", id);
      sibling.insert(0, [new Y.XmlText(text)]); fragment.insert(index, [sibling]);
      (sibling.firstChild as Y.XmlText).format(0, text.length, { bold: {} });
    }
    const initial = Y.encodeStateAsUpdate(seed);
    const before = Y.encodeStateVector(seed);
    seed.destroy();
    const a = new Y.Doc(); const b = new Y.Doc();
    Y.applyUpdate(a, initial); Y.applyUpdate(b, initial);
    const left = fixture(LIVE, a); const right = fixture(LIVE, b);
    const siblings = [left, right].map((page) => [getBlocksFragment(page.ydoc).get(0), getBlocksFragment(page.ydoc).get(2)]);
    const siblingContent = siblings.map((nodes) => nodes.map((node) => node.toJSON()));
    const aConversion = Y.encodeStateAsUpdate(a, before);
    const bConversion = Y.encodeStateAsUpdate(b, before);
    act(() => { Y.applyUpdate(a, bConversion); Y.applyUpdate(b, aConversion); });
    act(() => { Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); });
    for (const [index, page] of [left, right].entries()) {
      expect(page.host.querySelector(".ProseMirror")).not.toBeNull();
      const blocks = getBlocks(page.ydoc);
      expect(blocks.map((block) => block.id)).toEqual(["before", "table-one", "after"]);
      expect(blocks.map((block) => block.text)).toEqual(["Before", source, "After"]);
      expect(getBlocksFragment(page.ydoc).length).toBe(3);
      expect(getBlocksFragment(page.ydoc).get(0)).toBe(siblings[index]![0]);
      expect(getBlocksFragment(page.ydoc).get(2)).toBe(siblings[index]![1]);
      expect(siblings[index]!.map((node) => node.toJSON())).toEqual(siblingContent[index]);
      expect(page.host.querySelectorAll(source === SOURCE ? ".ub-table" : ".ub-code")).toHaveLength(1);
    }
    expect(getBlocksFragment(a).toJSON()).toEqual(getBlocksFragment(b).toJSON());
    let idleUpdates = 0;
    a.on("update", () => { idleUpdates += 1; }); b.on("update", () => { idleUpdates += 1; });
    act(() => { Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); });
    expect(idleUpdates).toBe(0);
  },
);

it("keeps local paragraph splits and their undo while the page repairs remote duplicates", () => {
  const createEditor = vi.spyOn(editorFactory, "createUberblickEditor");
  const ydoc = new Y.Doc(); initDoc(ydoc, { uuid: UUID, title: "Paragraph" });
  const original = appendBlock(ydoc, { type: "paragraph", text: "abcdef" });
  const page = fixture(LIVE, ydoc);
  const editor = createEditor.mock.results[0]!.value as ReturnType<typeof editorFactory.createUberblickEditor>;
  act(() => {
    editor.commands.setTextSelection(4);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
  });
  const blocks = getBlocks(ydoc);
  expect(blocks.map((block) => block.text)).toEqual(["abc", "def"]);
  expect(blocks[0]!.id).toBe(original);
  expect(blocks[1]!.id).not.toBe(original);
  expect(getBlocksFragment(ydoc).length).toBe(2);
  expect(page.host.querySelector(".ProseMirror")).not.toBeNull();
  act(() => { expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true); });
  expect(getBlocks(ydoc).map((block) => ({ id: block.id, text: block.text }))).toEqual([{ id: original, text: "abcdef" }]);
});

it.each([false, true])("keeps guarded pages bound and delayed person text in its mapped surviving cell (column replacement: %s)", (replaceColumn) => {
  const createEditor = vi.spyOn(editorFactory, "createUberblickEditor");
  const beforeRows = replaceColumn
    ? [["Task", "Status", "Notes", "Owner"], ["Write", "done", "write notes", "ann"], ["Test", "done", "test notes", "ann"], ["Ship", "todo", "ship notes", "ben"]]
    : [["Task", "Status"], ["Write", "done"], ["Test", "done"]];
  const nextRows = replaceColumn
    ? [["Task", "Extra", "Status", "Owner"], ["New task", "new 1", "todo", "ann"], ["Wrote", "new 2", "done", "ann"], ["Ship", "new 3", "todo", "ben"]]
    : [["Task", "Status"], ["New task", "todo"], ["Wrote", "done"]];
  const source = writeGfmTable(beforeRows);
  const seed = new Y.Doc(); initDoc(seed, { uuid: UUID, title: "Mapped cells" });
  const id = appendBlock(seed, { type: "table", text: source });
  const statusCell = (ydoc: Y.Doc, row: number, column: number): Y.XmlText =>
    tableCellText(tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement)[row]![column]!)!;
  statusCell(seed, 1, 1).format(0, 4, { bold: {} });
  const initial = Y.encodeStateAsUpdate(seed); seed.destroy();
  const a = new Y.Doc(); const b = new Y.Doc();
  Y.applyUpdate(a, initial); Y.applyUpdate(b, initial);
  const pages = [fixture(LIVE, a), fixture(LIVE, b)];
  const editors = createEditor.mock.results.map((result) => result.value as Editor);
  const originalTexts = [statusCell(a, 1, 1), statusCell(b, 1, 1)];
  const appendInCell = (editor: Editor, row: number, column: number, columns: number, text: string): void => {
    let cellIndex = 0;
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "tableHeader" && node.type.name !== "tableCell") return;
      if (cellIndex++ === row * columns + column) position = pos + 2 + node.textContent.length;
    });
    expect(position).toBeGreaterThan(0);
    editor.commands.setTextSelection(position);
    editor.view.dispatch(editor.state.tr.insertText(text));
  };
  act(() => {
    // The person writes through the actual guarded editor while its replica
    // still holds the old rows and columns, before the agent edit reaches it.
    appendInCell(editors[1]!, 1, 1, beforeRows[0]!.length, " (blocked)");
    editBlock(a, id, source, writeGfmTable(nextRows), {
      rev: getBlocks(a)[0]!.rev,
      tableMapping: {
        rows: replaceColumn ? [0, null, 1, 3] : [0, null, 1],
        columns: replaceColumn ? [0, null, 1, 3] : [0, 1],
      },
    });
  });
  const targetColumn = replaceColumn ? 2 : 1;
  expect(statusCell(a, 2, targetColumn)).toBe(originalTexts[0]);
  const aWrite = Y.encodeStateAsUpdate(a); const bWrite = Y.encodeStateAsUpdate(b);
  act(() => { Y.applyUpdate(a, bWrite); Y.applyUpdate(b, aWrite); });
  nextRows[2]![targetColumn] = "done (blocked)";
  for (const [index, page] of pages.entries()) {
    expect(editors[index]!.isDestroyed).toBe(false);
    expect(page.host.querySelector(".ProseMirror")).not.toBeNull();
    expect(statusCell(page.ydoc, 2, targetColumn)).toBe(originalTexts[index]);
    expect(statusCell(page.ydoc, 2, targetColumn).toDelta()).toEqual([{ insert: "done (blocked)", attributes: { bold: {} } }]);
    expect(getBlocks(page.ydoc)[0]!.text).toBe(writeGfmTable(nextRows));
    const table = page.host.querySelector(".ub-table")!;
    const drawn = [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));
    expect(drawn).toEqual(nextRows);
    expect(exportMarkdown(page.ydoc, { frontmatter: false })).toContain("**done (blocked)**");
  }
  expect(getBlocks(a)).toEqual(getBlocks(b));
  act(() => {
    appendInCell(editors[1]!, 2, targetColumn, nextRows[0]!.length, "!");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  });
  expect(getBlocks(a)).toEqual(getBlocks(b));
  expect(statusCell(a, 2, targetColumn)).toBe(originalTexts[0]);
  expect(statusCell(a, 2, targetColumn).toDelta()).toEqual([{ insert: "done (blocked)!", attributes: { bold: {} } }]);
  for (const [index, page] of pages.entries()) {
    expect(editors[index]!.isDestroyed).toBe(false);
    expect(page.host.querySelector(".ProseMirror")).not.toBeNull();
  }
});

it.each(["person", "agent"] as const)(
  "keeps guarded pages bound when a person and a %s first fill the same empty cell",
  (secondWriter) => {
    const createEditor = vi.spyOn(editorFactory, "createUberblickEditor");
    const source = "| h | x |\n| --- | --- |\n|  | keep |";
    const seed = new Y.Doc(); initDoc(seed, { uuid: UUID, title: "Concurrent cells" });
    const id = appendBlock(seed, { type: "table", text: source });
    const initial = Y.encodeStateAsUpdate(seed); seed.destroy();
    const a = new Y.Doc(); const b = new Y.Doc();
    Y.applyUpdate(a, initial); Y.applyUpdate(b, initial);
    const left = fixture(LIVE, a); const right = fixture(LIVE, b);
    const editors = createEditor.mock.results.map((result) => result.value as Editor);
    const cellParagraph = (ydoc: Y.Doc): Y.XmlElement =>
      tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement)[1]![0]!.firstChild as Y.XmlElement;
    const typeFirst = (editor: Editor, text: string, mark: "bold" | "italic"): void => {
      let cellIndex = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "tableHeader" && node.type.name !== "tableCell") return;
        if (cellIndex++ === 2) editor.commands.setTextSelection(pos + 2);
      });
      expect(editor.commands.toggleMark(mark)).toBe(true);
      editor.view.dispatch(editor.state.tr.insertText(text));
    };
    act(() => {
      typeFirst(editors[0]!, "Ann", "bold");
      if (secondWriter === "person") typeFirst(editors[1]!, "Ben", "italic");
      else {
        editBlock(b, id, source, source.replace("|  | keep |", "| Ben | keep |"));
        (cellParagraph(b).firstChild as Y.XmlText).format(0, 3, { italic: {} });
      }
    });
    const localTexts = [cellParagraph(a).firstChild, cellParagraph(b).firstChild];
    const aWrite = Y.encodeStateAsUpdate(a); const bWrite = Y.encodeStateAsUpdate(b);
    act(() => { Y.applyUpdate(a, bWrite); Y.applyUpdate(b, aWrite); });

    for (const [index, page] of [left, right].entries()) {
      expect(editors[index]!.isDestroyed).toBe(false);
      expect(page.host.querySelector(".ProseMirror")).not.toBeNull();
      const text = getBlocks(page.ydoc)[0]!.text;
      expect(text).toContain("Ann"); expect(text).toContain("Ben");
      expect(page.host.querySelector(".ub-table")?.textContent).toContain("Ann");
      expect(page.host.querySelector(".ub-table")?.textContent).toContain("Ben");
      expect(cellParagraph(page.ydoc).toArray()).toContain(localTexts[index]);
      const runs = getBlocksWithInline(page.ydoc)[0]!.table![1]![0]!;
      expect(runs).toEqual(expect.arrayContaining([
        { text: "Ann", marks: { bold: true } },
        { text: "Ben", marks: { italic: true } },
      ]));
      const markdown = exportMarkdown(page.ydoc, { frontmatter: false });
      expect(markdown).toContain("**Ann**"); expect(markdown).toContain("*Ben*");
    }
    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlocksFragment(a).toJSON()).toEqual(getBlocksFragment(b).toJSON());

    // A still-offline writer can keep editing the original text type from its
    // first-write snapshot. Its delayed update must survive the drawn merge.
    const delayed = new Y.Doc();
    Y.applyUpdate(delayed, bWrite);
    roots.push(() => delayed.destroy());
    const stale = getBlocks(delayed)[0]!.text;
    editBlock(delayed, id, stale, stale.replace(" | keep |", " later | keep |"));
    act(() => { Y.applyUpdate(a, Y.encodeStateAsUpdate(delayed)); Y.applyUpdate(b, Y.encodeStateAsUpdate(delayed)); });
    expect(getBlocks(a)[0]!.text).toContain("later");
    expect(getBlocks(b)[0]!.text).toContain("later");

    // Both writer paths remain usable concurrently after the first-write merge.
    const beforeFollowup = getBlocks(b)[0]!.text;
    act(() => {
      const editor = editors[0]!;
      let cellIndex = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "tableHeader" && node.type.name !== "tableCell") return;
        if (cellIndex++ === 2) editor.commands.setTextSelection(pos + 2 + node.textContent.length);
      });
      editor.view.dispatch(editor.state.tr.insertText("!"));
      editBlock(b, id, beforeFollowup, beforeFollowup.replace(" | keep |", "? | keep |"));
      const aFollowup = Y.encodeStateAsUpdate(a); const bFollowup = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, bFollowup); Y.applyUpdate(b, aFollowup);
    });
    for (const [index, page] of [left, right].entries()) {
      expect(editors[index]!.isDestroyed).toBe(false);
      expect(getBlocks(page.ydoc)[0]!.text).toContain("Ann");
      expect(getBlocks(page.ydoc)[0]!.text).toContain("Ben");
      expect(getBlocks(page.ydoc)[0]!.text).toContain("!");
      expect(getBlocks(page.ydoc)[0]!.text).toContain("?");
      const markdown = exportMarkdown(page.ydoc, { frontmatter: false });
      expect(markdown).toContain("**Ann"); expect(markdown).toContain("*Ben");
    }
    // A follow-up agent edit remains possible without replacing the raced cell.
    const retainedTexts = [cellParagraph(a), cellParagraph(b)].map((paragraph) => paragraph.toArray());
    const retainedDeltas = retainedTexts.map((texts) => texts.map((text) => (text as Y.XmlText).toDelta()));
    const current = getBlocks(a)[0]!.text;
    act(() => { editBlock(a, id, current, current.replace("keep", "kept")); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); });
    for (const [index, page] of [left, right].entries()) {
      expect(editors[index]!.isDestroyed).toBe(false);
      expect(cellParagraph(page.ydoc).toArray()).toEqual(retainedTexts[index]);
      expect(cellParagraph(page.ydoc).toArray().map((text) => (text as Y.XmlText).toDelta())).toEqual(retainedDeltas[index]);
      expect(getBlocks(page.ydoc)[0]!.text).toContain("kept");
    }

    const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    let idleUpdates = 0;
    for (const ydoc of [a, b, c]) ydoc.on("update", () => { idleUpdates += 1; });
    const reopened = fixture(LIVE, c);
    expect(reopened.host.querySelector(".ProseMirror")).not.toBeNull();
    expect(reopened.host.querySelector(".ub-table")?.textContent).toContain("Ann");
    expect(reopened.host.querySelector(".ub-table")?.textContent).toContain("Ben");
    act(() => { Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); });
    expect(idleUpdates).toBe(0);
    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlocks(a)).toEqual(getBlocks(c));
  },
);

it("shares a text type in every empty menu and Tab-created cell before their first edit", () => {
  const createEditor = vi.spyOn(editorFactory, "createUberblickEditor");
  const ydoc = new Y.Doc(); initDoc(ydoc, { uuid: UUID, title: "Native table creation" });
  appendBlock(ydoc, { type: "paragraph", text: "/table" });
  fixture(LIVE, ydoc);
  const editor = createEditor.mock.results[0]!.value as Editor;
  act(() => {
    editor.commands.setTextSelection(7);
    const trigger = slashTriggerAt(editor)!;
    expect(convertBlockAtTrigger(editor, trigger, BLOCK_MENU_ENTRIES.find((entry) => entry.type === "table")!)).toBe(true);
  });
  const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  const checkEmptyTexts = (): void => {
    for (const row of tableRows(table)) for (const cell of row) {
      const paragraph = cell.firstChild as Y.XmlElement;
      expect(paragraph.toArray()).toHaveLength(1);
      expect(paragraph.firstChild).toBeInstanceOf(Y.XmlText);
      expect((paragraph.firstChild as Y.XmlText).length).toBe(0);
    }
  };
  expect(tableRows(table)).toHaveLength(3);
  checkEmptyTexts();
  act(() => {
    let lastPosition = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "tableCell") lastPosition = pos + 2; });
    editor.commands.setTextSelection(lastPosition);
    expect(editor.commands.keyboardShortcut("Tab")).toBe(true);
  });
  expect(tableRows(table)).toHaveLength(4);
  checkEmptyTexts();

  const replica = new Y.Doc(); Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
  roots.push(() => replica.destroy());
  expect(getBlocksFragment(replica).toJSON()).toEqual(getBlocksFragment(ydoc).toJSON());
  const remoteTable = getBlocksFragment(replica).get(0) as Y.XmlElement;
  for (const [rowIndex, row] of tableRows(table).entries()) for (const [cellIndex, cell] of row.entries()) {
    const local = (cell.firstChild as Y.XmlElement).firstChild as Y.XmlText;
    const remote = (tableRows(remoteTable)[rowIndex]![cellIndex]!.firstChild as Y.XmlElement).firstChild as Y.XmlText;
    expect(Y.createRelativePositionFromTypeIndex(local, 0)).toEqual(Y.createRelativePositionFromTypeIndex(remote, 0));
  }
});

/**
 * The way out of a link conflict, in the browser (#451).
 *
 * One story: **a merge that leaves both link marks on a range is repaired by
 * the person, one range at a time, and by nothing else.** PR #450 shipped the
 * refusal — the palette gate will not bind a document holding such a range,
 * because y-prosemirror would render two nested anchors — and kept it
 * deliberately. What it left open was the way back, and until this the fallback
 * could only point a browser reader at the MCP tools they do not have.
 *
 * So everything here hangs off that one claim: opening writes nothing, a choice
 * writes exactly one cleared mark on exactly one range, a stale choice writes
 * nothing at all, an archived document is offered no choice, and the editor
 * comes back only when the *whole* gate is clean.
 *
 * The pair is always produced by a real two-replica merge rather than written
 * by hand: the state under test is one two concurrent writers can actually
 * reach, and a hand-written pair would prove only that the code reads what the
 * test wrote.
 *
 * `acquireRoom` is mocked the way `archived.test.tsx` mocks it: rooms are plain
 * shared Y.Docs, because the transport is not what is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  directoryRoom,
  getBlockInline,
  getBlocks,
  getBlocksFragment,
  initDoc,
  roomForDoc,
  setKind,
  setStatus,
  tableCellText,
  tableRows,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { findForeignBlocks, findLinkConflicts } from "../src/editor/palette.js";
import { repairLinkConflict } from "../src/editor/link-repair.js";
import { plainText } from "../src/editor/ytext.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
/** The document half of every conflicting pair below. */
const TARGET = "0189abcd-2222-4333-8444-555566667777";
const SECOND_TARGET = "0189abcd-3333-4444-8555-666677778888";
const HREF = "https://example.com/hub";
/** A second, unrelated external link in the same block — it must survive. */
const OTHER_HREF = "https://example.com/more";

/** "see the" is the conflicting range; "more" carries the unrelated link. */
const PROSE = "see the hub and more";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

const rooms = new Map<string, RoomConnection>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: OFFLINE,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(OFFLINE);
      return () => {};
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

/** The first Y.XmlText of a top-level block. */
function textAt(ydoc: Y.Doc, index = 0): Y.XmlText {
  return (getBlocksFragment(ydoc).get(index) as Y.XmlElement)
    .firstChild as Y.XmlText;
}

function textChildAt(
  ydoc: Y.Doc,
  blockIndex: number,
  textIndex: number,
): Y.XmlText {
  return (getBlocksFragment(ydoc).get(blockIndex) as Y.XmlElement).get(
    textIndex,
  ) as Y.XmlText;
}

function deltaOf(text: Y.XmlText): unknown {
  return text.toDelta();
}

/**
 * Leave `[start, start + length)` carrying both link marks, the way a merge
 * does: one replica formats it as an external link, the other as a document
 * reference, and neither knows about the other until the updates meet.
 */
function mergeConflictingPair(
  ydoc: Y.Doc,
  options: {
    index?: number;
    textIndex?: number;
    start: number;
    length: number;
    docId?: string;
  },
): void {
  const { index = 0, textIndex = 0, start, length, docId = TARGET } = options;
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  textChildAt(ydoc, index, textIndex).format(start, length, {
    link: { href: HREF },
  });
  textChildAt(peer, index, textIndex).format(start, length, {
    docLink: { docId },
  });
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
}

/** A document holding one conflicting range, some bold over half of it, and an
 * unrelated external link further along the same block. */
function docWithConflict(ydoc: Y.Doc): string {
  initDoc(ydoc, { uuid: UUID, title: "Two links, one range" });
  const blockId = appendBlock(ydoc, { type: "paragraph", text: PROSE });
  textAt(ydoc).format(0, 3, { bold: true });
  textAt(ydoc).format(16, 4, { link: { href: OTHER_HREF } });
  mergeConflictingPair(ydoc, { start: 0, length: 7 });
  return blockId;
}

describe("a repair writes once, on one range, and only while it is still there", () => {
  it("keeps the chosen target, converges, and refuses a stale or repeated choice", () => {
    const a = new Y.Doc();
    const blockId = docWithConflict(a);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Scanning is a read: listing the choices must not be a write.
    let updates = 0;
    a.on("update", () => {
      updates += 1;
    });
    const [conflict, ...rest] = findLinkConflicts(getBlocksFragment(a));
    expect(rest).toEqual([]);
    expect(conflict).toMatchObject({ start: 0, end: 7, href: HREF, docId: TARGET });
    expect(updates).toBe(0);

    expect(conflict !== undefined && repairLinkConflict(conflict, "docLink")).toBe(
      true,
    );
    expect(updates).toBe(1);

    // The same activation again: live state no longer holds this conflict, so
    // it writes nothing rather than clearing a mark somebody has since placed.
    expect(conflict !== undefined && repairLinkConflict(conflict, "docLink")).toBe(
      false,
    );
    expect(conflict !== undefined && repairLinkConflict(conflict, "link")).toBe(
      false,
    );
    expect(updates).toBe(1);

    // Text, block id, the bold, and the unrelated link are all untouched; only
    // the unchosen key is gone, and only from the conflicting range.
    expect(getBlocks(a)[0]?.id).toBe(blockId);
    expect(plainText(textAt(a))).toBe(PROSE);
    expect(deltaOf(textAt(a))).toEqual([
      { insert: "see", attributes: { bold: true, docLink: { docId: TARGET } } },
      { insert: " the", attributes: { docLink: { docId: TARGET } } },
      { insert: " hub and " },
      { insert: "more", attributes: { link: { href: OTHER_HREF } } },
    ]);

    // Both replicas agree after an exchange, and both gates are clean.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(findForeignBlocks(getBlocksFragment(a))).toEqual([]);
    expect(findForeignBlocks(getBlocksFragment(b))).toEqual([]);
    expect(getBlockInline(b, blockId)).toEqual(getBlockInline(a, blockId));
    expect(getBlockInline(b, blockId)[0]?.marks.docLink).toBe(TARGET);
  });

  it("writes nothing when a remote update resolved the range since the scan", () => {
    const a = new Y.Doc();
    docWithConflict(a);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(a));
    const [conflict] = findLinkConflicts(getBlocksFragment(a));
    expect(conflict).toBeDefined();

    // Somebody else picked the other survivor while this list was on screen.
    textAt(peer).format(0, 7, { docLink: null });
    let updates = 0;
    a.on("update", () => {
      updates += 1;
    });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(peer));
    const remote = updates;

    expect(conflict !== undefined && repairLinkConflict(conflict, "docLink")).toBe(
      false,
    );
    expect(updates).toBe(remote);
    // …and their choice stands, untouched by the stale activation.
    expect(getBlockInline(a, getBlocks(a)[0]?.id ?? "")[0]?.marks.link).toBe(HREF);
  });
});

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  vi.restoreAllMocks();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(node);
  });
  return host;
}

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  return await mount(<App />);
}

/** The whole document, staged in its room, plus the directory that names it. */
function stage(): { ydoc: Y.Doc; blockId: string } {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
  const blockId = docWithConflict(ydoc);
  upsertDirectoryEntry(directory, { uuid: UUID, title: "Two links, one range" });
  upsertDirectoryEntry(directory, { uuid: TARGET, title: "The hub" });
  return { ydoc, blockId };
}

/** Two direct text children sharing one block and one conflict offset. */
function stageCollidingRows(): { ydoc: Y.Doc; first: Y.XmlText; second: Y.XmlText } {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
  initDoc(ydoc, { uuid: UUID, title: "Two colliding choices" });
  appendBlock(ydoc, { type: "paragraph", text: "first" });
  const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  const second = new Y.XmlText();
  second.insert(0, "second");
  block.insert(1, [second]);
  mergeConflictingPair(ydoc, { index: 0, start: 0, length: 5 });
  mergeConflictingPair(ydoc, {
    index: 0,
    textIndex: 1,
    start: 0,
    length: 6,
    docId: SECOND_TARGET,
  });
  upsertDirectoryEntry(directory, { uuid: UUID, title: "Two colliding choices" });
  upsertDirectoryEntry(directory, { uuid: TARGET, title: "The hub" });
  upsertDirectoryEntry(directory, { uuid: SECOND_TARGET, title: "The other hub" });
  return { ydoc, first: textAt(ydoc), second };
}

/** Two table cells with equal conflict offsets, retained as distinct choices. */
function stageTableConflicts(): { ydoc: Y.Doc; first: Y.XmlText; second: Y.XmlText; untouched: Y.XmlText } {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
  initDoc(ydoc, { uuid: UUID, title: "Cell choices" });
  appendBlock(ydoc, { type: "table", text: "| first suffix | other suffix | untouched |\n| --- | --- | --- |" });
  const texts = (doc: Y.Doc): Y.XmlText[] => tableRows(getBlocksFragment(doc).get(0) as Y.XmlElement)[0]!.map((cell) => tableCellText(cell)!);
  const [first, second, untouched] = texts(ydoc) as [Y.XmlText, Y.XmlText, Y.XmlText];
  first.format(0, 2, { bold: true });
  second.format(0, 3, { italic: true });
  untouched.format(0, untouched.length, { strike: true });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const other = texts(peer);
  first.format(0, 5, { link: { href: HREF } });
  second.format(0, 5, { link: { href: OTHER_HREF } });
  other[0]!.format(0, 5, { docLink: { docId: TARGET } });
  other[1]!.format(0, 5, { docLink: { docId: SECOND_TARGET } });
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
  peer.destroy();
  upsertDirectoryEntry(directory, { uuid: UUID, title: "Cell choices" });
  upsertDirectoryEntry(directory, { uuid: TARGET, title: "The hub" });
  upsertDirectoryEntry(directory, { uuid: SECOND_TARGET, title: "The other hub" });
  return { ydoc, first, second, untouched };
}

function repairButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".ub-link-repair button")];
}

function buttonSaying(host: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    repairButtons(host).find((button) =>
      (button.textContent ?? "").includes(text),
    ) ?? null
  );
}

function prose(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".ub-editor .ProseMirror");
}

function banner(host: HTMLElement): string {
  return host.querySelector(".ub-foreign-banner")?.textContent ?? "";
}

describe("the fallback offers the person the choice, and takes only that write", () => {
  it("repairs colliding table-cell choices independently, preserving other text and marks", async () => {
    const { ydoc, first, second, untouched } = stageTableConflicts();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const beforeUntouched = untouched.toDelta();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    let rows = [...host.querySelectorAll<HTMLLIElement>(".ub-link-repair li")];
    expect(rows).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    expect(prose(host)).toBeNull();
    expect(banner(host)).toContain("conflicting external and document links");
    expect(writes).toBe(0);

    act(() => rows[0]?.querySelector<HTMLButtonElement>("button")?.click());
    expect(writes).toBe(1);
    expect(first.toDelta()).toEqual([
      { insert: "fi", attributes: { bold: true, docLink: { docId: TARGET } } },
      { insert: "rst", attributes: { docLink: { docId: TARGET } } },
      { insert: " suffix" },
    ]);
    expect(findLinkConflicts(getBlocksFragment(ydoc))[0]?.text).toBe(second);
    expect(prose(host)).toBeNull();
    rows = [...host.querySelectorAll<HTMLLIElement>(".ub-link-repair li")];
    expect(rows).toHaveLength(1);
    act(() => rows[0]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click());
    expect(writes).toBe(2);
    expect(second.toDelta()).toEqual([
      { insert: "oth", attributes: { italic: true, link: { href: OTHER_HREF } } },
      { insert: "er", attributes: { link: { href: OTHER_HREF } } },
      { insert: " suffix" },
    ]);
    expect(untouched.toDelta()).toEqual(beforeUntouched);
    expect(prose(host)).not.toBeNull();
    expect(host.querySelector(".ub-link-repair")).toBeNull();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    expect(getBlocks(peer)).toEqual(getBlocks(ydoc));
    expect(findForeignBlocks(getBlocksFragment(peer))).toEqual([]);
    peer.destroy();
  });

  it.each(["archived", "decided"] as const)("offers no repair for %s table cells and keeps both marks", async (restriction) => {
    const { ydoc } = stageTableConflicts();
    if (restriction === "archived") tombstoneDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, UUID);
    else { setKind(ydoc, "decision"); setStatus(ydoc, "decided"); }
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    expect(prose(host)).toBeNull();
    expect(host.querySelector(".ub-link-repair")).toBeNull();
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toHaveLength(2);
    expect(banner(host)).toContain(restriction === "archived" ? "restore this document" : "a change to a decided record needs a new record");
    expect(writes).toBe(0);
  });

  it("keeps colliding repair rows distinct from scan through activation", async () => {
    const { ydoc, first, second } = stageCollidingRows();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    let rows = [...host.querySelectorAll<HTMLLIElement>(".ub-link-repair li")];
    expect(rows).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");

    act(() => rows[0]?.querySelector<HTMLButtonElement>("button")?.click());
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toHaveLength(1);
    expect(findLinkConflicts(getBlocksFragment(ydoc))[0]?.text).toBe(second);
    expect(deltaOf(first)).toEqual([
      { insert: "first", attributes: { docLink: { docId: TARGET } } },
    ]);

    rows = [...host.querySelectorAll<HTMLLIElement>(".ub-link-repair li")];
    expect(rows).toHaveLength(1);
    act(() => rows[0]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click());
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toEqual([]);
    expect(deltaOf(first)).toEqual([
      { insert: "first", attributes: { docLink: { docId: TARGET } } },
      { insert: "second", attributes: { link: { href: HREF } } },
    ]);
  });

  it("keeps the document reference, and binds the editor afterwards", async () => {
    const { ydoc, blockId } = stage();
    let updates = 0;
    ydoc.on("update", () => {
      updates += 1;
    });

    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    // Opening is a read. The conflict is named, both targets are on screen —
    // the document by the title the directory advertises for it — and nothing
    // has been written.
    expect(prose(host)).toBeNull();
    expect(banner(host)).toContain("conflicting external and document links");
    expect(banner(host)).not.toContain("MCP tools");
    expect(repairButtons(host)).toHaveLength(2);
    expect(host.querySelector(".ub-link-repair")?.textContent).toContain("see the");
    expect(buttonSaying(host, "The hub")).not.toBeNull();
    expect(buttonSaying(host, HREF)).not.toBeNull();
    expect(updates).toBe(0);

    act(() => buttonSaying(host, "The hub")?.click());

    expect(updates).toBe(1);
    expect(plainText(textAt(ydoc))).toBe(PROSE);
    expect(getBlocks(ydoc)[0]?.id).toBe(blockId);
    expect(deltaOf(textAt(ydoc))).toEqual([
      { insert: "see", attributes: { bold: true, docLink: { docId: TARGET } } },
      { insert: " the", attributes: { docLink: { docId: TARGET } } },
      { insert: " hub and " },
      { insert: "more", attributes: { link: { href: OTHER_HREF } } },
    ]);

    // The gate is clean, so the editor is back — and the offer is gone with the
    // conflict that justified it.
    expect(prose(host)).not.toBeNull();
    expect(host.querySelector(".ub-link-repair")).toBeNull();
  });

  it("keeps the external link, in the same one write", async () => {
    const { ydoc } = stage();
    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    act(() => buttonSaying(host, HREF)?.click());

    expect(deltaOf(textAt(ydoc))).toEqual([
      { insert: "see", attributes: { bold: true, link: { href: HREF } } },
      { insert: " the", attributes: { link: { href: HREF } } },
      { insert: " hub and " },
      { insert: "more", attributes: { link: { href: OTHER_HREF } } },
    ]);
    expect(prose(host)).not.toBeNull();
  });

  it("stays in the fallback while another foreign reason is left", async () => {
    const { ydoc } = stage();
    const callout = new Y.XmlElement("callout");
    callout.insert(0, [new Y.XmlText("from the future")]);
    getBlocksFragment(ydoc).insert(1, [callout]);

    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    act(() => buttonSaying(host, "The hub")?.click());

    // Repaired, and still not bound: the gate is re-run whole, and what is left
    // is named on its own terms.
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toEqual([]);
    expect(prose(host)).toBeNull();
    expect(banner(host)).toContain("callout");
    expect(banner(host)).not.toContain("conflicting external and document links");
    expect(host.querySelector(".ub-link-repair")).toBeNull();
  });

  it("offers an archived document no repair, and takes no write from it", async () => {
    const { ydoc } = stage();
    tombstoneDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, UUID);
    let updates = 0;
    ydoc.on("update", () => {
      updates += 1;
    });

    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    expect(host.querySelector(".ub-link-repair")).toBeNull();
    // Restore is the one action, and the sentence points at it rather than at a
    // control that is not there.
    expect(
      host.querySelector(".ub-archived-banner button")?.textContent,
    ).toBe("Restore");
    expect(banner(host)).toContain("restore this document");
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toHaveLength(1);
    expect(updates).toBe(0);
  });
});

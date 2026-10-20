import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, createTagCatalogEntry, decisionDirectoryFields,
  directoryRoom, getBlocks, getBlocksFragment, getMeta, initDoc, listDirectory,
  listTagCatalog, resolveDecisionTopics, roomForDoc, setKind, setStatus,
  settingsRoom, tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as guardedBinding from "../src/editor/guarded-binding.js";
import { act, renderSettled } from "./react-render.js";
import { docPath } from "../src/ui/route.js";
import type { RecordedDecision } from "../src/ui/document/AlterDecisionDialog.js";
import { Dialog } from "../src/ui/shadcn/dialog.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const CURRENT = "9ebf44bd-97f8-479d-8e7c-5fbc96173504";
const RFC_TAG = "00000000-0000-4000-8000-000000000006";
const LIVE: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true,
  writable: true, storeRefused: false, unsyncedChanges: 0, hasAnswered: true,
  protocolMismatch: null, authFailed: false, tokenMissing: false,
};

interface HeldRoom {
  connection: RoomConnection;
  listeners: Set<(status: RoomStatus) => void>;
  releases: number;
}
const rooms = new Map<string, HeldRoom>();
const acquired: HeldRoom[] = [];

function room(name: string, admitted = false): HeldRoom {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const listeners = new Set<(status: RoomStatus) => void>();
  const connection = {
    room: name, ydoc: new Y.Doc(), provider: { awareness: null },
    status: { ...LIVE, connected: admitted, synced: admitted, writable: admitted },
    onStatusChange(listener: (status: RoomStatus) => void) {
      listeners.add(listener);
      listener(connection.status);
      return () => listeners.delete(listener);
    },
  } as unknown as RoomConnection;
  const held = { connection, listeners, releases: 0 };
  rooms.set(name, held);
  return held;
}

function update(held: HeldRoom, patch: Partial<RoomStatus>): void {
  held.connection.status = { ...held.connection.status, ...patch };
  for (const listener of held.listeners) listener(held.connection.status);
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => {
    const held = room(name);
    acquired.push(held);
    return { connection: held.connection, release: () => { held.releases++; } };
  },
}));
const { AlterDecisionDialog } = await import("../src/ui/document/AlterDecisionDialog.js");

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
});

afterEach(() => {
  rooms.clear();
  acquired.length = 0;
  vi.restoreAllMocks();
});

function fixture(blocks: BlockInput[] = [{ type: "paragraph", text: "The current answer." }]) {
  const source = room(roomForDoc(WORKSPACE, CURRENT), true);
  const directory = room(directoryRoom(WORKSPACE), true);
  const catalog = room(settingsRoom(WORKSPACE), true);
  initDoc(source.connection.ydoc, { uuid: CURRENT, title: "Database for the hub" });
  setKind(source.connection.ydoc, "decision");
  for (const block of blocks) appendBlock(source.connection.ydoc, block);
  setStatus(source.connection.ydoc, "decided");
  upsertDirectoryEntry(directory.connection.ydoc, {
    uuid: CURRENT, title: "Database for the hub", kind: "decision", status: "decided",
    ...decisionDirectoryFields(source.connection.ydoc),
  });
  createTagCatalogEntry(catalog.connection.ydoc, "rfc", RFC_TAG);
  const session = {
    source: source.connection, directory: directory.connection, catalog: catalog.connection,
    identity: { name: "Default identity", color: "#e30c4e" },
    topicPath: docPath(WORKSPACE, CURRENT), segment: WORKSPACE, release: vi.fn(),
    cancellation: new AbortController(),
  };
  const recorded = vi.fn<(result: RecordedDecision) => void>();
  const close = vi.fn();
  return { source, directory, catalog, session, recorded, close };
}

async function open(data: ReturnType<typeof fixture>, displayName = "Current reader") {
  const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
  const view = await renderSettled(<Dialog open onOpenChange={(opened) => {
    if (!opened) { data.session.cancellation.abort(); data.close(); }
  }}><AlterDecisionDialog session={data.session} displayName={displayName}
    docLinks={null} onClose={data.close} onRecorded={data.recorded} /></Dialog>);
  const dialog = screen.getByRole("dialog", { name: "Alter decision" });
  const editor = (): Editor => {
    const instance = binding.mock.results.map((result) => result.value?.editor as Editor | null | undefined)
      .find((candidate): candidate is Editor => candidate?.isEditable === true);
    if (instance === undefined) throw new Error("No editable answer draft");
    return instance;
  };
  return { view, dialog, editor };
}

async function writeReason(dialog: HTMLElement): Promise<void> {
  await act(async () => fireEvent.change(within(dialog).getByRole("textbox", { name: /Why the change/ }), {
    target: { value: "A clearer answer is needed." },
  }));
}

async function replaceAnswer(editor: Editor, text: string): Promise<void> {
  await act(async () => editor.commands.setContent({ type: "doc", content: [
    { type: "paragraph", ...(text === "" ? {} : { content: [{ type: "text", text }] }) },
  ] }));
}

async function admitDestinations(): Promise<void> {
  await act(async () => {
    for (const held of acquired) update(held, LIVE);
    await Promise.resolve();
  });
}

function expectUnwritten(data: ReturnType<typeof fixture>): void {
  expect(listDirectory(data.directory.connection.ydoc, { includeDeleted: true }).map((entry) => entry.uuid)).toEqual([CURRENT]);
  expect(getBlocks(data.source.connection.ydoc).map((block) => block.text)).toEqual(["The current answer."]);
  expect(listTagCatalog(data.catalog.connection.ydoc)).toHaveLength(1);
  for (const held of acquired) {
    expect(getMeta(held.connection.ydoc).uuid).toBe("");
    expect(getBlocks(held.connection.ydoc)).toEqual([]);
  }
}

describe("Alter decision dialog", () => {
  it("edits an independent answer copy and leaves the source and comments untouched on Cancel", async () => {
    const data = fixture();
    createAnnotation(data.source.connection.ydoc, getBlocks(data.source.connection.ydoc)[0]!.id,
      0, 3, "Earlier reader", "Keep this comment on the original answer.");
    const sourceUpdates = vi.fn();
    const directoryUpdates = vi.fn();
    const catalogUpdates = vi.fn();
    data.source.connection.ydoc.on("update", sourceUpdates);
    data.directory.connection.ydoc.on("update", directoryUpdates);
    data.catalog.connection.ydoc.on("update", catalogUpdates);
    const { dialog, editor } = await open(data);
    expect(dialog.textContent).toContain("Database for the hub");
    expect(dialog.textContent).toContain("Decide puts the answer in force now under Current reader");
    expect(dialog.querySelector('[aria-label="Current answer"]')?.getAttribute("contenteditable")).toBe("false");
    expect(editor().getText()).toBe("The current answer.");
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" }).disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" }).disabled).toBe(false);
    await replaceAnswer(editor(), "A typed replacement answer.");
    await act(async () => within(dialog).getByRole("button", { name: "Cancel" }).click());
    expect(data.close).toHaveBeenCalledOnce();
    expect(data.recorded).not.toHaveBeenCalled();
    expect(acquired).toHaveLength(0);
    expectUnwritten(data);
    expect(sourceUpdates).not.toHaveBeenCalled();
    expect(directoryUpdates).not.toHaveBeenCalled();
    expect(catalogUpdates).not.toHaveBeenCalled();
  });

  it("requires a non-blank answer and a display name for Decide while an RFC can omit its reason", async () => {
    const data = fixture();
    const { dialog, editor } = await open(data, "  ");
    await writeReason(dialog);
    const decide = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" });
    const rfc = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" });
    expect(decide.disabled).toBe(true);
    expect(rfc.disabled).toBe(false);
    await replaceAnswer(editor(), "   ");
    expect(decide.disabled).toBe(true);
    expect(rfc.disabled).toBe(true);
    expect(dialog.textContent).toMatch(/non-blank.*answer/i);
    expect(acquired).toHaveLength(0);
    await replaceAnswer(editor(), "A shorter answer.");
    expect(rfc.disabled).toBe(false);
    expect(decide.disabled).toBe(true);
    expectUnwritten(data);
  });

  it("copies a three-block current answer but requires shortening it before either action", async () => {
    const data = fixture([
      { type: "paragraph", text: "One" }, { type: "paragraph", text: "Two" },
      { type: "paragraph", text: "Three" },
    ]);
    const { dialog, editor } = await open(data);
    await writeReason(dialog);
    expect(editor().getText()).toContain("Three");
    expect(dialog.textContent).toMatch(/at most two blocks/i);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" }).disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" }).disabled).toBe(true);
    await replaceAnswer(editor(), "The shortened answer.");
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" }).disabled).toBe(false);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" }).disabled).toBe(false);
    expect(acquired).toHaveLength(0);
    expect(getBlocks(data.source.connection.ydoc)).toHaveLength(3);
  });

  it.each(["heading", "unknown-answer-type"])("names an unsupported %s answer and makes both actions unavailable", async (type) => {
    const data = fixture(type === "heading" ? [{ type: "heading", text: "A heading" }] : []);
    if (type !== "heading") {
      const unknown = new Y.XmlElement(type);
      const text = new Y.XmlText();
      text.insert(0, "An unknown answer");
      unknown.insert(0, [text]);
      getBlocksFragment(data.source.connection.ydoc).insert(0, [unknown]);
    }
    const { dialog } = await open(data);
    await writeReason(dialog);
    expect(dialog.textContent).toContain(type);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" }).disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" }).disabled).toBe(true);
    expect(acquired).toHaveLength(0);
  });

  it("names an unsupported pasted block and enables actions again after it is removed without writing the source", async () => {
    const data = fixture();
    const sourceUpdates = vi.fn();
    data.source.connection.ydoc.on("update", sourceUpdates);
    const { dialog, editor } = await open(data);
    await writeReason(dialog);
    const decide = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decide" });
    const rfc = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Open an RFC instead" });
    expect(decide.disabled).toBe(false);
    expect(rfc.disabled).toBe(false);
    await act(async () => {
      editor().commands.selectAll();
      editor().view.pasteHTML("<h2>A heading pasted from another document</h2>",
        new Event("paste", { bubbles: true }) as ClipboardEvent);
    });
    expect(editor().state.doc.firstChild?.type.name).toBe("heading");
    expect(dialog.textContent).toMatch(/unsupported.*heading/i);
    expect(decide.disabled).toBe(true);
    expect(rfc.disabled).toBe(true);
    expectUnwritten(data);
    expect(sourceUpdates).not.toHaveBeenCalled();
    await replaceAnswer(editor(), "An answer using an allowed paragraph.");
    expect(decide.disabled).toBe(false);
    expect(rfc.disabled).toBe(false);
    expect(dialog.textContent).not.toMatch(/unsupported.*heading/i);
    expect(acquired).toHaveLength(0);
    expectUnwritten(data);
    expect(sourceUpdates).not.toHaveBeenCalled();
  });

  it.each([
    { dismissal: "Cancel", action: "Decide", rooms: 1 },
    { dismissal: "Escape", action: "Open an RFC instead", rooms: 2 },
    { dismissal: "outside", action: "Open an RFC instead", rooms: 2 },
  ])("$dismissal abandons a waiting $action without a late record, RFC or tag write", async ({ dismissal, action, rooms: count }) => {
    const data = fixture();
    const { dialog } = await open(data);
    await writeReason(dialog);
    await act(async () => within(dialog).getByRole("button", { name: action }).click());
    expect(acquired.filter((held) => held.connection !== data.directory.connection)).toHaveLength(count);
    expect(dialog.textContent).toMatch(/Waiting for the new rooms/i);
    expectUnwritten(data);
    await act(async () => {
      if (dismissal === "Cancel") within(dialog).getByRole("button", { name: "Cancel" }).click();
      else if (dismissal === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else {
        fireEvent.pointerDown(document.body, { button: 0 });
        fireEvent.click(document.body, { button: 0 });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(data.close).toHaveBeenCalledOnce();
    await admitDestinations();
    expectUnwritten(data);
    expect(data.recorded).not.toHaveBeenCalled();
    expect(acquired.every((held) => held.releases === 1)).toBe(true);
  });

  it.each(["archived", "unwritable"])("keeps the typed answer and reason when a waiting action becomes %s", async (state) => {
    const data = fixture();
    const { dialog, editor } = await open(data);
    await replaceAnswer(editor(), "Keep this typed answer.");
    await writeReason(dialog);
    await act(async () => within(dialog).getByRole("button", { name: "Decide" }).click());
    await act(async () => {
      if (state === "archived") tombstoneDirectoryEntry(data.directory.connection.ydoc, CURRENT);
      else update(data.source, { writable: false });
      await Promise.resolve();
    });
    await admitDestinations();
    expect(within(dialog).getByRole("alert").textContent).toMatch(state === "archived" ? /no longer.*answer|live topic/i : /writ/i);
    expect(dialog.textContent).toContain("Keep this typed answer.");
    expect(within(dialog).getByRole("textbox", { name: /Why the change/ })).toHaveProperty("value", "A clearer answer is needed.");
    expect(data.recorded).not.toHaveBeenCalled();
    expectUnwritten(data);
  });

  it.each(["Decide", "Open an RFC instead"])("hands the successful $0 result to navigation while retaining its destination rooms", async (action) => {
    const data = fixture();
    const { dialog, editor } = await open(data);
    await replaceAnswer(editor(), "The replacement answer.");
    if (action === "Decide") await writeReason(dialog);
    await act(async () => within(dialog).getByRole("button", { name: action }).click());
    expect(data.recorded).not.toHaveBeenCalled();
    await admitDestinations();
    expect(data.recorded).toHaveBeenCalledOnce();
    const result = data.recorded.mock.calls[0]![0];
    const topic = resolveDecisionTopics(data.directory.connection.ydoc)[0]!;
    const decision = room(roomForDoc(WORKSPACE, result.decision)).connection.ydoc;
    if (action === "Decide") {
      expect(topic.inForce?.uuid).toBe(result.decision);
      expect(getMeta(decision).decidedBy).toBe("Current reader");
      expect(getBlocks(decision).map((block) => block.text)).toEqual(["The replacement answer.", "A clearer answer is needed."]);
      expect(result.rfc).toBeUndefined();
    } else {
      expect(topic.inForce?.uuid).toBe(CURRENT);
      expect(topic.pending.map((entry) => entry.uuid)).toEqual([result.decision]);
      expect(result.rfc).toBeDefined();
      expect(getMeta(room(roomForDoc(WORKSPACE, result.rfc!)).connection.ydoc).tags).toEqual([RFC_TAG]);
    }
    expect(acquired.every((held) => held.releases === 0)).toBe(true);
    result.release();
    expect(acquired.every((held) => held.releases === 1)).toBe(true);
  });
});

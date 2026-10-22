/** The shell owns dialog rooms and hands recorded results to its page room. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import * as Y from "yjs";
import {
  appendBlock, decisionDirectoryFields, directoryRoom, initDoc, roomForDoc,
  setKind, setStatus, settingsRoom, upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { AlterDecisionSession, RecordedDecision } from "../src/ui/document/AlterDecisionDialog.js";
import { act, cleanup, renderSettled } from "./react-render.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const FIRST = "d4ee98ac-9a9c-4a81-a68d-d8ecc09ca509";
const NEXT = "e795b3c7-cd85-4e6f-8950-a4f479b077ba";
const RFC = "63c11ea4-0e60-40ee-a46d-6feef7e55b61";
const LIVE: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true, writable: true,
  storeRefused: false, unsyncedChanges: 0, hasAnswered: true,
  protocolMismatch: null, authFailed: false, tokenMissing: false,
};
const rooms = new Map<string, RoomConnection>();
const handles: { room: string; release: ReturnType<typeof vi.fn> }[] = [];
const events: string[] = [];
let session: AlterDecisionSession | null = null;
let onRecorded: ((result: RecordedDecision) => void) | null = null;

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name, ydoc: new Y.Doc(), provider: { awareness: null }, status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
  acquireRoom: (name: string) => {
    events.push(`acquire ${name}`);
    const release = vi.fn(() => { events.push(`release ${name}`); });
    handles.push({ room: name, release });
    return { connection: room(name), release };
  },
}));
vi.mock("../src/ui/document/AlterDecisionDialog.js", () => ({
  AlterDecisionDialog: (props: {
    session: AlterDecisionSession; onRecorded(result: RecordedDecision): void; onClose(): void;
  }) => {
    session = props.session;
    onRecorded = props.onRecorded;
    return <button type="button" onClick={props.onClose}>Cancel alteration</button>;
  },
}));
const { App } = await import("../src/ui/App.js");

function publishDecision(uuid: string, predecessor?: string): void {
  const ydoc = room(roomForDoc(WORKSPACE, uuid)).ydoc;
  initDoc(ydoc, {
    uuid, title: "The decision question",
    ...(predecessor === undefined ? {} : { topic: FIRST, supersedes: predecessor }),
  });
  setKind(ydoc, "decision");
  appendBlock(ydoc, { type: "paragraph", text: "The answer in force." });
  setStatus(ydoc, "decided");
  upsertDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, {
    uuid, title: "The decision question", kind: "decision", status: "decided",
    ...decisionDirectoryFields(ydoc),
    createdAt: predecessor === undefined ? 1 : 2,
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  }));
  publishDecision(FIRST);
  window.history.replaceState(null, "", `/${WORKSPACE}/${FIRST}`);
});

afterEach(() => {
  cleanup();
  rooms.clear();
  handles.length = 0;
  events.length = 0;
  session = null;
  onRecorded = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openAlteration() {
  const view = await renderSettled(<App />);
  const before = handles.length;
  await act(async () => within(view.container).getByRole("button", { name: "Alter decision" }).click());
  const held = handles.slice(before);
  expect(held.map((handle) => handle.room)).toEqual([
    roomForDoc(WORKSPACE, FIRST), directoryRoom(WORKSPACE), settingsRoom(WORKSPACE),
  ]);
  expect(session).not.toBeNull();
  return { view, held, cancellation: session!.cancellation };
}

it("releases the dialog's source, directory and catalog once when cancelled", async () => {
  const { view, held, cancellation } = await openAlteration();
  await act(async () => within(view.container).getByRole("button", { name: "Cancel alteration" }).click());
  expect(cancellation.signal.aborted).toBe(true);
  for (const handle of held) expect(handle.release).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
  for (const handle of held) expect(handle.release).toHaveBeenCalledTimes(1);
});

it("releases the dialog's source, directory and catalog once when the shell unmounts", async () => {
  const { view, held, cancellation } = await openAlteration();
  await act(async () => view.unmount());
  expect(cancellation.signal.aborted).toBe(true);
  for (const handle of held) expect(handle.release).toHaveBeenCalledTimes(1);
});

it("releases a recorded result once on unmount when its page room has not arrived", async () => {
  const { view, held } = await openAlteration();
  const release = vi.fn();
  await act(async () => onRecorded!({ ok: true, decision: NEXT, release }));
  expect(release).not.toHaveBeenCalled();
  for (const handle of held) expect(handle.release).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
  expect(release).toHaveBeenCalledTimes(1);
});

it.each(["decision", "rfc"] as const)(
  "keeps a recorded %s until the page acquires its room, then releases it once",
  async (kind) => {
    const { view, held, cancellation } = await openAlteration();
    const target = kind === "decision" ? NEXT : RFC;
    const release = vi.fn(() => { events.push("release recorded result"); });
    await act(async () => {
      if (kind === "decision") publishDecision(NEXT, FIRST);
      else {
        initDoc(room(roomForDoc(WORKSPACE, RFC)).ydoc, { uuid: RFC, title: "Decision discussion" });
        upsertDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, { uuid: RFC, title: "Decision discussion" });
      }
      onRecorded!({ ok: true, decision: NEXT, ...(kind === "rfc" ? { rfc: RFC } : {}), release });
      expect(release).not.toHaveBeenCalled();
    });
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${kind === "decision" ? FIRST : RFC}`);
    expect(events.indexOf(`acquire ${roomForDoc(WORKSPACE, target)}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("release recorded result")).toBeGreaterThan(
      events.indexOf(`acquire ${roomForDoc(WORKSPACE, target)}`),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(cancellation.signal.aborted).toBe(true);
    for (const handle of held) expect(handle.release).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
    expect(release).toHaveBeenCalledTimes(1);
  },
);

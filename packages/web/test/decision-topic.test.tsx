/** Topic navigation reads one record room while directory caches supply history. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  createGroup,
  decisionDirectoryFields,
  directoryRoom,
  getBlocks,
  getMeta,
  getMetaMap,
  initDoc,
  pinDoc,
  readSidebar,
  resolveDecisionTopics,
  exportMarkdown,
  roomForDoc,
  setKind,
  setStatus,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DecisionStatus } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as guardedBinding from "../src/editor/guarded-binding.js";
import { act, renderSettled } from "./react-render.js";
import { decisionRecordPath, docPath } from "../src/ui/route.js";
import { DecisionTopicPane } from "../src/ui/document/DecisionTopicPane.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const FIRST = "d4ee98ac-9a9c-4a81-a68d-d8ecc09ca509";
const CURRENT = "9ebf44bd-97f8-479d-8e7c-5fbc96173504";
const REJECTED = "a8eb89c4-579b-4ce4-af59-3b691df524de";
const WITHDRAWN = "4d1b5f24-52b1-4da3-954b-5dc7a5a9bd90";
const OPEN = "8e445dcd-e6fa-4467-941b-4fac98835b20";
const NEXT = "e795b3c7-cd85-4e6f-8950-a4f479b077ba";
const RELATED_FIRST = "f96ea9b7-012a-4f05-98b0-d92ac4c4b0df";
const RELATED_CURRENT = "34865e42-d48f-497a-8e1b-132c504a3e45";
const RFC = "63c11ea4-0e60-40ee-a46d-6feef7e55b61";
const EARLIER_RFC = "f39308d6-bb89-46e8-a407-e1f9a004a139";
const DATE = "2026-10-09T10:00:00Z";
const CREATED = Date.parse("2026-10-08T10:00:00Z");
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

const rooms = new Map<string, RoomConnection>();
const acquired: string[] = [];
function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => {
    acquired.push(name);
    return { connection: room(name), release: () => {} };
  },
}));
const { App } = await import("../src/ui/App.js");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T10:00:00Z"));
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
});

afterEach(() => {
  rooms.clear();
  acquired.length = 0;
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface RecordOptions {
  supersedes?: string;
  related?: string;
  discussion?: string;
  answerer?: string;
  answerDate?: string;
  agent?: boolean;
  rejectionReason?: string;
  order?: number;
  cache?: boolean;
  publish?: boolean;
  createdAt?: number | null;
}

function directory(): Y.Doc {
  return room(directoryRoom(WORKSPACE)).ydoc;
}

function record(uuid: string, title: string, status: DecisionStatus, answer: string, options: RecordOptions = {}): Y.Doc {
  const ydoc = room(roomForDoc(WORKSPACE, uuid)).ydoc;
  initDoc(ydoc, {
    uuid, title,
    ...(options.supersedes === undefined ? {} : { topic: FIRST, supersedes: options.supersedes }),
    ...(options.related === undefined ? {} : { governs: options.related }),
  });
  setKind(ydoc, "decision");
  appendBlock(ydoc, { type: "paragraph", text: answer });
  const meta = getMetaMap(ydoc);
  if (options.discussion !== undefined) meta.set("discussion", options.discussion);
  if (options.answerer !== undefined) meta.set("decidedBy", options.answerer);
  if (options.answerDate !== undefined) meta.set("decidedAt", options.answerDate);
  if (options.agent !== undefined) meta.set("agentStance", options.agent);
  if (options.rejectionReason !== undefined) meta.set("rejectionReason", options.rejectionReason);
  setStatus(ydoc, status);
  if (options.publish !== false) publishRecord(ydoc, options);
  return ydoc;
}

function publishRecord(ydoc: Y.Doc, options: RecordOptions = {}): void {
  const meta = getMetaMap(ydoc);
  upsertDirectoryEntry(directory(), {
    uuid: String(meta.get("uuid")), title: String(meta.get("title")),
    kind: "decision", status: meta.get("status") as DecisionStatus,
    topic: String(meta.get("topic") ?? meta.get("uuid")),
    ...(typeof meta.get("supersedes") === "string" ? { supersedes: String(meta.get("supersedes")) } : {}),
    ...(options.cache === false ? {} : decisionDirectoryFields(ydoc)),
    ...(options.createdAt === null ? {} : { createdAt: options.createdAt ?? CREATED + (options.order ?? 0) * 1000 }),
  });
}

function regular(uuid: string, title: string): void {
  upsertDirectoryEntry(directory(), { uuid, title, createdAt: CREATED });
}

function story(): void {
  regular(RELATED_FIRST, "Original related page");
  regular(RELATED_CURRENT, "Current related page");
  regular(RFC, "Proposal discussion");
  regular(EARLIER_RFC, "Earlier discussion");
  const first = record(FIRST, "Original title", "decided", "Keep the original answer.", { related: RELATED_FIRST, discussion: EARLIER_RFC, agent: true });
  createAnnotation(first, getBlocks(first)[0]!.id, 0, 4, "Earlier reader", "Earlier record comment");
  publishRecord(first);
  const current = record(CURRENT, "Current topic title", "decided", "Use the current answer.", {
    supersedes: FIRST, related: RELATED_CURRENT, answerer: "Ben", answerDate: DATE, order: 1,
  });
  createAnnotation(current, getBlocks(current)[0]!.id, 0, 3, "Current reader", "Current record comment");
  publishRecord(current, { order: 1 });
  record(REJECTED, "Rejected proposal", "rejected", "Use the rejected alternative.", {
    supersedes: CURRENT, answerer: "Alex", answerDate: "2026-10-10T12:00:00Z", rejectionReason: "It loses compatibility.", order: 2,
  });
  record(WITHDRAWN, "Withdrawn proposal", "withdrawn", "A withdrawn alternative.", { supersedes: REJECTED, order: 3 });
  record(OPEN, "Open proposal", "open", "A replacement under discussion.", { supersedes: CURRENT, discussion: RFC, order: 4 });
}

async function open(path = docPath(WORKSPACE, FIRST)) {
  window.history.replaceState(null, "", path);
  return renderSettled(<App />);
}

function timeline(host: HTMLElement): HTMLElement {
  return within(host).getByRole("region", { name: "Decision history" });
}

function item(host: HTMLElement, uuid: string): HTMLElement {
  const entry = timeline(host).querySelector<HTMLElement>(`li[data-record="${uuid}"]`);
  if (entry === null) throw new Error(`No timeline record ${uuid}`);
  return entry;
}

function answer(host: HTMLElement): HTMLElement {
  expect(host.querySelector(".ub-decision-related")).toBeNull();
  expect(host.textContent).not.toContain("Related page:");
  const area = host.querySelector<HTMLElement>(".ub-decision-answer");
  if (area === null) throw new Error("No selected answer");
  return area;
}

function answerHeader(host: HTMLElement): HTMLElement {
  const headers = host.querySelectorAll<HTMLElement>(".ub-decision-answer-header");
  expect(headers).toHaveLength(1);
  const header = headers[0]!;
  expect(header.textContent).toContain("ANSWER");
  expect(host.querySelector(".ub-decision-topic-state")).toBeNull();
  expect(host.querySelector(".ub-decision-answer-label")).toBeNull();
  return header;
}

function expectAnswerState(host: HTMLElement, label: string): void {
  const pills = answerHeader(host).querySelectorAll(".ub-decision-answer-state");
  expect(pills).toHaveLength(1);
  expect(pills[0]?.textContent).toBe(label);
}

function selection(host: HTMLElement): string | null {
  return timeline(host).querySelector("[aria-current=true]")?.closest("li")?.getAttribute("data-record") ?? null;
}

async function choose(host: HTMLElement, uuid: string): Promise<void> {
  const link = item(host, uuid).querySelector<HTMLAnchorElement>(".ub-decision-record");
  if (link === null) throw new Error(`No record link ${uuid}`);
  await act(async () => link.click());
}

async function back(): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true }));
    window.history.back();
    await popped;
  });
}

function copiedUrls(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

async function copy(host: HTMLElement): Promise<void> {
  await act(async () => {
    const trigger = within(host).getByRole("button", { name: "Document actions" });
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await act(async () => screen.getByRole("menuitem", { name: "Copy link" }).click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("decision topic navigation and history", () => {
  it.each(["open", "decided", "rejected", "withdrawn"] as const)("renames the current %s record while its answer stays read-only", async (status) => {
    const ydoc = record(FIRST, "Original question", status, "Stored answer.");
    const host = (await open()).container;
    const title = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    expect(title.readOnly).toBe(false);
    expect(host.querySelector(".ub-lifecycle-badge")?.textContent).toBe("Decision");
    await act(async () => fireEvent.change(title, { target: { value: "Clearer question" } }));
    expect(getMeta(ydoc).title).toBe("Clearer question");
    expect(getBlocks(ydoc)[0]?.text).toBe("Stored answer.");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
  });

  it("renames only the answer in force during review, then keeps the current title read-only in history", async () => {
    story();
    const host = (await open()).container;
    const title = () => within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    await act(async () => fireEvent.change(title(), { target: { value: "Renamed current question" } }));
    expect(getMeta(room(roomForDoc(WORKSPACE, CURRENT)).ydoc).title).toBe("Renamed current question");
    expect(getMeta(room(roomForDoc(WORKSPACE, OPEN)).ydoc).title).toBe("Open proposal");
    await choose(host, FIRST);
    expect(title().value).toBe("Renamed current question");
    expect(title().readOnly).toBe(true);
    expect(host.querySelector(".ub-lifecycle-badge")?.textContent).toBe("Decision");
    await act(async () => fireEvent.change(title(), { target: { value: "Historical rename" } }));
    expect(getMeta(room(roomForDoc(WORKSPACE, FIRST)).ydoc).title).toBe("Original title");
    expect(getMeta(room(roomForDoc(WORKSPACE, CURRENT)).ydoc).title).toBe("Renamed current question");
    await act(async () => within(host).getByRole("link", { name: "Go to the current answer" }).click());
    expect(title().readOnly).toBe(false);
  });

  it("renames the latest record during a conflict and keeps the other answer's title", async () => {
    record(FIRST, "Initial question", "decided", "Initial stance.", { agent: true });
    record(CURRENT, "Left question", "decided", "Left answer.", { supersedes: FIRST, order: 1 });
    const latest = record(NEXT, "Right question", "decided", "Right answer.", { supersedes: FIRST, order: 2 });
    const host = (await open()).container;
    const title = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    expect(title.readOnly).toBe(false);
    await act(async () => fireEvent.change(title, { target: { value: "Renamed conflict question" } }));
    expect(getMeta(latest).title).toBe("Renamed conflict question");
    expect(getMeta(room(roomForDoc(WORKSPACE, CURRENT)).ydoc).title).toBe("Left question");
    await choose(host, CURRENT);
    expect(within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" }).readOnly).toBe(true);
  });

  it("refuses title writes when the room is unwritable or the live directory archives the topic", async () => {
    const ydoc = record(FIRST, "Original question", "decided", "Stored answer.");
    const connection = room(roomForDoc(WORKSPACE, FIRST));
    Object.defineProperty(connection, "status", { value: { ...LIVE, writable: false }, configurable: true });
    Object.defineProperty(connection, "onStatusChange", { value: (listener: (status: RoomStatus) => void) => {
      listener(connection.status);
      return () => {};
    } });
    const view = await open();
    const title = within(view.container).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    expect(title.readOnly).toBe(true);
    await act(async () => fireEvent.change(title, { target: { value: "Refused rename" } }));
    expect(getMeta(ydoc).title).toBe("Original question");
    view.unmount();
    Object.defineProperty(connection, "status", { value: LIVE });
    const live = (await open()).container;
    const liveTitle = within(live).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    expect(liveTitle.readOnly).toBe(false);
    await act(async () => {
      tombstoneDirectoryEntry(directory(), FIRST);
      fireEvent.change(liveTitle, { target: { value: "Archived rename before render" } });
    });
    expect(getMeta(ydoc).title).toBe("Original question");
    expect(liveTitle.readOnly).toBe(true);
  });

  it("refuses a stale title event when the current record changes before rendering", async () => {
    const first = record(FIRST, "Original question", "decided", "Stored answer.");
    const host = (await open()).container;
    const oldTitle = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    await act(async () => {
      record(CURRENT, "Replacement question", "decided", "Replacement answer.", { supersedes: FIRST, order: 1 });
      fireEvent.change(oldTitle, { target: { value: "Stale rename" } });
    });
    expect(getMeta(first).title).toBe("Original question");
    const title = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    expect(title.value).toBe("Replacement question");
    expect(title.readOnly).toBe(false);
    const connection = room(roomForDoc(WORKSPACE, CURRENT));
    Object.defineProperty(connection, "status", { value: { ...LIVE, writable: false } });
    await act(async () => fireEvent.change(title, { target: { value: "Rename after refusal before render" } }));
    expect(getMeta(connection.ydoc).title).toBe("Replacement question");
  });

  it("shows live related topics as page chrome without acquiring record rooms or changing page content", async () => {
    story();
    const ydoc = room(roomForDoc(WORKSPACE, RELATED_FIRST)).ydoc;
    initDoc(ydoc, { uuid: RELATED_FIRST, title: "Original related page" });
    appendBlock(ydoc, { type: "paragraph", text: "The owning page's prose." });
    appendBlock(ydoc, { type: "heading", text: "Related", level: 2 });
    appendBlock(ydoc, { type: "paragraph", text: "Other guidance." });
    const blocks = getBlocks(ydoc);
    const markdown = exportMarkdown(ydoc, { directory: directory() });
    const pageUpdates = vi.fn();
    ydoc.on("update", pageUpdates);
    const host = (await open(docPath(WORKSPACE, RELATED_FIRST))).container;
    const block = within(host).getByRole("region", { name: "Decisions" });
    expect(within(block).getByRole("link", { name: "Under review: Current topic title" }).getAttribute("href"))
      .toBe(docPath(WORKSPACE, FIRST));
    expect(block.textContent).toContain("Use the current answer.");
    expect(block.textContent).not.toContain("A replacement under discussion.");
    expect(block.closest(".ub-editor")).toBeNull();
    expect((host.querySelector(".ub-editor")?.compareDocumentPosition(block) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(getBlocks(ydoc)).toEqual(blocks);
    expect(exportMarkdown(ydoc, { directory: directory() })).toBe(markdown);
    const jump = within(host).getByRole("link", { name: /1 decision · 1 under review/ });
    await act(async () => jump.click());
    expect(document.activeElement).toBe(block);
    expect(window.location.pathname).toBe(docPath(WORKSPACE, RELATED_FIRST));
    await act(async () => tombstoneDirectoryEntry(directory(), FIRST));
    expect(within(host).queryByRole("region", { name: "Decisions" })).toBeNull();
    expect(host.querySelector(".ub-decisions-link")).toBeNull();
    expect(pageUpdates).not.toHaveBeenCalled();
    expect(acquired.filter((name) => [FIRST, CURRENT, REJECTED, WITHDRAWN, OPEN].some((uuid) => name === roomForDoc(WORKSPACE, uuid)))).toEqual([]);
    ydoc.off("update", pageUpdates);
  });

  it("adds the block when a related topic arrives, then opens its current answer", async () => {
    const ydoc = room(roomForDoc(WORKSPACE, RELATED_FIRST)).ydoc;
    initDoc(ydoc, { uuid: RELATED_FIRST, title: "A page without headings" });
    appendBlock(ydoc, { type: "paragraph", text: "Read this first." });
    regular(RELATED_FIRST, "A page without headings");
    const host = (await open(docPath(WORKSPACE, RELATED_FIRST))).container;
    expect(within(host).queryByRole("region", { name: "Decisions" })).toBeNull();
    await act(async () => {
      record(FIRST, "A new question", "decided", "A current answer with no cached preview.", { related: RELATED_FIRST, cache: false });
      upsertDirectoryEntry(directory(), { uuid: FIRST, title: "A new question", governs: RELATED_FIRST });
    });
    const row = within(host).getByRole("link", { name: "In force: A new question" });
    expect(row.querySelector(".ub-decisions-row-preview")).toBeNull();
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, FIRST));
    await act(async () => row.click());
    expect(window.location.pathname).toBe(docPath(WORKSPACE, FIRST));
    expect(host.querySelector(".ub-decisions-block")).toBeNull();
    expect(selection(host)).toBe(FIRST);
    await back();
    expect(within(host).getByRole("region", { name: "Decisions" })).toBeDefined();
  });

  it("keeps older recorded answer dates relative without using edit timestamps", async () => {
    record(FIRST, "Longstanding answer", "decided", "A longstanding answer.", { answerer: "Ben", answerDate: "2020-01-01T00:00:00Z" });
    upsertDirectoryEntry(directory(), { uuid: FIRST, title: "Longstanding answer", updatedAt: Date.now() });
    const host = (await open()).container;
    const time = item(host, FIRST).querySelector("time");
    expect(time?.dateTime).toBe("2020-01-01T00:00:00.000Z");
    expect(time?.textContent).toMatch(/years ago$/);
  });

  it.each([
    [docPath(WORKSPACE, FIRST), FIRST],
    [docPath(WORKSPACE, CURRENT), FIRST],
    [decisionRecordPath(WORKSPACE, FIRST, REJECTED), FIRST],
    [decisionRecordPath(WORKSPACE, FIRST, FIRST), CURRENT],
  ])("keeps topic pins and their sidebar highlight while reading %s", async (path, pinnedRecord) => {
    story();
    const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
    const group = createGroup(sidebar, "Reading");
    pinDoc(sidebar, group, pinnedRecord);
    pinDoc(sidebar, group, RELATED_CURRENT);
    const host = (await open(path)).container;
    const pinnedRow = within(host).getByRole("button", { name: pinnedRecord === FIRST ? "Original title" : "Current topic title" });
    expect(pinnedRow.getAttribute("aria-current")).toBe("page");
    await act(async () => within(host).getByRole("button", { name: "Document actions" })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(screen.queryByRole("menuitem", { name: "Pin to sidebar" })).toBeNull();
    await act(async () => screen.getByRole("menuitem", { name: "Unpin from sidebar" }).click());
    expect(readSidebar(sidebar)[0]?.docs).toEqual([RELATED_CURRENT]);
    await act(async () => within(host).getByRole("button", { name: "Document actions" })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => screen.getByRole("menuitem", { name: "Pin to sidebar" }).click());
    expect(readSidebar(sidebar)[0]?.docs).toEqual([RELATED_CURRENT, FIRST]);
    expect(within(host).getByRole("button", { name: "Original title" }).getAttribute("aria-current")).toBe("page");
  });

  it("unpins every stored topic pin without unpinning another document", async () => {
    story();
    const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
    const group = createGroup(sidebar, "Reading");
    pinDoc(sidebar, group, FIRST);
    pinDoc(sidebar, createGroup(sidebar, "Later"), CURRENT);
    pinDoc(sidebar, group, RELATED_CURRENT);
    const host = (await open(decisionRecordPath(WORKSPACE, FIRST, REJECTED))).container;
    await act(async () => within(host).getByRole("button", { name: "Document actions" })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => screen.getByRole("menuitem", { name: "Unpin from sidebar" }).click());
    expect(readSidebar(sidebar).flatMap((entry) => entry.docs)).toEqual([RELATED_CURRENT]);
  });

  it("opens a superseded link at the current answer and keeps the named record reachable", async () => {
    story();
    const host = (await open()).container;
    expect(within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" }).value).toBe("Current topic title");
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    expect(answer(host).textContent).toContain("Use the current answer.");
    expectAnswerState(host, "In force");
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Ben · 4 weeks ago");
    expect(answerHeader(host).querySelector("time")?.dateTime).toBe(new Date(DATE).toISOString());
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("stays in force");
    expect(selection(host)).toBe(CURRENT);
    expect(item(host, FIRST).textContent).toContain("Linked record");
    expect(item(host, FIRST).textContent).toContain("Superseded");
    expect(within(item(host, FIRST)).getByLabelText("1 comment")).toBeDefined();
    expect(item(host, REJECTED).textContent).toContain("Rejected");
    expect(item(host, REJECTED).querySelector("time")?.dateTime).toBe("2026-10-10T12:00:00.000Z");
    expect(item(host, WITHDRAWN).textContent).toContain("Withdrawn");
    expect(item(host, OPEN).textContent).toContain("Under review");
    expect(item(host, OPEN).querySelector("time")?.dateTime).toBe(new Date(CREATED + 4000).toISOString());
    expect(within(item(host, OPEN)).getByRole("link", { name: "Proposal discussion" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(host.querySelector(".ub-threads-pane")?.textContent ?? host.textContent).toContain("Current record comment");
    expect(host.textContent).not.toContain("Earlier record comment");
    expect(timeline(host).querySelectorAll("li")).toHaveLength(5);
    expect(acquired.filter((name) => [FIRST, CURRENT, REJECTED, WITHDRAWN, OPEN].some((uuid) => name === roomForDoc(WORKSPACE, uuid)))).toEqual([roomForDoc(WORKSPACE, CURRENT)]);
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, RFC));
  });

  it("renders cached history newest first with matching answer pills and the rail through the answer in force", async () => {
    story();
    const host = (await open()).container;
    const history = timeline(host);
    expect(within(history).getByRole("heading", { name: "HISTORY" }).textContent).toBe("HISTORY");
    expect([...history.querySelectorAll("li")].map((row) => row.getAttribute("data-record")))
      .toEqual([OPEN, WITHDRAWN, REJECTED, CURRENT, FIRST]);
    expect(item(host, FIRST).querySelector(".ub-decision-linked")?.textContent?.trim()).toBe("Linked record");
    const rows = [
      { uuid: OPEN, state: "under-review", label: "Under review", event: null, green: true },
      { uuid: WITHDRAWN, state: "withdrawn", label: "Withdrawn", event: null, green: true },
      { uuid: REJECTED, state: "rejected", label: "Rejected", event: "Alex rejected the proposal from 4 weeks ago", green: true },
      { uuid: CURRENT, state: "in-force", label: "In force", event: "Ben decided", green: true },
      { uuid: FIRST, state: "superseded", label: "Superseded", event: "Agent stance, never confirmed", green: false },
    ];
    for (const { uuid, state, label, event, green } of rows) {
      const row = item(host, uuid);
      expect(row.getAttribute("data-state")).toBe(state);
      expect(row.getAttribute("data-in-force")).toBe(String(uuid === CURRENT));
      expect(row.getAttribute("data-rail-green")).toBe(String(green));
      expect(row.querySelector(".ub-decision-answer-state")?.textContent).toBe(label);
      expect(row.querySelector(".ub-decision-event")?.textContent ?? null).toBe(event);
      await choose(host, uuid);
      expectAnswerState(host, label);
    }
    expect(item(host, FIRST).querySelector(".ub-decision-selection")?.textContent?.trim()).toBe("viewing");
    expect(history.textContent).not.toContain("Selected");
    expect(within(item(host, CURRENT)).getByLabelText("1 comment")).toBeDefined();
    expect(within(item(host, OPEN)).getByLabelText("0 comments")).toBeDefined();
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, RFC));
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, EARLIER_RFC));
  });

  it.each([
    { label: "a recorded rejection without a creation date", options: { answerer: "Ben (@bk-one)", createdAt: null }, event: "Ben (@bk-one) rejected the proposal" },
    { label: "a rejection without a recorded person", options: {}, event: null },
  ])("uses only cached attribution for $label", async ({ options, event }) => {
    record(FIRST, "Rejected proposal", "rejected", "A rejected answer.", { ...options, answerDate: DATE });
    if (options.createdAt === null) {
      Object.defineProperty(room(directoryRoom(WORKSPACE)), "status", { value: { ...LIVE, writable: false } });
    }
    const host = (await open()).container;
    const row = item(host, FIRST);
    expect(row.querySelector(".ub-decision-event")?.textContent ?? null).toBe(event);
    expect(row.querySelector(".ub-decision-answer-state")?.textContent).toBe("Rejected");
    expect(row.getAttribute("data-in-force")).toBe("false");
    expect(row.getAttribute("data-rail-green")).toBe("false");
  });

  it("leaves absent history caches empty and keeps rejected RFC links independent of record links", async () => {
    regular(RFC, "Archived rejection discussion");
    tombstoneDirectoryEntry(directory(), RFC);
    record(FIRST, "Current answer", "decided", "The answer in force.", { agent: true });
    record(REJECTED, "Rejected alternative", "rejected", "A rejected answer.", {
      supersedes: FIRST, discussion: RFC, answerer: "  Ben (@bk-one)  ", answerDate: DATE, rejectionReason: "Only in the selected record room.", order: 1,
    });
    record(OPEN, "Uncached proposal", "open", "A preview that has not been cached.", { supersedes: FIRST, cache: false, order: 2 });
    const host = (await open()).container;
    const rejected = item(host, REJECTED);
    const recordLink = rejected.querySelector<HTMLAnchorElement>(".ub-decision-record");
    const rfcLink = within(rejected).getByRole("link", { name: /^Archived rejection discussion/ });
    expect(recordLink?.getAttribute("href")).toBe(decisionRecordPath(WORKSPACE, FIRST, REJECTED));
    expect(rfcLink.getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(rfcLink.getAttribute("data-doc-link-state")).toBe("archived");
    expect(rfcLink.closest(".ub-decision-record")).toBeNull();
    expect(rejected.querySelectorAll("a a")).toHaveLength(0);
    expect(rejected.textContent).not.toContain("Only in the selected record room.");
    expect(rejected.querySelector(".ub-decision-event")?.textContent).toBe("  Ben (@bk-one)   rejected the proposal from 4 weeks ago");
    expect(item(host, OPEN).querySelector(".ub-decision-preview")).toBeNull();
    expect(item(host, OPEN).querySelector(".ub-decision-record-comments")).toBeNull();
    expect(item(host, OPEN).querySelector(".ub-decision-record-rfc")).toBeNull();
    expect(item(host, FIRST).querySelector(".ub-decision-event")).toBeNull();
    expect(item(host, FIRST).getAttribute("data-in-force")).toBe("true");
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, REJECTED));
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, OPEN));
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, RFC));
  });

  it("shares explicit selections, restores them through Back and opens the matching comments", async () => {
    story();
    const writeText = copiedUrls();
    const view = await open();
    const host = view.container;
    await copy(host);
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}${docPath(WORKSPACE, FIRST)}`);
    await choose(host, REJECTED);
    const rejectedPath = decisionRecordPath(WORKSPACE, FIRST, REJECTED);
    expect(window.location.pathname).toBe(rejectedPath);
    expect(selection(host)).toBe(REJECTED);
    expect(answer(host).textContent).toContain("Use the rejected alternative.");
    expectAnswerState(host, "Rejected");
    expect(answer(host).classList.contains("ub-decision-answer-history")).toBe(true);
    expect(host.querySelector(".ub-decision-rejection")?.textContent).toContain("It loses compatibility.");
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Alex · 3 weeks ago");
    expect(within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" }).value).toBe("Current topic title");
    await copy(host);
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}${rejectedPath}`);
    await choose(host, FIRST);
    expect(window.location.pathname).toBe(decisionRecordPath(WORKSPACE, FIRST, FIRST));
    expect(host.textContent).toContain("Earlier record comment");
    expect(host.textContent).not.toContain("Current record comment");
    expectAnswerState(host, "Superseded");
    expect(answer(host).classList.contains("ub-decision-answer-history")).toBe(true);
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Agent stance · 4 weeks ago");
    expect(host.querySelector(".ub-decision-earlier-answer")?.textContent).toContain("Earlier answer. Replaced 4 weeks ago; it no longer applies.");
    await back();
    expect(selection(host)).toBe(REJECTED);
    view.unmount();
    const reopened = await renderSettled(<App />);
    expect(selection(reopened.container)).toBe(REJECTED);
    await act(async () => within(reopened.container).getByRole("link", { name: "Go to the current answer" }).click());
    expect(window.location.pathname).toBe(docPath(WORKSPACE, FIRST));
    expect(selection(reopened.container)).toBe(CURRENT);
  });

  it("follows a newly approved answer while an ordinary linked record keeps its identity", async () => {
    story();
    const host = (await open(docPath(WORKSPACE, CURRENT))).container;
    expect(selection(host)).toBe(CURRENT);
    await act(async () => record(NEXT, "New current title", "decided", "The newly approved answer.", {
      supersedes: CURRENT, related: RELATED_FIRST, answerer: "Ben", answerDate: "2026-10-12T09:00:00Z", order: 5,
    }));
    expect(selection(host)).toBe(NEXT);
    expect(answer(host).textContent).toContain("The newly approved answer.");
    expect(within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" }).value).toBe("New current title");
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    expect(item(host, CURRENT).textContent).toContain("Linked record");
    expect(window.location.pathname).toBe(docPath(WORKSPACE, CURRENT));
  });

  it("uses the latest stored record when nothing is in force without inventing proposal data", async () => {
    regular(RFC, "Open RFC document");
    record(FIRST, "Unanswered topic", "open", "First open proposal.", { discussion: RFC });
    record(REJECTED, "Rejected latest", "rejected", "Rejected latest answer.", {
      supersedes: FIRST, answerer: "Alex", answerDate: DATE, rejectionReason: "Needs another approach.", order: 1,
    });
    record(OPEN, "Unknown cached proposal", "open", "Unknown preview from this room.", {
      supersedes: FIRST, order: 2, cache: false,
    });
    record(WITHDRAWN, "Latest withdrawn record", "withdrawn", "Withdrawn latest answer.", { supersedes: OPEN, order: 3 });
    const host = (await open()).container;
    expect(selection(host)).toBe(WITHDRAWN);
    expect(answer(host).textContent).toContain("Withdrawn latest answer.");
    expectAnswerState(host, "Withdrawn");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("Not yet decided.");
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Opened 4 weeks ago");
    expect(host.querySelector(".ub-decision-related")).toBeNull();
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
    expect(within(host).queryByRole("link", { name: "Open proposal" })).toBeNull();
    expect(item(host, OPEN).textContent).not.toContain("Unknown preview from this room");
    expect(item(host, OPEN).querySelector(".ub-decision-preview")).toBeNull();
    expect(item(host, OPEN).querySelector(".ub-decision-record-rfc")).toBeNull();
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, OPEN));
  });

  it("labels an unanswered record once and links its discussion without changing the timeline", async () => {
    regular(RFC, "Unanswered RFC");
    record(FIRST, "Still under discussion", "open", "The initial proposal.", { discussion: RFC });
    const host = (await open()).container;
    expectAnswerState(host, "Not yet decided");
    expect(host.querySelector(".ub-decision-notice")?.textContent).not.toContain("Not yet decided");
    expect(item(host, FIRST).querySelector(".ub-decision-answer-state")?.textContent).toBe("Not yet decided");
    expect(item(host, FIRST).getAttribute("data-rail-green")).toBe("false");
    expect(answer(host).textContent).toContain("The initial proposal.");
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Unanswered RFC");
    expect(within(host).getByRole("link", { name: "Open proposal" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Opened 4 weeks ago");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
  });

  it("counts several pending proposals while each keeps its own RFC link", async () => {
    story();
    record(NEXT, "Another pending proposal", "open", "A parallel proposal.", { supersedes: CURRENT, order: 5 });
    const host = (await open()).container;
    expectAnswerState(host, "In force");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("Under review.");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("2 pending proposals");
    expect(within(host).queryByRole("link", { name: "Open proposal" })).toBeNull();
    expect(within(item(host, OPEN)).getByRole("link", { name: "Proposal discussion" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(item(host, NEXT).querySelector(".ub-decision-record-rfc")).toBeNull();
    expect(answer(host).textContent).toContain("Use the current answer.");
    await choose(host, NEXT);
    expectAnswerState(host, "Under review");
    expect(host.querySelector(".ub-decision-notice")).toBeNull();
  });

  it.each([
    [WITHDRAWN, "Withdrawn"],
    [OPEN, "Under review"],
  ])("keeps the muted answer and return link when selecting %s", async (uuid, label) => {
    story();
    const host = (await open(decisionRecordPath(WORKSPACE, FIRST, uuid))).container;
    expectAnswerState(host, label);
    expect(answer(host).classList.contains("ub-decision-answer-history")).toBe(true);
    const returnLink = within(host).getByRole("link", { name: "Go to the current answer" });
    expect(returnLink.getAttribute("href")).toBe(docPath(WORKSPACE, FIRST));
    expect(host.querySelector(".ub-decision-notice")).toBeNull();
    if (uuid === OPEN) expect(item(host, OPEN).querySelector(".ub-decision-answer-state")?.textContent).toBe("Under review");
    await act(async () => returnLink.click());
    expectAnswerState(host, "In force");
    expect(answer(host).classList.contains("ub-decision-answer-history")).toBe(false);
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
  });

  it.each<{ label: string; status: DecisionStatus; options: RecordOptions; text: string | null; dateTime?: string }>([
    {
      label: "a date-only recorded answer", status: "decided",
      options: { answerer: "Ben (@bk-one)", answerDate: "2026-10-09" },
      text: "Ben (@bk-one) · 4 weeks ago", dateTime: "2026-10-09T00:00:00.000Z",
    },
    {
      label: "an older recorded answer without a person", status: "decided",
      options: { answerDate: "2026-09-01T10:00:00Z" },
      text: "2 months ago", dateTime: "2026-09-01T10:00:00.000Z",
    },
    {
      label: "a person with an unparseable decision date", status: "decided",
      options: { answerer: "  Ben (@bk-one)  ", answerDate: "sometime last month" },
      text: "  Ben (@bk-one)  ",
    },
    { label: "a recorded answer with no attribution", status: "decided", options: {}, text: null },
    {
      label: "an unparseable decision date without a person", status: "rejected",
      options: { answerDate: "not a date" }, text: null,
    },
    {
      label: "an older agent stance", status: "decided",
      options: { agent: true, createdAt: Date.parse("2026-09-01T10:00:00Z") },
      text: "2 months ago", dateTime: "2026-09-01T10:00:00.000Z",
    },
    { label: "an agent stance without its creation date", status: "decided", options: { agent: true, createdAt: null }, text: null },
    {
      label: "an open proposal", status: "open",
      options: { answerer: "Ignored", answerDate: DATE, createdAt: Date.parse("2026-09-01T10:00:00Z") },
      text: "Opened 2 months ago", dateTime: "2026-09-01T10:00:00.000Z",
    },
    { label: "a withdrawn proposal without its creation date", status: "withdrawn", options: { createdAt: null }, text: null },
  ])("uses only stored, valid attribution for $label", async ({ status, options, text, dateTime }) => {
    record(FIRST, "Attribution example", status, "An answer.", options);
    if (options.createdAt === null) {
      Object.defineProperty(room(directoryRoom(WORKSPACE)), "status", { value: { ...LIVE, writable: false } });
    }
    const host = (await open()).container;
    if (status === "open") expect(host.querySelector(".ub-decision-notice")).toBeNull();
    const attribution = answerHeader(host).querySelector(".ub-decision-attribution");
    const historyTime = item(host, FIRST).querySelector("time");
    if (dateTime === undefined) {
      expect(historyTime).toBeNull();
    } else {
      expect(historyTime?.dateTime).toBe(dateTime);
      expect(historyTime?.title).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dateTime)));
    }
    if (text === null) {
      expect(attribution).toBeNull();
    } else {
      expect(attribution?.textContent).toBe(text);
      const time = attribution?.querySelector("time");
      if (dateTime === undefined) {
        expect(time).toBeNull();
      } else {
        expect(time?.dateTime).toBe(dateTime);
        expect(time?.title).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dateTime)));
      }
    }
  });

  it("dates an earlier answer from the first decided replacement through rejected and withdrawn records", async () => {
    record(FIRST, "Earlier answer", "decided", "The original answer.", { answerer: "Ben", answerDate: "2026-09-01" });
    record(REJECTED, "Rejected attempt", "rejected", "Rejected attempt.", { supersedes: FIRST, answerDate: "2026-09-05", order: 1 });
    record(WITHDRAWN, "Withdrawn attempt", "withdrawn", "Withdrawn attempt.", { supersedes: REJECTED, order: 2 });
    record(CURRENT, "First replacement", "decided", "The first replacement.", {
      supersedes: WITHDRAWN, answerer: "Ben", answerDate: DATE, order: 3,
    });
    record(NEXT, "Latest replacement", "decided", "The latest replacement.", {
      supersedes: CURRENT, answerer: "Alex", answerDate: "2026-11-01", order: 4,
    });
    const host = (await open(decisionRecordPath(WORKSPACE, FIRST, FIRST))).container;
    expectAnswerState(host, "Superseded");
    const banner = host.querySelector(".ub-decision-earlier-answer");
    expect(banner?.textContent).toContain("Earlier answer. Replaced 4 weeks ago; it no longer applies.");
    expect(banner?.querySelector("time")?.dateTime).toBe(new Date(DATE).toISOString());
    expect(within(host).getByRole("link", { name: "Go to the current answer" })).toBeDefined();
    await choose(host, CURRENT);
    expect(host.querySelector(".ub-decision-earlier-answer")?.textContent).toContain("Earlier answer. Replaced 5 days ago; it no longer applies.");
  });

  it.each([undefined, "not a date"])("omits an unavailable first replacement date (%s) without borrowing a later answer date", async (answerDate) => {
    record(FIRST, "Earlier answer", "decided", "The original answer.", { agent: true });
    record(CURRENT, "First replacement", "decided", "The first replacement.", {
      supersedes: FIRST, answerer: "Ben", ...(answerDate === undefined ? {} : { answerDate }), order: 1,
    });
    record(NEXT, "Latest replacement", "decided", "The latest replacement.", {
      supersedes: CURRENT, answerer: "Alex", answerDate: DATE, order: 2,
    });
    const host = (await open(decisionRecordPath(WORKSPACE, FIRST, FIRST))).container;
    const banner = host.querySelector(".ub-decision-earlier-answer");
    expect(banner?.textContent).toContain("Earlier answer. It no longer applies.");
    expect(banner?.textContent).not.toContain("Replaced");
    expect(banner?.querySelector("time")).toBeNull();
  });

  it("distinguishes an initial agent stance from a stored human answer", async () => {
    regular(RFC, "Stance discussion");
    const ydoc = record(FIRST, "Initial stance", "decided", "An agent's initial answer.", { agent: true, discussion: RFC });
    const host = (await open()).container;
    expectAnswerState(host, "Agent stance");
    expect(item(host, FIRST).querySelector(".ub-decision-answer-state")?.textContent).toBe("Agent stance");
    expect(item(host, FIRST).querySelector(".ub-decision-event")).toBeNull();
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Stance discussion");
    expect(answerHeader(host).textContent?.match(/Agent stance/g)).toHaveLength(1);
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("4 weeks ago");
    await act(async () => {
      const meta = getMetaMap(ydoc);
      meta.set("agentStance", false);
      meta.set("decidedBy", "Ben");
      meta.set("decidedAt", DATE);
    });
    expectAnswerState(host, "In force");
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Stance discussion");
    expect(answerHeader(host).querySelector(".ub-decision-attribution")?.textContent).toBe("Ben · 4 weeks ago");
  });

  it("never calls any conflicting answer current and lets each answer be selected", async () => {
    regular(RFC, "Conflicting discussion");
    record(FIRST, "Initial stance", "decided", "Initial stance answer.", { agent: true });
    record(CURRENT, "First conflicting answer", "decided", "One conflicting answer.", { supersedes: FIRST, answerer: "Ben", answerDate: DATE, discussion: RFC, order: 1 });
    record(NEXT, "Second conflicting answer", "decided", "Another conflicting answer.", { supersedes: FIRST, answerer: "Alex", answerDate: DATE, order: 2 });
    const host = (await open()).container;
    expect(selection(host)).toBe(NEXT);
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("Nothing is in force");
    expectAnswerState(host, "Conflicting answer");
    expect(item(host, CURRENT).textContent).toContain("Conflicting answer");
    expect(item(host, NEXT).textContent).toContain("Conflicting answer");
    expect(item(host, CURRENT).querySelector(".ub-decision-event")?.textContent).toBe("Ben decided");
    expect(item(host, NEXT).querySelector(".ub-decision-event")?.textContent).toBe("Alex decided");
    expect([...timeline(host).querySelectorAll("li")].every((row) => row.getAttribute("data-rail-green") === "false")).toBe(true);
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
    await choose(host, CURRENT);
    expect(answer(host).textContent).toContain("One conflicting answer.");
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Conflicting discussion");
    expectAnswerState(host, "Conflicting answer");
    await act(async () => record(OPEN, "Proposal during conflict", "open", "A new proposal.", { supersedes: CURRENT, discussion: RFC, order: 3 }));
    await choose(host, OPEN);
    expectAnswerState(host, "Open proposal");
    expect(item(host, OPEN).querySelector(".ub-decision-answer-state")?.textContent).toBe("Open proposal");
    expect(item(host, OPEN).querySelector(".ub-decision-event")).toBeNull();
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("Nothing is in force.");
    expect(answer(host).classList.contains("ub-decision-answer-history")).toBe(true);
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
  });

  it("keeps every archived record readable while closing comment writes", async () => {
    story();
    tombstoneDirectoryEntry(directory(), FIRST);
    const host = (await open()).container;
    expect(host.textContent).toContain("Archived. Read-only and hidden from the document list.");
    expect(timeline(host).querySelectorAll("li")).toHaveLength(5);
    expect(host.querySelector(".ub-thread-actions")).toBeNull();
    await choose(host, FIRST);
    expect(answer(host).textContent).toContain("Keep the original answer.");
    expect(host.textContent).toContain("Earlier record comment");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector(".ub-thread-actions")).toBeNull();
    await choose(host, OPEN);
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Proposal discussion");
  });

  it("shows only the selected record's RFC directly between its answer and History", async () => {
    story();
    const host = (await open()).container;
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    await choose(host, FIRST);
    const line = host.querySelector(".ub-decision-rfc")!;
    expect(line.textContent).toBe("RFC Earlier discussion");
    expect(line.previousElementSibling).toBe(answer(host));
    expect(line.nextElementSibling).toBe(timeline(host));
    expect(within(line as HTMLElement).getByRole("link", { name: "Earlier discussion" }).getAttribute("href"))
      .toBe(docPath(WORKSPACE, EARLIER_RFC));
    await choose(host, OPEN);
    expect(host.querySelectorAll(".ub-decision-rfc")).toHaveLength(1);
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Proposal discussion");
    await choose(host, REJECTED);
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    await choose(host, WITHDRAWN);
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, RFC));
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, EARLIER_RFC));
  });

  it.each(["rejected", "withdrawn"] as const)("keeps an RFC on a %s record", async (status) => {
    regular(RFC, "Closed discussion");
    record(FIRST, "Closed topic", status, "A closed proposal.", { discussion: RFC, related: RELATED_FIRST });
    const host = (await open()).container;
    expect(answer(host).textContent).toContain("A closed proposal.");
    expect(host.querySelector(".ub-decision-rfc")?.textContent).toBe("RFC Closed discussion");
  });

  it.each([null, ""])("uses the UUID for an unknown or empty RFC title (%s), then follows directory changes", async (title) => {
    if (title !== null) regular(RFC, title);
    record(FIRST, "RFC title example", "decided", "An answer.", { discussion: RFC });
    const host = (await open()).container;
    const link = () => host.querySelector(".ub-decision-rfc .ub-doclink");
    expect(link()?.textContent).toBe(RFC);
    expect(link()?.getAttribute("data-doc-link-state")).toBe(title === null ? "unresolved" : "resolved");
    await act(async () => regular(RFC, "Current RFC title"));
    expect(link()?.textContent).toBe("Current RFC title");
    await act(async () => tombstoneDirectoryEntry(directory(), RFC));
    expect(link()?.textContent).toBe("Current RFC titlearchived");
    expect(link()?.querySelector(".ub-badge.ub-decision-archived")?.textContent).toBe("archived");
    expect(link()?.getAttribute("data-doc-link-state")).toBe("archived");
    expect(within(item(host, FIRST)).getByRole("link", { name: /^Current RFC title/ }).getAttribute("data-doc-link-state"))
      .toBe("archived");
    await act(async () => regular(RFC, "Renamed archived RFC"));
    expect(link()?.textContent).toBe("Renamed archived RFCarchived");
    expect(link()?.getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
  });

  it("omits the whole RFC line without document navigation context", async () => {
    record(FIRST, "No context", "decided", "An answer.", { discussion: RFC });
    const host = (await renderSettled(<DecisionTopicPane
      topic={resolveDecisionTopics(directory())[0]!} selected={FIRST} linkedRecord={null}
      explicit={false} navigate={() => {}} directoryConnection={room(directoryRoom(WORKSPACE))}
      connection={room(roomForDoc(WORKSPACE, FIRST))} segment={WORKSPACE} presence={[]}
      author="Reader" archived={false} docLinks={null} onRestore={null} onSelectThread={() => {}}
    />)).container;
    expect(answer(host).textContent).toContain("An answer.");
    expect(host.querySelector(".ub-decision-rfc")).toBeNull();
  });
});

describe("decision hydration never exposes editable content", () => {
  it("waits for topic context when the directory cannot yet repair a known decision room", async () => {
    const ydoc = record(FIRST, "Room without topic context", "open", "An open proposal.", { publish: false });
    Object.defineProperty(room(directoryRoom(WORKSPACE)), "status", { value: { ...LIVE, synced: false } });
    const host = (await open()).container;
    expect(host.textContent).toContain("Waiting for the decision topic to sync.");
    expect(host.querySelector(".ProseMirror")).toBeNull();
    await act(async () => publishRecord(ydoc));
    expect(answer(host).textContent).toContain("An open proposal.");
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
  });

  it("binds read-only on every frame when the open decision room arrives first", async () => {
    const ydoc = record(FIRST, "Room before directory", "open", "An open decision answer.", { publish: false });
    const bindings: boolean[] = [];
    const original = guardedBinding.bindGuardedEditor;
    vi.spyOn(guardedBinding, "bindGuardedEditor").mockImplementation((options) => {
      bindings.push(options.editable ?? true);
      return original(options);
    });
    const host = (await open()).container;
    expect(bindings.every((editable) => !editable)).toBe(true);
    await act(async () => publishRecord(ydoc));
    expect(bindings).not.toHaveLength(0);
    expect(bindings.every((editable) => !editable)).toBe(true);
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLTextAreaElement>(".ub-title")?.readOnly).toBe(false);
    expectAnswerState(host, "Not yet decided");
  });

  it("waits for exact room hydration when the directory arrives first", async () => {
    upsertDirectoryEntry(directory(), { uuid: FIRST, title: "Directory before room", kind: "decision", status: "open", topic: FIRST, createdAt: CREATED });
    const bindings: boolean[] = [];
    const original = guardedBinding.bindGuardedEditor;
    vi.spyOn(guardedBinding, "bindGuardedEditor").mockImplementation((options) => {
      bindings.push(options.editable ?? true);
      return original(options);
    });
    const host = (await open()).container;
    expect(host.querySelector(".ProseMirror")).toBeNull();
    expect(host.querySelector(".ub-title")).toBeNull();
    expect(bindings).toHaveLength(0);
    await act(async () => record(FIRST, "Directory before room", "open", "Arrived open answer."));
    expect(bindings).not.toHaveLength(0);
    expect(bindings.every((editable) => !editable)).toBe(true);
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLTextAreaElement>(".ub-title")?.readOnly).toBe(false);
    expect(answer(host).textContent).toContain("Arrived open answer.");
  });
});

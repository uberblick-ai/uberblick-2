/** Topic navigation reads one record room while directory caches supply history. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  createGroup,
  decisionDirectoryFields,
  directoryRoom,
  getBlocks,
  getMetaMap,
  initDoc,
  pinDoc,
  readSidebar,
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
    createdAt: CREATED + (options.order ?? 0) * 1000,
  });
}

function regular(uuid: string, title: string): void {
  upsertDirectoryEntry(directory(), { uuid, title, createdAt: CREATED });
}

function story(): void {
  regular(RELATED_FIRST, "Original related page");
  regular(RELATED_CURRENT, "Current related page");
  regular(RFC, "Proposal discussion");
  const first = record(FIRST, "Original title", "decided", "Keep the original answer.", { related: RELATED_FIRST, agent: true });
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
  const area = host.querySelector<HTMLElement>(".ub-decision-answer");
  if (area === null) throw new Error("No selected answer");
  return area;
}

function selection(host: HTMLElement): string | null {
  return timeline(host).querySelector("[aria-current=true]")?.closest("li")?.getAttribute("data-record") ?? null;
}

async function choose(host: HTMLElement, uuid: string): Promise<void> {
  await act(async () => within(item(host, uuid)).getByRole("link", { name: /Selected|proposal|answer|Superseded|Rejected|Withdrawn|In force|stance/i }).click());
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
    expect(within(host).getByRole("button", { name: "Contents 2" })).toBeDefined();
    await act(async () => tombstoneDirectoryEntry(directory(), FIRST));
    expect(within(host).queryByRole("region", { name: "Decisions" })).toBeNull();
    expect(host.querySelector(".ub-decisions-link")).toBeNull();
    expect(within(host).getByRole("button", { name: "Contents 1" })).toBeDefined();
    expect(pageUpdates).not.toHaveBeenCalled();
    expect(acquired.filter((name) => [FIRST, CURRENT, REJECTED, WITHDRAWN, OPEN].some((uuid) => name === roomForDoc(WORKSPACE, uuid)))).toEqual([]);
    ydoc.off("update", pageUpdates);
  });

  it("adds the block and heading-free outline when a related topic arrives, then opens its current answer", async () => {
    const ydoc = room(roomForDoc(WORKSPACE, RELATED_FIRST)).ydoc;
    initDoc(ydoc, { uuid: RELATED_FIRST, title: "A page without headings" });
    appendBlock(ydoc, { type: "paragraph", text: "Read this first." });
    regular(RELATED_FIRST, "A page without headings");
    const host = (await open(docPath(WORKSPACE, RELATED_FIRST))).container;
    expect(within(host).queryByRole("button", { name: /^Contents/ })).toBeNull();
    await act(async () => {
      record(FIRST, "A new question", "decided", "A current answer with no cached preview.", { related: RELATED_FIRST, cache: false });
      upsertDirectoryEntry(directory(), { uuid: FIRST, title: "A new question", governs: RELATED_FIRST });
    });
    expect(within(host).getByRole("button", { name: "Contents 1" })).toBeDefined();
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
    expect(within(host).getByRole("heading", { level: 1 }).textContent).toBe("Current topic title");
    expect(host.querySelector(".ub-decision-related")?.textContent).toContain("Current related page");
    expect(answer(host).textContent).toContain("Use the current answer.");
    expect(host.querySelector(".ub-decision-attribution")?.textContent).toContain(`Ben · ${DATE}`);
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Under review");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("stays in force");
    expect(selection(host)).toBe(CURRENT);
    expect(item(host, FIRST).textContent).toContain("Linked record");
    expect(item(host, FIRST).textContent).toContain("Superseded");
    expect(item(host, FIRST).textContent).toContain("1 comment");
    expect(item(host, REJECTED).textContent).toContain("Rejected");
    expect(item(host, REJECTED).querySelector("time")?.dateTime).toBe("2026-10-10T12:00:00.000Z");
    expect(item(host, WITHDRAWN).textContent).toContain("Withdrawn");
    expect(item(host, OPEN).textContent).toContain("Open proposal");
    expect(item(host, OPEN).querySelector("time")?.dateTime).toBe(new Date(CREATED + 4000).toISOString());
    expect(within(item(host, OPEN)).getByRole("link", { name: "Open RFC" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(host.querySelector(".ub-threads-pane")?.textContent ?? host.textContent).toContain("Current record comment");
    expect(host.textContent).not.toContain("Earlier record comment");
    expect(timeline(host).querySelectorAll("li")).toHaveLength(5);
    expect(acquired.filter((name) => [FIRST, CURRENT, REJECTED, WITHDRAWN, OPEN].some((uuid) => name === roomForDoc(WORKSPACE, uuid)))).toEqual([roomForDoc(WORKSPACE, CURRENT)]);
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
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("History · Rejected");
    expect(host.querySelector(".ub-decision-rejection")?.textContent).toContain("It loses compatibility.");
    expect(host.querySelector(".ub-decision-attribution")?.textContent).toContain("Rejected by Alex");
    expect(within(host).getByRole("heading", { level: 1 }).textContent).toBe("Current topic title");
    await copy(host);
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}${rejectedPath}`);
    await choose(host, FIRST);
    expect(window.location.pathname).toBe(decisionRecordPath(WORKSPACE, FIRST, FIRST));
    expect(host.textContent).toContain("Earlier record comment");
    expect(host.textContent).not.toContain("Current record comment");
    expect(host.querySelector(".ub-decision-attribution")).toBeNull();
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
    expect(within(host).getByRole("heading", { level: 1 }).textContent).toBe("New current title");
    expect(host.querySelector(".ub-decision-related")?.textContent).toContain("Original related page");
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
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Not yet decided");
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("History · Withdrawn");
    expect(host.querySelector(".ub-decision-related")).toBeNull();
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
    expect(within(host).queryByRole("link", { name: "Open proposal" })).toBeNull();
    expect(item(host, OPEN).textContent).not.toContain("Unknown preview from this room");
    expect(item(host, OPEN).querySelector(".ub-decision-preview")).toBeNull();
    expect(within(item(host, OPEN)).queryByRole("link", { name: "Open RFC" })).toBeNull();
    expect(acquired).not.toContain(roomForDoc(WORKSPACE, OPEN));
  });

  it("labels an unanswered record as an open proposal and links its discussion", async () => {
    regular(RFC, "Unanswered RFC");
    record(FIRST, "Still under discussion", "open", "The initial proposal.", { discussion: RFC });
    const host = (await open()).container;
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Not yet decided");
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("History · Open proposal");
    expect(answer(host).textContent).toContain("The initial proposal.");
    expect(within(host).getByRole("link", { name: "Open proposal" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(host.querySelector(".ub-decision-attribution")).toBeNull();
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
  });

  it("counts several pending proposals while each keeps its own RFC link", async () => {
    story();
    record(NEXT, "Another pending proposal", "open", "A parallel proposal.", { supersedes: CURRENT, order: 5 });
    const host = (await open()).container;
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Under review");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("2 pending proposals");
    expect(within(host).queryByRole("link", { name: "Open proposal" })).toBeNull();
    expect(within(item(host, OPEN)).getByRole("link", { name: "Open RFC" }).getAttribute("href")).toBe(docPath(WORKSPACE, RFC));
    expect(within(item(host, NEXT)).queryByRole("link", { name: "Open RFC" })).toBeNull();
    expect(answer(host).textContent).toContain("Use the current answer.");
  });

  it("distinguishes an initial agent stance from a stored human answer", async () => {
    const ydoc = record(FIRST, "Initial stance", "decided", "An agent's initial answer.", { agent: true });
    const host = (await open()).container;
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Agent stance");
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toBe("Agent stance");
    expect(host.querySelector(".ub-decision-attribution")).toBeNull();
    await act(async () => {
      const meta = getMetaMap(ydoc);
      meta.set("agentStance", false);
      meta.set("decidedBy", "Ben");
      meta.set("decidedAt", DATE);
    });
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("In force");
    expect(host.querySelector(".ub-decision-attribution")?.textContent).toContain(`Ben · ${DATE}`);
  });

  it("never calls any conflicting answer current and lets each answer be selected", async () => {
    record(FIRST, "Initial stance", "decided", "Initial stance answer.", { agent: true });
    record(CURRENT, "First conflicting answer", "decided", "One conflicting answer.", { supersedes: FIRST, answerer: "Ben", answerDate: DATE, order: 1 });
    record(NEXT, "Second conflicting answer", "decided", "Another conflicting answer.", { supersedes: FIRST, answerer: "Alex", answerDate: DATE, order: 2 });
    const host = (await open()).container;
    expect(selection(host)).toBe(NEXT);
    expect(host.querySelector(".ub-decision-topic-state")?.textContent).toBe("Conflict");
    expect(host.querySelector(".ub-decision-notice")?.textContent).toContain("Nothing is in force");
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("History · Conflicting answer");
    expect(item(host, CURRENT).textContent).toContain("Conflicting answer");
    expect(item(host, NEXT).textContent).toContain("Conflicting answer");
    expect(within(host).queryByRole("link", { name: "Go to the current answer" })).toBeNull();
    await choose(host, CURRENT);
    expect(answer(host).textContent).toContain("One conflicting answer.");
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("Conflicting answer");
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
    expect(host.querySelector("input.ub-title")).toBeNull();
    expect(host.querySelector(".ub-decision-answer-label")?.textContent).toContain("Open proposal");
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
    expect(bindings).toHaveLength(0);
    await act(async () => record(FIRST, "Directory before room", "open", "Arrived open answer."));
    expect(bindings).not.toHaveLength(0);
    expect(bindings.every((editable) => !editable)).toBe(true);
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector("input.ub-title")).toBeNull();
    expect(answer(host).textContent).toContain("Arrived open answer.");
  });
});

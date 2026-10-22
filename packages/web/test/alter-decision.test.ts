import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  createTagCatalogEntry,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionDirectoryFields,
  decisionTopicState,
  directoryRoom,
  getBlocks,
  getBlocksFragment,
  getBlocksWithInline,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  listDirectory,
  listTagCatalog,
  parseRoom,
  resolveDecisionTopics,
  roomForDoc,
  setKind,
  setStatus,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const CURRENT = "9ebf44bd-97f8-479d-8e7c-5fbc96173504";
const NEXT = "e795b3c7-cd85-4e6f-8950-a4f479b077ba";
const RELATED = "34865e42-d48f-497a-8e1b-132c504a3e45";
const DISCUSSION = "63c11ea4-0e60-40ee-a46d-6feef7e55b61";
const TAG = "00000000-0000-4000-8000-000000000001";
const RFC_TAG = "00000000-0000-4000-8000-000000000006";
const NOW = "2026-10-20T12:00:00.000Z";
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
const localDocs: Y.Doc[] = [];

function room(name: string, writable = false): HeldRoom {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const listeners = new Set<(status: RoomStatus) => void>();
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: { ...LIVE, connected: writable, synced: writable, writable },
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

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
  acquireRoom: (name: string) => {
    const held = room(name);
    acquired.push(held);
    return { connection: held.connection, release: () => { held.releases++; } };
  },
}));

const { createDecisionDraft, recordAlteredDecision } = await import("../src/collab/alter-decision.js");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const held of rooms.values()) held.connection.ydoc.destroy();
  for (const doc of localDocs) doc.destroy();
  rooms.clear();
  acquired.length = 0;
  localDocs.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function localDoc(): Y.Doc {
  const doc = new Y.Doc();
  localDocs.push(doc);
  return doc;
}

function draftOf(source: Y.Doc): Y.Doc {
  const draft = createDecisionDraft(source);
  localDocs.push(draft);
  return draft;
}

function fixture(blocks: BlockInput[] = [{ type: "paragraph", text: "The current answer." }]) {
  const source = room(roomForDoc(WORKSPACE, CURRENT), true);
  const directory = room(directoryRoom(WORKSPACE), true);
  initDoc(source.connection.ydoc, {
    uuid: CURRENT, title: "Current question", description: "A useful description.",
    tags: [TAG], governs: RELATED,
  });
  setKind(source.connection.ydoc, "decision");
  for (const block of blocks) appendBlock(source.connection.ydoc, block);
  const meta = getMetaMap(source.connection.ydoc);
  meta.set("discussion", DISCUSSION);
  meta.set("approvalTitle", "Question before its rename");
  meta.set("decidedBy", "Earlier reader");
  meta.set("decidedAt", "2026-10-19T12:00:00Z");
  meta.set("decidedWhere", "Earlier discussion");
  meta.set("agentStance", true);
  meta.set("approvalFingerprint", decisionApprovalFingerprint(source.connection.ydoc));
  setStatus(source.connection.ydoc, "decided");
  publish(directory.connection.ydoc, source.connection.ydoc);
  const tagCatalog = localDoc();
  const draft = draftOf(source.connection.ydoc);
  const controller = new AbortController();
  const input = {
    source: source.connection, directory: directory.connection, draft,
    identity: { name: "Default identity", color: "#e30c4e" },
    mode: "decide" as "decide" | "rfc", reason: "  A clearer answer is needed.  ",
    displayName: "  Current reader  ", tagCatalog, signal: controller.signal,
  };
  return { source, directory, tagCatalog, draft, controller, input };
}

function publish(directory: Y.Doc, doc: Y.Doc): void {
  const meta = getMeta(doc);
  upsertDirectoryEntry(directory, {
    uuid: meta.uuid, title: meta.title, tags: meta.tags,
    ...(meta.description === null ? {} : { description: meta.description }),
    ...(meta.kind === undefined ? {} : { kind: meta.kind }),
    ...(meta.status === undefined ? {} : { status: meta.status }),
    ...decisionDirectoryFields(doc), createdAt: Date.now(), updatedAt: Date.now(),
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function admitAll(): Promise<void> {
  for (const held of destinations()) update(held, { connected: true, synced: true, writable: true });
  await flush();
}

function destinations(): HeldRoom[] {
  return acquired.filter((held) => held.connection.room !== directoryRoom(WORKSPACE));
}

function stored(uuid: string): Y.Doc {
  const held = rooms.get(roomForDoc(WORKSPACE, uuid));
  if (held === undefined) throw new Error(`Room ${uuid} was not acquired`);
  return held.connection.ydoc;
}

function expectNothingWritten(directory: Y.Doc): void {
  for (const held of destinations()) {
    expect(getMeta(held.connection.ydoc).uuid).toBe("");
    expect(getBlocks(held.connection.ydoc)).toEqual([]);
    expect(getDirectoryEntry(directory, parseRoom(held.connection.room).uuid)).toBeNull();
  }
}

describe("copying the current decision answer", () => {
  it.each(["decide", "rfc"] as const)("leaves predecessor comments behind when copying an answer for %s", async (mode) => {
    const { source, input } = fixture([
      { type: "paragraph", inline: [
        { text: "Keep ", marks: {} },
        { text: "formatted", marks: { bold: true, docLink: RELATED } },
      ] },
      { type: "table", text: "| Header |\n| --- |\n| **formatted** [cell](https://example.com) |" },
    ]);
    const original = source.connection.ydoc;
    const [prose, table] = getBlocks(original);
    createAnnotation(original, prose!.id, 5, 14, "Earlier reader", "Prose discussion");
    createAnnotation(original, table!.id, 0, 14, "Earlier reader", "Cell discussion", { row: 1, column: 0 });
    const before = getBlocksWithInline(original);
    const threads = listAnnotations(original);
    const ranges = getBlocks(original).map((block) => listAnnotationRanges(original, block.id));

    const draft = draftOf(original);
    expect(getBlocksWithInline(draft)).toEqual(before);
    expect(listAnnotations(draft)).toEqual([]);
    for (const block of getBlocks(draft)) expect(listAnnotationRanges(draft, block.id)).toEqual([]);

    const pending = recordAlteredDecision({ ...input, draft, mode });
    await admitAll();
    const result = await pending;
    if (!result.ok) throw new Error(result.message);
    const answer = stored(result.decision);
    expect(getBlocksWithInline(answer).slice(0, before.length)).toEqual(before);
    expect(listAnnotations(answer)).toEqual([]);
    for (const block of getBlocks(answer)) expect(listAnnotationRanges(answer, block.id)).toEqual([]);
    expect(() => createAnnotation(answer, prose!.id, 5, 14, "Current reader", "New prose discussion")).not.toThrow();
    expect(() => createAnnotation(answer, table!.id, 0, 14, "Current reader", "New cell discussion", { row: 1, column: 0 })).not.toThrow();
    expect(getBlocksWithInline(original)).toEqual(before);
    expect(listAnnotations(original)).toEqual(threads);
    expect(getBlocks(original).map((block) => listAnnotationRanges(original, block.id))).toEqual(ranges);
    result.release();
  });

  it("copies the visible answer without reviving shadowed same-id blocks", async () => {
    const { source, input } = fixture();
    const original = getBlocksWithInline(source.connection.ydoc);
    const shadowed = new Y.XmlElement("heading");
    shadowed.setAttribute("id", original[0]!.block.id);
    getBlocksFragment(source.connection.ydoc).insert(1, [shadowed]);
    const draft = draftOf(source.connection.ydoc);
    expect(getBlocksWithInline(draft)).toEqual(original);
    expect(getBlocksFragment(draft).length).toBe(1);
    const pending = recordAlteredDecision({ ...input, draft });
    await admitAll();
    const result = await pending;
    if (!result.ok) throw new Error(result.message);
    expect(getBlocksWithInline(stored(result.decision)).slice(0, -1)).toEqual(original);
    result.release();
  });

  it.each([
    { blocks: [
      { type: "paragraph", inline: [{ text: "Keep ", marks: {} }, { text: "formatted", marks: { bold: true, italic: true } }, { text: " links", marks: { docLink: RELATED } }] },
      { type: "table", text: `| **bold** *italic* ~~strike~~ \`code\` [site](https://example.com) [page](${RELATED}) |\n| --- |\n| preserved cell |` },
    ] },
    { blocks: [
      { type: "list-item", text: "First", list: "ordered", indent: 0 },
      { type: "list-item", inline: [{ text: "Nested", marks: { link: "https://example.com", bold: true } }], list: "bullet", indent: 2 },
      { type: "list-item", text: "Next", list: "ordered", indent: 1 },
      { type: "code", text: "const answer = 42;", language: "typescript" },
    ] },
  ] satisfies Array<{ blocks: BlockInput[] }>)("preserves answer formatting through the draft and a decided successor (%#)", async ({ blocks }) => {
    const { source, draft, input } = fixture(blocks);
    const before = getBlocksWithInline(source.connection.ydoc);
    expect(getBlocksWithInline(draft)).toEqual(before);
    expect(getMeta(draft).uuid).toBe("");
    const pending = recordAlteredDecision(input);
    await admitAll();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(getBlocksWithInline(stored(result.decision)).slice(0, -1)).toEqual(before);
    expect(getBlocksWithInline(source.connection.ydoc)).toEqual(before);
    result.release();
  });

  it("copies every answer block and refuses the longer copy until it is shortened", async () => {
    const { source, directory, draft, input } = fixture([
      { type: "paragraph", text: "One" }, { type: "paragraph", text: "Two" },
      { type: "paragraph", text: "Three" },
    ]);
    expect(getBlocksWithInline(draft)).toEqual(getBlocksWithInline(source.connection.ydoc));
    expect(await recordAlteredDecision(input)).toMatchObject({ ok: false, code: "decision_answer_too_long" });
    expect(acquired).toHaveLength(0);
    expect(listDirectory(directory.connection.ydoc)).toHaveLength(1);
    getBlocksFragment(draft).delete(2, 1);
    const pending = recordAlteredDecision(input);
    await admitAll();
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    if (result.ok) result.release();
  });
});

describe("MCP-compatible stored successors", () => {
  it("uses the source room identity when stored metadata names another record", async () => {
    const { source, input } = fixture();
    getMetaMap(source.connection.ydoc).set("uuid", NEXT);
    const pending = recordAlteredDecision(input);
    await admitAll();
    const result = await pending;
    if (!result.ok) throw new Error(result.message);
    expect(getMeta(stored(result.decision))).toMatchObject({ topic: CURRENT, supersedes: CURRENT });
    expect(getMetaMap(source.connection.ydoc).get("uuid")).toBe(NEXT);
    result.release();
  });

  it("records a Decide answer with its final reason, approval and attribution", async () => {
    const { source, directory, input } = fixture();
    const original = getMeta(source.connection.ydoc);
    const pending = recordAlteredDecision(input);
    await admitAll();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const doc = stored(result.decision);
    expect(getMeta(doc)).toMatchObject({
      uuid: result.decision, title: original.title, description: original.description,
      tags: original.tags, kind: "decision", status: "decided", topic: CURRENT,
      supersedes: CURRENT, governs: RELATED, discussion: null,
      decidedBy: "Current reader", decidedAt: NOW,
      decidedWhere: "Uberblick web: Alter decision", agentStance: false,
      approvalFingerprint: decisionApprovalFingerprint(doc),
    });
    expect(getMetaMap(doc).has("approvalTitle")).toBe(false);
    expect(decisionApprovalChanged(doc)).toBe(false);
    expect(getBlocksWithInline(doc).at(-1)).toMatchObject({
      block: { type: "paragraph", text: "A clearer answer is needed." },
      inline: [{ text: "A clearer answer is needed.", marks: {} }],
    });
    expect(getDirectoryEntry(directory.connection.ydoc, result.decision)).toMatchObject({
      uuid: result.decision, title: original.title, description: original.description,
      tags: original.tags, kind: "decision", status: "decided", topic: CURRENT,
      supersedes: CURRENT, governs: RELATED, answerPreview: "The current answer.",
      decidedBy: "Current reader", decidedAt: NOW, agentStance: false, approvalChanged: false,
    });
    const topic = resolveDecisionTopics(directory.connection.ydoc)[0]!;
    expect(topic.inForce?.uuid).toBe(result.decision);
    expect(topic.superseded.map((record) => record.uuid)).toEqual([CURRENT]);
    expect(getMeta(source.connection.ydoc)).toEqual(original);
    result.release();
  });

  it.each(["decide", "rfc"] as const)("uses the first record's title for %s after the current record kept an older title", async (mode) => {
    const { source, directory, input } = fixture();
    const first = localDoc();
    initDoc(first, { uuid: NEXT, title: "Renamed topic" });
    setKind(first, "decision");
    appendBlock(first, { type: "paragraph", text: "Earlier answer." });
    setStatus(first, "decided");
    publish(directory.connection.ydoc, first);
    getMetaMap(source.connection.ydoc).set("topic", NEXT);
    getMetaMap(source.connection.ydoc).set("supersedes", NEXT);
    publish(directory.connection.ydoc, source.connection.ydoc);
    const pending = recordAlteredDecision({ ...input, mode });
    await admitAll();
    const result = await pending;
    if (!result.ok) throw new Error(result.message);
    expect(getMeta(stored(result.decision)).title).toBe("Renamed topic");
    if (result.rfc !== undefined) expect(getMeta(stored(result.rfc)).title).toBe("Renamed topic");
    expect(getMeta(source.connection.ydoc).title).toBe("Current question");
    result.release();
  });

  it.each([true, false])("opens an RFC and proposal with the catalog rfc tag present=%s", async (hasTag) => {
    const { directory, tagCatalog, input } = fixture();
    if (hasTag) createTagCatalogEntry(tagCatalog, "rfc", RFC_TAG);
    createTagCatalogEntry(tagCatalog, "other", TAG);
    const beforeCatalog = listTagCatalog(tagCatalog);
    const pending = recordAlteredDecision({ ...input, mode: "rfc", displayName: "" });
    await admitAll();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok || result.rfc === undefined) throw new Error("RFC write did not succeed");
    const proposal = stored(result.decision);
    const rfc = stored(result.rfc);
    expect(getMeta(proposal)).toMatchObject({
      title: "Current question", description: "A useful description.", tags: [TAG],
      kind: "decision", status: "open", topic: CURRENT, supersedes: CURRENT,
      governs: RELATED, discussion: result.rfc,
    });
    const meta = getMetaMap(proposal);
    for (const key of ["decidedBy", "decidedAt", "decidedWhere", "agentStance", "approvalFingerprint", "approvalTitle"]) {
      expect(meta.has(key)).toBe(false);
    }
    expect(getBlocks(proposal).map((block) => block.text)).toEqual(["The current answer."]);
    expect(getMeta(rfc)).toMatchObject({ title: "Current question", tags: hasTag ? [RFC_TAG] : [] });
    expect(getMeta(rfc).kind).toBeUndefined();
    expect(getBlocksWithInline(rfc)).toMatchObject([
      { block: { type: "paragraph", text: "Proposed change to Current question." }, inline: [
        { text: "Proposed change to ", marks: {} },
        { text: "Current question", marks: { docLink: result.decision } },
        { text: ".", marks: {} },
      ] },
      { block: { type: "paragraph", text: "A clearer answer is needed." } },
    ]);
    expect(getDirectoryEntry(directory.connection.ydoc, result.rfc)).toMatchObject({
      title: "Current question", tags: hasTag ? [RFC_TAG] : [],
    });
    expect(getDirectoryEntry(directory.connection.ydoc, result.decision)).toMatchObject({
      status: "open", topic: CURRENT, supersedes: CURRENT, governs: RELATED,
      discussion: result.rfc, answerPreview: "The current answer.", approvalChanged: false,
    });
    const topic = resolveDecisionTopics(directory.connection.ydoc)[0]!;
    expect(topic.inForce?.uuid).toBe(CURRENT);
    expect(topic.pending.map((record) => record.uuid)).toEqual([result.decision]);
    expect(decisionTopicState(topic)).toBe("under-review");
    expect(listTagCatalog(tagCatalog)).toEqual(beforeCatalog);
    result.release();
  });

  it("leaves an omitted RFC reason out of its content", async () => {
    const { input } = fixture();
    const pending = recordAlteredDecision({ ...input, mode: "rfc", reason: " \n " });
    await admitAll();
    const result = await pending;
    if (!result.ok || result.rfc === undefined) throw new Error("RFC write did not succeed");
    expect(getBlocks(stored(result.rfc))).toHaveLength(1);
    result.release();
  });
});

describe("validation without writes", () => {
  it("refuses an unknown native block instead of copying its paragraph fallback", async () => {
    const { input, draft } = fixture();
    const block = new Y.XmlElement("unknown-block");
    const text = new Y.XmlText();
    text.insert(0, "Unsupported answer");
    block.insert(0, [text]);
    getBlocksFragment(draft).insert(1, [block]);
    expect(await recordAlteredDecision(input)).toMatchObject({ ok: false, code: "decision_block_unsupported" });
    expect(acquired).toHaveLength(0);
  });

  it.each([
    { blocks: [], code: "decision_answer_empty", fix: /answer/i },
    { blocks: [{ type: "paragraph", text: " \n " }], code: "decision_answer_empty", fix: /answer/i },
    { blocks: [{ type: "table", text: "|   |   |\n| --- | --- |\n|   |   |" }], code: "decision_answer_empty", fix: /answer/i },
    { blocks: [{ type: "heading", text: "Unsupported" }], code: "decision_block_unsupported", fix: /paragraph|list|code|table/i },
    { blocks: [{ type: "paragraph", text: "One" }, { type: "code", text: "Two" }, { type: "paragraph", text: "Three" }], code: "decision_answer_too_long", fix: /two|2/i },
  ] satisfies Array<{ blocks: BlockInput[]; code: string; fix: RegExp }>)("refuses $code in either write mode", async ({ blocks, code, fix }) => {
    const { input, directory } = fixture();
    const draft = localDoc();
    for (const block of blocks) appendBlock(draft, block);
    for (const mode of ["decide", "rfc"] as const) {
      expect(await recordAlteredDecision({ ...input, draft, mode })).toMatchObject({ ok: false, code, message: expect.stringMatching(fix) });
    }
    expect(acquired).toHaveLength(0);
    expect(listDirectory(directory.connection.ydoc)).toHaveLength(1);
  });

  it.each([
    { reason: " \n ", displayName: "Reader", code: "reason_empty", fix: /reason/i },
    { reason: "Reason", displayName: " \n ", code: "display_name_empty", fix: /name/i },
  ])("refuses $code before acquiring a destination", async ({ reason, displayName, code, fix }) => {
    const { input } = fixture();
    expect(await recordAlteredDecision({ ...input, reason, displayName })).toMatchObject({ ok: false, code, message: expect.stringMatching(fix) });
    expect(acquired).toHaveLength(0);
  });
});

describe("all-room admission and stale writes", () => {
  it("waits for initial destination synchronization even after authentication permits writing", async () => {
    const { directory, input } = fixture();
    const pending = recordAlteredDecision(input);
    const destination = destinations()[0]!;
    update(destination, { connected: true, writable: true, synced: false });
    await flush();
    expectNothingWritten(directory.connection.ydoc);
    update(destination, { synced: true });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) result.release();
  });

  it.each(["room", "directory"] as const)("refuses an identity already present in the destination %s", async (existing) => {
    const { directory, input } = fixture();
    const destination = room(roomForDoc(WORKSPACE, NEXT));
    if (existing === "room") initDoc(destination.connection.ydoc, { uuid: NEXT, title: "Existing document" });
    else upsertDirectoryEntry(directory.connection.ydoc, { uuid: NEXT, title: "Existing document" });
    const beforeDoc = Y.encodeStateAsUpdate(destination.connection.ydoc);
    const beforeDirectory = listDirectory(directory.connection.ydoc);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(NEXT);
    const pending = recordAlteredDecision(input);
    await admitAll();
    expect(await pending).toMatchObject({ ok: false, code: "destination_exists" });
    expect(Y.encodeStateAsUpdate(destination.connection.ydoc)).toEqual(beforeDoc);
    expect(listDirectory(directory.connection.ydoc)).toEqual(beforeDirectory);
  });

  it("writes no RFC or proposal until both destinations are writable, then publishes complete records in dependency order", async () => {
    const { controller, directory, input } = fixture();
    const events: Array<{ uuid: string; discussion?: string | null }> = [];
    directory.connection.ydoc.on("update", () => {
      for (const entry of listDirectory(directory.connection.ydoc)) {
        if (entry.uuid === CURRENT || events.some((event) => event.uuid === entry.uuid)) continue;
        const meta = getMeta(stored(entry.uuid));
        expect(meta.uuid).toBe(entry.uuid);
        expect(getBlocks(stored(entry.uuid)).length).toBeGreaterThan(0);
        if (meta.discussion != null) {
          expect(getMeta(stored(meta.discussion)).uuid).toBe(meta.discussion);
          expect(getDirectoryEntry(directory.connection.ydoc, meta.discussion)).not.toBeNull();
        }
        events.push({ uuid: entry.uuid, ...(meta.kind === "decision" ? { discussion: meta.discussion } : {}) });
      }
    });
    const pending = recordAlteredDecision({ ...input, mode: "rfc" });
    await flush();
    expect(destinations()).toHaveLength(2);
    update(destinations()[0]!, { connected: true, synced: true, writable: true });
    await flush();
    expectNothingWritten(directory.connection.ydoc);
    update(destinations()[1]!, { connected: true, synced: true, writable: true });
    const result = await pending;
    if (!result.ok || result.rfc === undefined) throw new Error("RFC write did not succeed");
    expect(events).toEqual([{ uuid: result.rfc }, { uuid: result.decision, discussion: result.rfc }]);
    controller.abort();
    expect(acquired.every((held) => held.releases === 0 && held.listeners.size === 0)).toBe(true);
    result.release();
    expect(acquired.every((held) => held.releases === 1 && held.listeners.size === 0)).toBe(true);
  });

  it("stores the submitted draft snapshot when the caller edits while waiting", async () => {
    const { draft, input } = fixture();
    const pending = recordAlteredDecision(input);
    appendBlock(draft, { type: "paragraph", text: "A later editor change" });
    input.reason = "";
    input.displayName = "";
    input.mode = "rfc";
    await admitAll();
    const result = await pending;
    if (!result.ok) throw new Error(result.message);
    expect(getBlocks(stored(result.decision)).map((block) => block.text)).toEqual([
      "The current answer.", "A clearer answer is needed.",
    ]);
    result.release();
  });

  it.each(["replaced", "archived", "conflict"] as const)("refuses a pending write when the topic becomes %s", async (state) => {
    const { directory, input } = fixture();
    const pending = recordAlteredDecision(input);
    if (state === "archived") tombstoneDirectoryEntry(directory.connection.ydoc, CURRENT);
    else {
      const successor = localDoc();
      initDoc(successor, { uuid: NEXT, title: "Another answer", ...(state === "replaced" ? { topic: CURRENT, supersedes: CURRENT } : {}) });
      setKind(successor, "decision");
      appendBlock(successor, { type: "paragraph", text: "Another answer" });
      setStatus(successor, "decided");
      if (state === "conflict") getMetaMap(successor).set("topic", CURRENT);
      publish(directory.connection.ydoc, successor);
    }
    await admitAll();
    expect(await pending).toMatchObject({ ok: false, code: "stale_decision", message: expect.stringMatching(/answer|topic/i) });
    expectNothingWritten(directory.connection.ydoc);
  });

  it.each(["source", "directory"] as const)("refuses a pending write when the %s loses write access", async (which) => {
    const { source, directory, input } = fixture();
    const pending = recordAlteredDecision(input);
    update(which === "source" ? source : directory, { writable: false });
    await admitAll();
    expect(await pending).toMatchObject({ ok: false, code: `${which}_unwritable`, message: expect.stringMatching(/writ/i) });
    expectNothingWritten(directory.connection.ydoc);
  });

  it.each([
    { storeRefused: true }, { protocolMismatch: { hub: 2, client: 1 } },
    { authFailed: true }, { tokenMissing: true }, { deleted: true },
  ] satisfies Partial<RoomStatus>[])("refuses every write when a destination is refused (%j)", async (refusal) => {
    const { directory, input } = fixture();
    const pending = recordAlteredDecision({ ...input, mode: "rfc" });
    await flush();
    update(destinations()[1]!, refusal);
    expect(await pending).toMatchObject({ ok: false, code: "destination_unwritable" });
    await admitAll();
    expectNothingWritten(directory.connection.ydoc);
    expect(acquired.every((held) => held.releases === 1 && held.listeners.size === 0)).toBe(true);
  });

  it("abandons a pending write permanently, including after late admission", async () => {
    const { controller, directory, input } = fixture();
    const pending = recordAlteredDecision({ ...input, mode: "rfc" });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "abandoned" });
    await admitAll();
    expectNothingWritten(directory.connection.ydoc);
    expect(acquired.every((held) => held.releases === 1 && held.listeners.size === 0)).toBe(true);
  });

  it("refuses an already abandoned request without acquiring rooms", async () => {
    const { controller, input } = fixture();
    controller.abort();
    expect(await recordAlteredDecision(input)).toMatchObject({ ok: false, code: "abandoned" });
    expect(acquired).toHaveLength(0);
  });
});

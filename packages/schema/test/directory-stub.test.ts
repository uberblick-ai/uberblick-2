import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  createAnnotation,
  deleteDirectoryEntry,
  editBlock,
  getDirectoryEntry,
  getDirectoryMap,
  initDoc,
  isDirectoryEntryDeleted,
  repairDirectoryStub,
  resolveAnnotationRange,
  setAnnotationResolved,
  setDescription,
  setKind,
  setTags,
  setTitle,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
  UPDATED_AT_COARSENESS_MS,
} from "../src/index.js";
import type { DirectoryEntry } from "../src/index.js";
import { syncDocs } from "./helpers.js";

const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);
const WINDOW = UPDATED_AT_COARSENESS_MS;
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";

interface Rig {
  doc: Y.Doc;
  directory: Y.Doc;
  peer: Y.Doc;
  crossed(): number;
}

/** Read assertions and count writes on a peer, after explicitly exchanging updates. */
function observe(doc: Y.Doc, directory: Y.Doc): Rig {
  const peer = new Y.Doc();
  syncDocs(directory, peer);
  let crossed = 0;
  peer.on("update", () => {
    crossed += 1;
  });
  return { doc, directory, peer, crossed: () => crossed };
}

function rig(title: string, cachedTitle = title): Rig {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title });
  const directory = new Y.Doc();
  upsertDirectoryEntry(directory, {
    uuid: UUID,
    title: cachedTitle,
    openThreadCount: 0,
    code_check: [],
    createdAt: T0,
    updatedAt: T0,
  });
  return observe(doc, directory);
}

function repair(
  client: Rig,
  now: number,
  changedAt: number | null,
  coarsenessMs = WINDOW,
): void {
  repairDirectoryStub(client.doc, client.directory, UUID, { now, changedAt, coarsenessMs });
  syncDocs(client.directory, client.peer);
}

function stub(client: Rig): DirectoryEntry {
  const entry = getDirectoryEntry(client.peer, UUID);
  if (entry === null) throw new Error(`no directory entry for ${UUID}`);
  return entry;
}

describe("directory stub repair", () => {
  it.each([false, true])("never repairs a permanently deleted document, including decisions: %s", (decision) => {
    const document = new Y.Doc();
    const directory = new Y.Doc();
    initDoc(document, { uuid: UUID, title: "Private" });
    if (decision) setKind(document, "decision");
    deleteDirectoryEntry(directory, UUID);
    const before = Y.encodeStateAsUpdate(directory);
    const client = observe(document, directory);

    repair(client, T0, null);
    setTitle(document, "Late rename");
    repair(client, T0 + 1_000, T0 + 1_000);
    setTags(document, ["late"]);
    repair(client, T0 + 2_000, T0 + 2_000);
    appendBlock(document, { type: "paragraph", text: "Late edit" });
    repair(client, T0 + 3_000, T0 + 3_000);
    expect(isDirectoryEntryDeleted(directory, UUID)).toBe(true);
    expect(getDirectoryMap(directory).has(UUID)).toBe(false);
    expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    expect(client.crossed()).toBe(0);
  });

  it.each([false, true])("preserves a decision's tombstone while repairing its stub, with createdAt present: %s", (hasCreatedAt) => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Lease duration" });
    setKind(doc, "decision");
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID, title: "Stale", kind: "decision",
      ...(hasCreatedAt ? { createdAt: T0 } : {}),
      updatedAt: T0,
    });
    tombstoneDirectoryEntry(directory, UUID);
    const client = observe(doc, directory);
    repair(client, T0 + 1_000, null);
    expect(stub(client)).toMatchObject({
      title: "Lease duration", deleted: true,
      createdAt: hasCreatedAt ? T0 : T0 + 1_000,
      updatedAt: T0,
    });
    setTitle(doc, "Short lease");
    repair(client, T0 + 2_000, T0 + 2_000);
    expect(stub(client)).toMatchObject({
      title: "Short lease", deleted: true,
      createdAt: hasCreatedAt ? T0 : T0 + 1_000,
      updatedAt: T0 + 2_000,
    });
  });

  it("counts open threads independently of replies and anchors, and stamps count changes immediately", () => {
    const client = rig("Comments");
    const block = appendBlock(client.doc, { type: "paragraph", text: "prose" });
    repair(client, T0, T0);
    expect(stub(client).openThreadCount).toBe(0);

    const thread = createAnnotation(client.doc, block, 0, 5, "Author", "A comment");
    repair(client, T0 + 1_000, T0 + 1_000);
    expect(stub(client)).toMatchObject({ openThreadCount: 1, updatedAt: T0 + 1_000 });
    expect(client.crossed()).toBe(1);

    addComment(client.doc, thread.id, "Reviewer", "A reply");
    repair(client, T0 + 2_000, T0 + 2_000);
    editBlock(client.doc, block, "prose", "");
    repair(client, T0 + 2_000, T0 + 2_000);
    expect(resolveAnnotationRange(client.doc, thread.id)).toBeNull();
    expect(stub(client)).toMatchObject({ openThreadCount: 1, updatedAt: T0 + 1_000 });
    expect(client.crossed()).toBe(1);

    setAnnotationResolved(client.doc, thread.id, true);
    repair(client, T0 + 3_000, T0 + 3_000);
    expect(stub(client)).toMatchObject({ openThreadCount: 0, updatedAt: T0 + 3_000 });

    expect(setAnnotationResolved(client.doc, thread.id, false)).toBeNull();
    repair(client, T0 + 4_000, T0 + 4_000);
    expect(stub(client)).toMatchObject({ openThreadCount: 0, updatedAt: T0 + 3_000 });
    expect(client.crossed()).toBe(2);
  });

  it("bumps updatedAt at most once per window under a typing burst", () => {
    const client = rig("Burst");
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0 + 500, T0 + 500);
    expect(client.crossed()).toBe(0);

    let text = "";
    for (let index = 0; index < 20; index += 1) {
      const now = T0 + 1_000 + index * 1_000;
      const next = `${text}x`;
      editBlock(client.doc, block, text, next);
      repair(client, now, now);
      text = next;
    }
    expect(stub(client).updatedAt).toBe(T0);
    expect(client.crossed()).toBe(0);

    editBlock(client.doc, block, text, `${text}y`);
    repair(client, T0 + WINDOW, T0 + WINDOW);
    text = `${text}y`;
    expect(stub(client).updatedAt).toBe(T0 + WINDOW);
    expect(client.crossed()).toBe(1);

    editBlock(client.doc, block, text, `${text}z`);
    repair(client, T0 + WINDOW + 1_000, T0 + WINDOW + 1_000);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW);
    expect(client.crossed()).toBe(1);
    expect(stub(client).createdAt).toBe(T0);
  });

  it("uses the caller's coarseness window, including zero", () => {
    const client = rig("Uncoarsened");
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0 + 1, T0 + 1, 0);
    expect(stub(client).updatedAt).toBe(T0 + 1);
    editBlock(client.doc, block, "", "x");
    repair(client, T0 + 2, T0 + 2, 0);
    expect(stub(client).updatedAt).toBe(T0 + 2);
    expect(client.crossed()).toBe(2);
  });

  it("measures a delayed content repair from the authored time and respects future stamps", () => {
    const client = rig("Delayed");
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0 + WINDOW * 2, T0 + 1_000);
    expect(stub(client).updatedAt).toBe(T0);
    expect(client.crossed()).toBe(0);

    upsertDirectoryEntry(client.peer, {
      uuid: UUID, title: "Delayed", updatedAt: T0 + WINDOW * 3,
    });
    syncDocs(client.directory, client.peer);
    const afterTheirStamp = client.crossed();
    editBlock(client.doc, block, "", "x");
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW * 3);
    expect(client.crossed()).toBe(afterTheirStamp);
  });

  it("bumps updatedAt immediately on a title change", () => {
    const client = rig("Before");
    setTitle(client.doc, "After");
    repair(client, T0 + 1_000, T0 + 1_000);
    expect(stub(client)).toMatchObject({
      title: "After", createdAt: T0, updatedAt: T0 + 1_000,
    });
  });

  it("bumps updatedAt immediately on a tag change", () => {
    const client = rig("Retagged");
    setTags(client.doc, ["reference"]);
    repair(client, T0 + 1_000, T0 + 1_000);
    expect(stub(client)).toMatchObject({ tags: ["reference"], updatedAt: T0 + 1_000 });
  });

  it("bumps updatedAt immediately on an authored description change", () => {
    const client = rig("Described");
    setDescription(client.doc, "New description");
    repair(client, T0 + 1_000, T0 + 1_000);
    expect(stub(client)).toMatchObject({
      description: "New description", createdAt: T0, updatedAt: T0 + 1_000,
    });
    expect(client.crossed()).toBe(1);
  });

  it("backfills createdAt without other changes and preserves it through later repairs", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Legacy" });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID, title: "Legacy", openThreadCount: 0, code_check: [], updatedAt: T0,
    });
    const client = observe(doc, directory);

    repair(client, T0 + WINDOW * 3, null);
    expect(stub(client)).toMatchObject({ createdAt: T0 + WINDOW * 3, updatedAt: T0 });
    expect(client.crossed()).toBe(1);
    repair(client, T0 + WINDOW * 4, null);
    expect(client.crossed()).toBe(1);

    setTitle(doc, "Arrived title");
    repair(client, T0 + WINDOW * 4, null);
    expect(stub(client)).toMatchObject({
      title: "Arrived title", createdAt: T0 + WINDOW * 3, updatedAt: T0,
    });
    setTitle(doc, "Authored title");
    repair(client, T0 + WINDOW * 4, T0 + WINDOW * 4);
    expect(stub(client)).toMatchObject({
      title: "Authored title", createdAt: T0 + WINDOW * 3, updatedAt: T0 + WINDOW * 4,
    });
    expect(client.crossed()).toBe(3);
  });

  it("does not backfill an ordinary tombstone missing createdAt", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Archived" });
    const block = appendBlock(doc, { type: "paragraph", text: "still open" });
    createAnnotation(doc, block, 0, 10, "Author", "Unresolved before archive");
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Archived" });
    tombstoneDirectoryEntry(directory, UUID);
    const client = observe(doc, directory);
    repair(client, T0, null);
    setDescription(doc, "Authored after archive");
    repair(client, T0 + 1_000, T0 + 1_000);
    expect(stub(client)).toEqual({ uuid: UUID, title: "Archived", tags: [], deleted: true });
    expect(client.crossed()).toBe(0);
  });

  it("repairs a stub that disagrees with the document without stamping", () => {
    const client = rig("Authoritative", "Stale");
    repair(client, T0 + WINDOW * 3, null);
    expect(stub(client)).toMatchObject({ title: "Authoritative", createdAt: T0, updatedAt: T0 });
  });

  it("leaves an ordinary tombstone alone however far the stub has drifted", () => {
    const client = rig("Retired protocol");
    const before = client.crossed();
    tombstoneDirectoryEntry(client.peer, UUID);
    syncDocs(client.directory, client.peer);

    setTitle(client.doc, "Renamed after the archive");
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);
    editBlock(client.doc, block, "", "and edited too");
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);

    expect(stub(client)).toMatchObject({ title: "Retired protocol", deleted: true });
    expect(client.crossed()).toBe(before + 1);
  });

  it("stands down for a window another replica has already stamped", () => {
    const client = rig("Shared");
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0, T0);
    upsertDirectoryEntry(client.peer, { uuid: UUID, title: "Shared", updatedAt: T0 + WINDOW });
    syncDocs(client.directory, client.peer);
    const afterTheirStamp = client.crossed();

    editBlock(client.doc, block, "", "x");
    repair(client, T0 + WINDOW + 1_000, T0 + WINDOW + 1_000);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW);
    expect(client.crossed()).toBe(afterTheirStamp);

    editBlock(client.doc, block, "x", "xy");
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW * 2);
  });

  it("measures the window from the greatest stamp even when its whole-entry write lost", () => {
    const client = rig("Shared");
    client.directory.clientID = 2;
    client.peer.clientID = 1;
    upsertDirectoryEntry(client.directory, {
      uuid: UUID, title: "Shared", updatedAt: T0 + WINDOW,
    });
    upsertDirectoryEntry(client.peer, {
      uuid: UUID, title: "Shared", updatedAt: T0 + WINDOW + 2_000,
    });
    syncDocs(client.directory, client.peer);
    expect(getDirectoryMap(client.directory).get(UUID)).toMatchObject({ updatedAt: T0 + WINDOW });
    expect(stub(client).updatedAt).toBe(T0 + WINDOW + 2_000);
    const before = client.crossed();

    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    repair(client, T0 + WINDOW * 2, T0 + WINDOW * 2);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW + 2_000);
    expect(client.crossed()).toBe(before);

    editBlock(client.doc, block, "", "x");
    repair(client, T0 + WINDOW * 2 + 2_000, T0 + WINDOW * 2 + 2_000);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW * 2 + 2_000);
    expect(client.crossed()).toBe(before + 1);
  });
});

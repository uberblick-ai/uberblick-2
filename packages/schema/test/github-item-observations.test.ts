import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  getMeta, readGitHubItemObservations, writeGitHubItemObservation,
  type GitHubItemObservation,
} from "../src/index.js";

const key = "uberblick-ai/uberblick-2#2437:issue";
const day = 24 * 60 * 60 * 1_000;
const open: GitHubItemObservation = { state: "issue-open", seenAt: 1_000, isPublic: true };

describe("workspace GitHub observations", () => {
  it("writes only changes or a reading at least a day newer, with no document fields", () => {
    const doc = new Y.Doc();
    const updates = vi.fn();
    doc.on("update", updates);
    expect(writeGitHubItemObservation(doc, key, open)).toBe(true);
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: open.seenAt + day - 1 })).toBe(false);
    expect(updates).toHaveBeenCalledOnce();
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: open.seenAt + day })).toBe(true);
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: open.seenAt + day + 1, state: "issue-completed" })).toBe(true);
    expect(readGitHubItemObservations(doc).get(key)).toEqual({ ...open, seenAt: open.seenAt + day + 1, state: "issue-completed" });
    expect(getMeta(doc).uuid).toBe("");
    const values = [...doc.getMap("githubItems").values()];
    expect(values).toEqual([{ state: "issue-completed", seenAt: open.seenAt + day + 1, isPublic: true }]);
    doc.destroy();
  });

  it("never replaces a state with an unknown, older or wrong-kind observation", () => {
    const doc = new Y.Doc();
    writeGitHubItemObservation(doc, key, open);
    const update = vi.fn();
    doc.on("update", update);
    expect(writeGitHubItemObservation(doc, key, { ...open, state: null } as unknown as GitHubItemObservation)).toBe(false);
    expect(writeGitHubItemObservation(doc, key, { ...open, state: "pull-merged" })).toBe(false);
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: 999, state: "issue-completed" })).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(readGitHubItemObservations(doc).get(key)).toEqual(open);
    doc.destroy();
  });

  it("keeps only the three permitted fields and refreshes visibility with the next daily reading", () => {
    const doc = new Y.Doc();
    writeGitHubItemObservation(doc, key, { ...open, title: "must not persist", author: "must not persist" } as GitHubItemObservation);
    expect([...doc.getMap("githubItems").values()]).toEqual([open]);
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: 2_000, isPublic: false })).toBe(false);
    expect(writeGitHubItemObservation(doc, key, { ...open, seenAt: open.seenAt + day, isPublic: false })).toBe(true);
    expect(readGitHubItemObservations(doc).get(key)?.isPublic).toBe(false);
    doc.destroy();
  });

  it.each([false, true])("converges by seen time despite client ids, delivery order and pruning (reverse=%s)", reverse => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    first.clientID = 900;
    second.clientID = 100;
    writeGitHubItemObservation(first, key, open);
    writeGitHubItemObservation(second, key, { ...open, seenAt: 2_000, state: "issue-completed" });
    const firstUpdate = Y.encodeStateAsUpdate(first);
    const secondUpdate = Y.encodeStateAsUpdate(second);
    const observer = new Y.Doc();
    for (const update of reverse ? [secondUpdate, firstUpdate] : [firstUpdate, secondUpdate]) Y.applyUpdate(observer, update);
    Y.applyUpdate(first, secondUpdate);
    Y.applyUpdate(second, firstUpdate);
    const closed = { ...open, seenAt: 2_000, state: "issue-completed" };
    for (const doc of [first, second, observer]) expect(readGitHubItemObservations(doc).get(key)).toEqual(closed);

    // First prunes what it saw while second concurrently changes its own slot.
    writeGitHubItemObservation(first, key, { ...open, seenAt: 3_000, state: "issue-not-planned" });
    writeGitHubItemObservation(second, key, { ...open, seenAt: 4_000, state: "issue-duplicate" });
    const latestFirst = Y.encodeStateAsUpdate(first);
    const latestSecond = Y.encodeStateAsUpdate(second);
    Y.applyUpdate(first, latestSecond);
    Y.applyUpdate(second, latestFirst);
    for (const update of reverse ? [latestSecond, latestFirst] : [latestFirst, latestSecond]) Y.applyUpdate(observer, update);
    for (const doc of [first, second, observer]) {
      expect(readGitHubItemObservations(doc).get(key)).toEqual({ ...open, seenAt: 4_000, state: "issue-duplicate" });
      doc.destroy();
    }
  });

  it("settles equal timestamps deterministically, conservatively retaining private visibility", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    writeGitHubItemObservation(first, key, open);
    writeGitHubItemObservation(second, key, { ...open, isPublic: false });
    const update = Y.encodeStateAsUpdate(first);
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    Y.applyUpdate(second, update);
    expect(readGitHubItemObservations(first)).toEqual(readGitHubItemObservations(second));
    expect(readGitHubItemObservations(first).get(key)?.isPublic).toBe(false);
    first.destroy();
    second.destroy();
  });
});

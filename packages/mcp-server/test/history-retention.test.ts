import type { RevisionEntry } from "@uberblick/schema";
import { describe, expect, it } from "vitest";
import { selectHistorySnapshots } from "../src/history-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function revision(id: string, overrides: Partial<RevisionEntry> = {}): RevisionEntry {
  return { id, author: null, startedAt: DAY, endedAt: 2 * DAY, final: true, ...overrides };
}

function named(id: string): RevisionEntry {
  return revision(id, { name: { text: id, namer: null, namedAt: DAY, canManage: false } });
}

describe("history snapshot retention", () => {
  it("keeps named states, the newest downloaded state and their immediate comparisons without recursion", () => {
    const revisions = [revision("r7"), revision("r6"), named("r5"), revision("r4"), revision("r3"), named("r2"), revision("r1"), revision("r0")];
    const downloaded = new Set(revisions.map(entry => entry.id));
    expect(selectHistorySnapshots({ revisions, downloaded }, { mode: "named" }, NOW))
      .toEqual(new Set(["r7", "r6", "r5", "r4", "r2", "r1"]));
    expect(downloaded.size).toBe(8);
    expect(revisions.map(entry => entry.id)).toEqual(["r7", "r6", "r5", "r4", "r3", "r2", "r1", "r0"]);
  });

  it("uses the catalog's order and retains missing comparison snapshots instead of skipping to downloaded ones", () => {
    const revisions = [named("named"), revision("comparison"), revision("downloaded"), revision("before-downloaded"), revision("old")];
    const downloaded = new Set(["old", "downloaded"]);
    expect(selectHistorySnapshots({ revisions, downloaded }, { mode: "named" }, NOW))
      .toEqual(new Set(["named", "comparison", "downloaded", "before-downloaded"]));
  });

  it("keeps open revisions and revisions ending within the recent window, including its boundary", () => {
    const revisions = [
      revision("open", { startedAt: DAY, endedAt: null, final: false }),
      revision("long-edit", { startedAt: DAY, endedAt: NOW }),
      revision("boundary", { endedAt: NOW - 7 * DAY }),
      revision("before-boundary", { endedAt: NOW - 7 * DAY - 1 }),
      revision("old"),
      revision("earlier", { startedAt: null, endedAt: null }),
    ];
    expect(selectHistorySnapshots({ revisions, downloaded: new Set() }, { mode: "recent", days: 7, keepNamed: false }, NOW))
      .toEqual(new Set(["open", "long-edit", "boundary", "before-boundary"]));
  });

  it("optionally retains older named revisions and their comparisons in recent mode", () => {
    const revisions = [revision("recent", { endedAt: NOW }), revision("comparison"), named("named"), revision("before-named"), revision("old")];
    const page = { revisions, downloaded: new Set<string>() };
    expect(selectHistorySnapshots(page, { mode: "recent", days: 30, keepNamed: false }, NOW))
      .toEqual(new Set(["recent", "comparison"]));
    expect(selectHistorySnapshots(page, { mode: "recent", days: 30, keepNamed: true }, NOW))
      .toEqual(new Set(["recent", "comparison", "named", "before-named"]));
  });

  it("retains every known revision under everything", () => {
    const revisions = [revision("current"), revision("old"), revision("earlier", { startedAt: null, endedAt: null })];
    expect(selectHistorySnapshots({ revisions, downloaded: new Set() }, { mode: "everything" }, NOW))
      .toEqual(new Set(["current", "old", "earlier"]));
  });

  it("protects displayed or downloading snapshots and downloaded heads even before they enter the catalog", () => {
    const revisions = [revision("latest"), revision("comparison"), revision("held"), revision("before-held"), revision("old")];
    const held = new Set(["held", "downloading"]);
    expect(selectHistorySnapshots({ revisions, downloaded: new Set(["latest", "current-head"]), held, currentHeadId: "current-head" }, { mode: "named" }, NOW))
      .toEqual(new Set(["latest", "comparison", "held", "before-held", "downloading", "current-head"]));
    expect(held).toEqual(new Set(["held", "downloading"]));
    expect(selectHistorySnapshots({ revisions: [], downloaded: new Set(), currentHeadId: "not-downloaded" }, { mode: "named" }, NOW)).toEqual(new Set());
  });

  it("recognizes an open entry from an older hub without treating Earlier content as open", () => {
    const legacyOpen: RevisionEntry = { id: "legacy-open", author: null, startedAt: DAY, endedAt: null };
    const earlier: RevisionEntry = { id: "earlier", author: null, startedAt: null, endedAt: null };
    const revisions = [legacyOpen, revision("comparison"), revision("old"), earlier];
    expect(selectHistorySnapshots({ revisions, downloaded: new Set() }, { mode: "recent", days: 90, keepNamed: false }, NOW))
      .toEqual(new Set(["legacy-open", "comparison"]));
  });
});

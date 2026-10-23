import { act, render, type RenderResult } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getMeta, initDoc, type RevisionEntry } from "@uberblick/schema";
import { DocumentHistoryError, type DocumentRevisionsClient } from "../src/shell/document-revisions.js";
import { renamedFrom, useDocumentHistory, type DocumentHistory } from "../src/ui/document/document-history.js";

const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const OTHER_UUID = "4a9939be-2778-442f-9278-e1517ef88335";
const entries: RevisionEntry[] = [
  { id: "newest", author: { githubUsername: "ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 100, endedAt: null },
  { id: "middle", author: { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } }, startedAt: 50, endedAt: 100 },
  { id: "earliest", author: null, startedAt: null, endedAt: 50 },
];
const documents: Y.Doc[] = [];
afterEach(() => { for (const doc of documents.splice(0)) if (!doc.isDestroyed) doc.destroy(); });

function document(title: string): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title });
  documents.push(doc);
  return doc;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function client(read: DocumentRevisionsClient["get"] = async (_uuid, id) => document(id)): DocumentRevisionsClient {
  return { list: vi.fn(async () => entries), get: vi.fn(read), name: vi.fn(), rename: vi.fn(), removeName: vi.fn() };
}

function mount(api: DocumentRevisionsClient | null, uuid: string | null = UUID, path = "/document/one"): {
  view: RenderResult;
  reading: () => DocumentHistory;
  seen: DocumentHistory[];
  visit: (nextApi: DocumentRevisionsClient | null, nextUuid: string | null, nextPath: string) => void;
} {
  const seen: DocumentHistory[] = [];
  function Probe({ api, uuid, path }: { api: DocumentRevisionsClient | null; uuid: string | null; path: string }): null {
    seen.push(useDocumentHistory(api, uuid, path));
    return null;
  }
  const view = render(<Probe api={api} uuid={uuid} path={path} />);
  return { view, seen, reading: () => seen.at(-1)!,
    visit: (nextApi, nextUuid, nextPath) => view.rerender(<Probe api={nextApi} uuid={nextUuid} path={nextPath} />) };
}

describe("document history navigation", () => {
  it("compares the newest revision with the most recent named state, skipping intervening revisions", async () => {
    const api = client();
    const named: RevisionEntry = { ...entries[2]!, name: {
      text: "Reviewed", namer: { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } }, namedAt: 50, canManage: true,
    } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, named]);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().sinceLastNamed());
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("earliest");
    expect(fix.reading().selection!.comparedWith).toEqual(named);
    expect(fix.reading().titles).toEqual({ newest: "newest", middle: "middle", earliest: "earliest" });
    await act(async () => fix.reading().back());
    expect(fix.reading().selection?.comparedWith).toBeUndefined();
    expect(fix.reading().entry?.id).toBe("middle");
  });

  it("keeps the displayed revision alive when a named comparison disappears or cannot be read", async () => {
    const api = client();
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const original = fix.reading().selection;
    await act(async () => fix.reading().sinceLastNamed());
    expect(fix.reading().selection).toBe(original);
    expect(original?.after.isDestroyed).toBe(false);
    expect(original?.before?.isDestroyed).toBe(false);
    const named: RevisionEntry = { ...entries[2]!, name: {
      text: "Reviewed", namer: null, namedAt: 50, canManage: false,
    } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, named]);
    const newer = document("Refreshed newest");
    vi.mocked(api.get).mockResolvedValueOnce(newer).mockRejectedValueOnce(new DocumentHistoryError("unreachable"));
    await act(async () => fix.reading().sinceLastNamed());
    expect(newer.isDestroyed).toBe(true);
    expect(fix.reading().selection).toBe(original);
    expect(original?.after.isDestroyed).toBe(false);
  });

  it("updates naming metadata without discarding the selected document and preserves it when a write is refused", async () => {
    const api = client();
    const named: RevisionEntry = { ...entries[0]!, endedAt: 120, name: {
      text: "Reviewed", namer: { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } }, namedAt: 120, canManage: true,
    } };
    vi.mocked(api.name).mockResolvedValue(named);
    vi.mocked(api.rename).mockRejectedValue(new DocumentHistoryError("not-namer"));
    vi.mocked(api.removeName).mockResolvedValue({ ...named, name: null });
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().name("Reviewed", "checksum"));
    expect(api.name).toHaveBeenCalledWith(UUID, "Reviewed", "checksum", expect.any(AbortSignal));
    expect(fix.reading().entries?.[0]).toEqual(named);
    vi.mocked(api.list).mockResolvedValue([named, ...entries.slice(1)]);
    await act(async () => fix.reading().back());
    const snapshot = fix.reading().selection?.after;
    await act(async () => {
      await expect(fix.reading().rename(named.id, "Other")).rejects.toThrow(/Only the person/);
    });
    expect(fix.reading().entry).toEqual(named);
    expect(fix.reading().busy).toBe(false);
    await act(async () => fix.reading().removeName(named.id));
    expect(fix.reading().entry?.name).toBeNull();
    expect(fix.reading().selection?.after).toBe(snapshot);
  });

  it("steps newest first with the predecessor for each comparison and clears earliest changes", async () => {
    const api = client();
    const fix = mount(api);
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ available: true, active: false, busy: false, entries });
    await act(async () => fix.reading().back());
    expect(fix.reading().entry).toEqual(entries[0]);
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("middle");
    await act(async () => fix.reading().back());
    expect(fix.reading().entry).toEqual(entries[1]);
    await act(async () => fix.reading().back());
    expect(fix.reading().entry).toEqual(entries[2]);
    expect(fix.reading().selection!.before).toBeNull();
    await act(async () => fix.reading().back());
    expect(fix.reading().entry).toEqual(entries[2]);
    await act(async () => fix.reading().forward());
    expect(fix.reading().entry).toEqual(entries[1]);
    await act(async () => fix.reading().now());
    expect(fix.reading()).toMatchObject({ active: false, selection: null, error: null, busy: false });
    fix.view.unmount();
    expect(documents.every(doc => doc.isDestroyed)).toBe(true);
  });

  it("distinguishes no revisions from unavailable history and permits a later retry", async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValueOnce([]).mockRejectedValueOnce(new DocumentHistoryError("forbidden")).mockResolvedValue(entries);
    const fix = mount(api);
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ entries: [], error: null, busy: false });
    await act(async () => fix.reading().refresh());
    expect(fix.reading().error).toMatch(/refused access/);
    expect(fix.reading().active).toBe(false);
    await act(async () => fix.reading().refresh());
    expect(fix.reading()).toMatchObject({ entries, error: null, busy: false });
  });

  it("never shows a late list answer or failure from a previous route, even before effects settle", async () => {
    const stale = deferred<RevisionEntry[]>();
    const old = client();
    vi.mocked(old.list).mockReturnValue(stale.promise);
    const next = client();
    vi.mocked(next.list).mockResolvedValue([]);
    const fix = mount(old);
    const oldSignal = vi.mocked(old.list).mock.calls[0]![1];
    const firstReplacement = fix.seen.length;
    fix.visit(next, OTHER_UUID, "/document/two");
    expect(fix.seen[firstReplacement]).toMatchObject({ entries: null, selection: null, active: false });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => stale.resolve(entries));
    expect(fix.reading()).toMatchObject({ entries: [], error: null, active: false });

    const lateFailure = deferred<RevisionEntry[]>();
    vi.mocked(old.list).mockReturnValue(lateFailure.promise);
    fix.visit(old, UUID, "/document/one");
    fix.visit(next, OTHER_UUID, "/document/two");
    await act(async () => lateFailure.reject(new DocumentHistoryError("forbidden")));
    expect(fix.reading()).toMatchObject({ entries: [], error: null, active: false });
  });

  it("destroys both cached and late-returning detached documents when a route aborts", async () => {
    const pending = deferred<Y.Doc>();
    const after = document("newest");
    const before = document("middle");
    const api = client(async (_uuid, id) => id === "newest" ? after : pending.promise);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(fix.reading().busy).toBe(true);
    const signal = vi.mocked(api.get).mock.calls[1]![2];
    fix.visit(null, null, "/all-documents");
    expect(signal.aborted).toBe(true);
    expect(after.isDestroyed).toBe(true);
    await act(async () => pending.resolve(before));
    expect(before.isDestroyed).toBe(true);
    expect(fix.reading()).toMatchObject({ available: false, active: false, selection: null, error: null });
  });

  it("returns to now during a pending navigation and refreshes an open revision on re-entry", async () => {
    const pending = deferred<Y.Doc>();
    const stale = document("Open revision before more edits");
    const fresh = document("Open revision after more edits");
    const api = client(async (_uuid, id) => document(id));
    vi.mocked(api.get).mockImplementationOnce(async () => pending.promise);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    await act(async () => fix.reading().now());
    expect(fix.reading()).toMatchObject({ active: false, busy: false, selection: null });
    await act(async () => pending.resolve(stale));
    expect(fix.reading()).toMatchObject({ active: false, busy: false, selection: null });
    vi.mocked(api.get).mockImplementationOnce(async () => fresh);
    await act(async () => fix.reading().back());
    expect(fix.reading().selection!.after).toBe(fresh);
    expect(stale.isDestroyed).toBe(true);
  });

  it("refetches an already viewed open revision after returning to now", async () => {
    let version = 1;
    const api = client(async (_uuid, id) => document(`${id} version ${version}`));
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const first = fix.reading().selection!.after;
    expect(getMeta(first).title).toBe("newest version 1");
    await act(async () => fix.reading().now());
    version = 2;
    await act(async () => fix.reading().back());
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest version 2");
    expect(first.isDestroyed).toBe(true);
    expect(vi.mocked(api.get).mock.calls.filter(call => call[1] === "newest")).toHaveLength(2);
  });

  it("never caches an older navigation request that completes after a refreshed visit", async () => {
    const pending = deferred<Y.Doc>();
    const stale = document("Old earliest reading");
    let hold = false;
    const api = client(async (_uuid, id) => {
      if (id !== "earliest") return document(id);
      return hold ? pending.promise : document("Refreshed earliest reading");
    });
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    expect(fix.reading().active).toBe(true);
    hold = true;
    await act(async () => fix.reading().back());
    expect(fix.reading().busy).toBe(true);
    await act(async () => fix.reading().now());
    hold = false;
    await act(async () => fix.reading().back());
    await act(async () => fix.reading().back());
    const fresh = fix.reading().selection!.before!;
    expect(getMeta(fresh).title).toBe("Refreshed earliest reading");
    await act(async () => pending.resolve(stale));
    expect(fix.reading().selection!.before).toBe(fresh);
    await act(async () => fix.reading().back());
    expect(fix.reading().selection!.after).toBe(fresh);
    fix.view.unmount();
    expect(stale.isDestroyed).toBe(true);
    expect(fresh.isDestroyed).toBe(true);
  });

  it("drops a retained selection immediately when the same document is visited on a different route", async () => {
    const api = client();
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const snapshot = fix.reading().selection!.after;
    const firstFrame = fix.seen.length;
    fix.visit(api, UUID, "/document/one?from=another-view");
    expect(fix.seen[firstFrame]).toMatchObject({ active: false, selection: null, entries: null });
    expect(snapshot.isDestroyed).toBe(true);
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ active: false, entries, error: null });
  });

  it("opens any listed revision directly and closes on returning to now", async () => {
    const fix = mount(client());
    await act(async () => {});
    expect(fix.reading().active).toBe(false);
    await act(async () => fix.reading().open(1));
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
    expect(fix.reading().entry?.id).toBe("middle");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("earliest");
    await act(async () => fix.reading().open(2));
    expect(fix.reading().entry?.id).toBe("earliest");
    expect(fix.reading().selection?.before).toBeNull();
    act(() => fix.reading().now());
    expect(fix.reading()).toMatchObject({ active: false, selection: null });
  });

  it("stays open on a failed entry so it can be retried in place", async () => {
    const api = client();
    vi.mocked(api.get).mockRejectedValueOnce(new DocumentHistoryError("unreachable"));
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    expect(fix.reading()).toMatchObject({ active: true, selection: null, busy: false });
    expect(fix.reading().error).toMatch(/cannot be reached/);
    await act(async () => fix.reading().retry());
    expect(fix.reading()).toMatchObject({ active: true, error: null });
    expect(fix.reading().entry?.id).toBe("newest");
  });

  it.each([
    { index: 1, prepend: false },
    { index: 1, prepend: true },
    { index: 2, prepend: false },
    { index: 2, prepend: true },
  ])("retries revision $index after a failed read, with a prepended head: $prepend", async ({ index, prepend }) => {
    let unavailable = true;
    const api = client(async (_uuid, id) => {
      if (id === "earliest" && unavailable) throw new DocumentHistoryError("unreachable");
      return document(id);
    });
    const middle: RevisionEntry = { ...entries[1]!, name: {
      text: "Reviewed", namer: null, namedAt: 100, canManage: true,
    } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, middle, entries[2]!]);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().open(0));
    const retained = fix.reading().selection;
    await act(async () => fix.reading().open(index));
    expect(fix.reading().error).toMatch(/cannot be reached/);
    expect(fix.reading().selection).toBe(retained);
    unavailable = false;
    const recovered = [entries[0]!, middle, entries[2]!];
    if (prepend) recovered.unshift({ ...entries[0]!, id: "new-head" });
    vi.mocked(api.list).mockResolvedValue(recovered);
    await act(async () => fix.reading().retry());
    const expected = index === 1 ? middle : entries[2]!;
    expect(fix.reading()).toMatchObject({ error: null, busy: false, entry: expected });
    expect(fix.reading().selection?.index).toBe(index + (prepend ? 1 : 0));
    expect(getMeta(fix.reading().selection!.after).title).toBe(expected.id);
    if (index === 1) expect(getMeta(fix.reading().selection!.before!).title).toBe("earliest");
    else expect(fix.reading().selection?.before).toBeNull();
    for (const state of fix.seen) {
      if (state.selection !== null) expect(state.entries?.[state.selection.index]?.id).toBe(getMeta(state.selection.after).title);
    }
  });

  it("keeps the selected revision identity when a refresh or naming prepends a revision", async () => {
    const api = client();
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().open(1));
    const snapshot = fix.reading().selection!.after;
    const head: RevisionEntry = { ...entries[0]!, id: "new-head" };
    vi.mocked(api.list).mockResolvedValue([head, ...entries]);
    await act(async () => fix.reading().refresh());
    expect(fix.reading().entry?.id).toBe("middle");
    expect(fix.reading().selection).toMatchObject({ index: 2, after: snapshot });
    const named: RevisionEntry = { ...head, id: "named-head", name: {
      text: "Reviewed", namer: null, namedAt: 100, canManage: true,
    } };
    vi.mocked(api.name).mockResolvedValue(named);
    await act(async () => fix.reading().name("Reviewed", "checksum"));
    expect(fix.reading().entry?.id).toBe("middle");
    expect(fix.reading().selection).toMatchObject({ index: 3, after: snapshot });
  });

  it("compares the newest revision with a chosen named revision, not only the latest one", async () => {
    const api = client();
    const name = (text: string) => ({ text, namer: { githubUsername: "ben", surface: { kind: "browser" as const, name: "Browser" } }, namedAt: 50, canManage: true });
    const middle: RevisionEntry = { ...entries[1]!, name: name("Draft") };
    const earliest: RevisionEntry = { ...entries[2]!, name: name("Kickoff") };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, middle, earliest]);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().sinceNamed("earliest"));
    expect(fix.reading().selection!.comparedWith).toEqual(earliest);
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
    await act(async () => fix.reading().sinceNamed("gone"));
    expect(fix.reading().error).toMatch(/no longer available/);
    expect(fix.reading().selection!.comparedWith).toEqual(earliest);
  });

  it("loads sidebar rename information before visiting entries and retains it across named comparisons", async () => {
    const api = client(async (_uuid, id) => document(id === "earliest" ? "Alpha" : "Beta"));
    const baseline = { ...entries[2]!, name: { text: "Kickoff", namer: null, namedAt: 50, canManage: false } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, baseline]);
    const fix = mount(api);
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => fix.reading().back());
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBe("Alpha");
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 0)).toBeNull();
    await act(async () => fix.reading().open(1));
    await act(async () => fix.reading().sinceNamed("earliest"));
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBe("Alpha");
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 0)).toBeNull();
    fix.view.unmount();
    expect(documents.every(doc => doc.isDestroyed)).toBe(true);
  });

  it("cancels title-only reads on leaving history and destroys late answers without adopting them", async () => {
    const pending = deferred<Y.Doc>();
    const api = client(async (_uuid, id) => id === "earliest" ? pending.promise : document(id));
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const signal = vi.mocked(api.get).mock.calls.find(call => call[1] === "earliest")![2];
    expect(fix.reading().busy).toBe(false);
    await act(async () => fix.reading().now());
    expect(signal.aborted).toBe(true);
    const late = document("Late title");
    await act(async () => pending.resolve(late));
    expect(late.isDestroyed).toBe(true);
    expect(fix.reading().titles.earliest).toBeUndefined();
    expect(fix.reading().error).toBeNull();
  });

  it("reports a title read failure without discarding the comparison and retries the missing information", async () => {
    let unavailable = true;
    const api = client(async (_uuid, id) => {
      if (id === "earliest" && unavailable) throw new DocumentHistoryError("unreachable");
      return document(id);
    });
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const selected = fix.reading().selection;
    expect(fix.reading().error).toMatch(/cannot be reached/);
    expect(selected!.after.isDestroyed).toBe(false);
    unavailable = false;
    await act(async () => fix.reading().retry());
    expect(fix.reading().selection).toBe(selected);
    expect(fix.reading().titles.earliest).toBe("earliest");
    expect(fix.reading().error).toBeNull();
  });
});

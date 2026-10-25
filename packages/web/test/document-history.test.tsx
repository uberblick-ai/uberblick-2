import { act, render, type RenderResult } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import * as Y from "yjs";
import { getMeta, initDoc, setTitle, type RevisionEntry } from "@uberblick/schema";
import * as revisionClient from "../src/shell/document-revisions.js";
import { DocumentHistoryError, type DocumentRevisionsClient } from "../src/shell/document-revisions.js";
import { renamedFrom, useDocumentHistory, type DocumentHistory } from "../src/ui/document/document-history.js";
import type { RevisionView } from "../src/ui/route.js";

const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const OTHER_UUID = "4a9939be-2778-442f-9278-e1517ef88335";
const entries: RevisionEntry[] = [
  { id: "newest", title: "newest", author: { githubUsername: "ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 100, endedAt: null },
  { id: "middle", title: "middle", author: { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } }, startedAt: 50, endedAt: 100 },
  { id: "earliest", title: "earliest", author: null, startedAt: null, endedAt: 50 },
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
  return { list: vi.fn(async () => entries), get: vi.fn(read), name: vi.fn(), rename: vi.fn(), removeName: vi.fn(), restore: vi.fn() };
}

function mount(api: DocumentRevisionsClient | null, uuid: string | null = UUID, path = "/document/one", liveDocument: Y.Doc | null = null): {
  view: RenderResult;
  reading: () => DocumentHistory;
  seen: DocumentHistory[];
  visit: (nextApi: DocumentRevisionsClient | null, nextUuid: string | null, nextPath: string) => void;
} {
  const seen: DocumentHistory[] = [];
  function Probe({ api, uuid, path }: { api: DocumentRevisionsClient | null; uuid: string | null; path: string }): null {
    seen.push(useDocumentHistory(api, uuid, path, liveDocument));
    return null;
  }
  const view = render(<Probe api={api} uuid={uuid} path={path} />);
  return { view, seen, reading: () => seen.at(-1)!,
    visit: (nextApi, nextUuid, nextPath) => view.rerender(<Probe api={nextApi} uuid={nextUuid} path={nextPath} />) };
}

function mountRouted(initialApi: DocumentRevisionsClient | null, initialView: RevisionView | null, initialDocument: Y.Doc | null = null) {
  let api = initialApi;
  let change!: (next: RevisionView | null, nextApi: DocumentRevisionsClient | null) => void;
  let hydrate!: (next: Y.Doc | null) => void;
  const seen: DocumentHistory[] = [];
  const navigate = vi.fn((next: RevisionView | null) => change(next, api));
  function Probe(): null {
    const [input, setInput] = useState({ api: initialApi, view: initialView, liveDocument: initialDocument });
    change = (next, nextApi) => setInput(previous => ({ ...previous, api: nextApi, view: next }));
    hydrate = next => setInput(previous => ({ ...previous, liveDocument: next }));
    seen.push(useDocumentHistory(input.api, UUID, "/document/one", input.liveDocument, { view: input.view, navigate }));
    return null;
  }
  const view = render(<Probe />);
  return { view, seen, navigate, reading: () => seen.at(-1)!,
    visit: (next: RevisionView | null, nextApi = api) => {
      api = nextApi;
      act(() => change(next, nextApi));
    },
    hydrate: (next: Y.Doc | null) => act(() => hydrate(next)),
  };
}

function anchorHistory(): RevisionEntry[] {
  const names: Record<string, string> = { release: "Release", review: "Reviewed", kickoff: "Kickoff" };
  return ["newest", "release", "release-edit", "review", "review-edit", "kickoff", "earliest"].map((id, index) => ({
    id, title: id, author: id === "earliest" ? null : entries[0]!.author,
    startedAt: id === "earliest" ? null : 100 - index * 10, endedAt: index === 0 ? null : 110 - index * 10,
    ...(names[id] === undefined ? {} : { name: { text: names[id], namer: null, namedAt: 100 - index * 10, canManage: true } }),
  }));
}

describe("named history navigation", () => {
  it("opens named comparisons and steps between anchors from After, stopping at both ends", async () => {
    const api = client();
    const revisions = anchorHistory();
    vi.mocked(api.list).mockResolvedValue(revisions);
    const fix = mountRouted(api, null);
    await act(async () => {});
    await act(async () => fix.reading().open(1));
    await act(async () => fix.reading().setFilter("named"));
    expect(fix.reading()).toMatchObject({ filter: "named", canBack: true, canForward: false });
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "release", since: "review" });
    expect(fix.reading().selection).toMatchObject({ index: 1, comparedWith: revisions[3] });
    expect(getMeta(fix.reading().selection!.before!).title).toBe("review");

    await act(async () => fix.reading().back());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review", since: "kickoff" });
    expect(fix.reading().entry?.id).toBe("review");
    expect(fix.reading()).toMatchObject({ canBack: true, canForward: true });
    await act(async () => fix.reading().back());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "kickoff", since: "earliest" });
    expect(fix.reading().selection).toMatchObject({ index: 5, comparedWith: revisions[6] });
    expect(fix.reading()).toMatchObject({ canBack: false, canForward: true });
    const oldest = fix.reading().selection;
    fix.navigate.mockClear();
    await act(async () => fix.reading().back());
    expect(fix.reading().selection).toBe(oldest);
    expect(fix.navigate).not.toHaveBeenCalled();

    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review", since: "kickoff" });
    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "release", since: "review" });
    const newest = fix.reading().selection;
    expect(fix.reading()).toMatchObject({ canBack: true, canForward: false });
    fix.navigate.mockClear();
    await act(async () => fix.reading().forward());
    expect(fix.reading().selection).toBe(newest);
    expect(fix.navigate).not.toHaveBeenCalled();
    await act(async () => fix.reading().open(3));
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review", since: "kickoff" });
  });

  it("shows a named earliest revision alone and keeps All stepping adjacent through now", async () => {
    const api = client();
    const revisions = anchorHistory();
    revisions[6] = { ...revisions[6]!, name: { text: "Beginning", namer: null, namedAt: 40, canManage: true } };
    vi.mocked(api.list).mockResolvedValue(revisions);
    const fix = mountRouted(api, { revision: "kickoff" });
    await act(async () => {});
    await act(async () => fix.reading().setFilter("named"));
    await act(async () => fix.reading().back());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "earliest" });
    expect(fix.reading().selection).toMatchObject({ index: 6, before: null });
    expect(fix.reading().selection?.comparedWith).toBeUndefined();
    expect(fix.reading()).toMatchObject({ canBack: false, canForward: true });

    await act(async () => fix.reading().setFilter("all"));
    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "kickoff" });
    await act(async () => fix.reading().open(1));
    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "newest" });
    expect(fix.reading().canForward).toBe(true);
    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith(null);
    expect(fix.reading()).toMatchObject({ active: false, filter: "all", selection: null });
  });

  it("changes a selected anchor's baseline on filter switches and preserves an unnamed selection", async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue(anchorHistory());
    const fix = mountRouted(api, { revision: "review" });
    await act(async () => {});
    await act(async () => fix.reading().setFilter("named"));
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review", since: "kickoff" });
    expect(getMeta(fix.reading().selection!.after).title).toBe("review");
    await act(async () => fix.reading().setFilter("all"));
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review" });
    expect(getMeta(fix.reading().selection!.before!).title).toBe("review-edit");
    expect(fix.reading().selection?.comparedWith).toBeUndefined();

    await act(async () => fix.reading().open(2));
    const unnamed = fix.reading().selection;
    fix.navigate.mockClear();
    await act(async () => fix.reading().setFilter("named"));
    expect(fix.reading().selection).toBe(unnamed);
    expect(fix.navigate).not.toHaveBeenCalled();
    expect(fix.reading()).toMatchObject({ canBack: true, canForward: true });
    await act(async () => fix.reading().back());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "review", since: "kickoff" });
    await act(async () => fix.reading().setFilter("all"));
    await act(async () => fix.reading().open(2));
    await act(async () => fix.reading().setFilter("named"));
    await act(async () => fix.reading().forward());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "release", since: "review" });
  });

  it.each([
    { index: 0, canBack: true, canForward: false, direction: "back" as const, address: { revision: "release", since: "review" } },
    { index: 6, canBack: false, canForward: true, direction: "forward" as const, address: { revision: "kickoff", since: "earliest" } },
  ])("steps toward names from unnamed revision $index with the opposite control disabled", async ({ index, canBack, canForward, direction, address }) => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue(anchorHistory());
    const fix = mountRouted(api, null);
    await act(async () => {});
    await act(async () => fix.reading().open(index));
    await act(async () => fix.reading().setFilter("named"));
    expect(fix.reading()).toMatchObject({ canBack, canForward });
    await act(async () => fix.reading()[direction]());
    expect(fix.navigate).toHaveBeenLastCalledWith(address);
  });

  it("renders addressed endpoints under either filter, including browser navigation to a plain named revision", async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue(anchorHistory());
    const fix = mountRouted(api, { revision: "release", since: "kickoff" });
    await act(async () => {});
    expect(fix.reading().filter).toBe("all");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("kickoff");
    expect(fix.navigate).not.toHaveBeenCalled();
    await act(async () => fix.reading().setFilter("named"));
    fix.navigate.mockClear();

    fix.visit({ revision: "release", since: "kickoff" });
    await act(async () => {});
    expect(fix.reading().entry?.id).toBe("release");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("kickoff");
    fix.visit({ revision: "release" });
    await act(async () => {});
    expect(getMeta(fix.reading().selection!.before!).title).toBe("release-edit");
    expect(fix.reading().selection?.comparedWith).toBeUndefined();
    expect(fix.reading().filter).toBe("named");
    expect(fix.navigate).not.toHaveBeenCalled();

    fix.visit({ revision: "release", since: "review" });
    await act(async () => {});
    expect(getMeta(fix.reading().selection!.before!).title).toBe("review");
    act(() => fix.reading().now());
    expect(fix.reading().filter).toBe("all");
    fix.visit({ revision: "release", since: "review" });
    await act(async () => {});
    expect(fix.reading().filter).toBe("all");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("review");
  });

  it.each(["all", "named"] as const)("keeps Changes since this name fixed when switching from %s", async filter => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue(anchorHistory());
    const fix = mountRouted(api, { revision: "review" });
    await act(async () => {});
    await act(async () => fix.reading().setFilter(filter));
    await act(async () => fix.reading().sinceNamed("review"));
    const selected = fix.reading().selection;
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "newest", since: "review" });
    fix.navigate.mockClear();
    await act(async () => fix.reading().setFilter(filter === "all" ? "named" : "all"));
    expect(fix.reading().selection).toBe(selected);
    expect(fix.navigate).not.toHaveBeenCalled();
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("review");
  });

  it("keeps the restore starting point and viewed snapshots through named selection and stepping", async () => {
    const checksum = vi.spyOn(revisionClient, "documentRevisionChecksum").mockImplementation(async doc => getMeta(doc).title);
    try {
      const api = client();
      vi.mocked(api.list).mockResolvedValue(anchorHistory());
      vi.mocked(api.restore).mockResolvedValue({ revision: entries[0]!, applied: false });
      const live = document("State when history opened");
      const fix = mountRouted(api, { revision: "release" }, live);
      await act(async () => {});
      const release = fix.reading().selection!.after;
      setTitle(live, "Later collaborator changes");
      await act(async () => fix.reading().setFilter("named"));
      const review = fix.reading().selection!.before;
      expect(fix.reading().selection!.after).toBe(release);
      await act(async () => fix.reading().back());
      expect(fix.reading().selection!.after).toBe(review);
      await act(async () => fix.reading().open(1));
      expect(fix.reading().selection).toMatchObject({ after: release, before: review });
      expect(release.isDestroyed).toBe(false);
      await act(async () => fix.reading().restore("review"));
      expect(api.restore).toHaveBeenLastCalledWith(UUID, "review", "State when history opened", expect.any(AbortSignal));
      fix.view.unmount();
      expect(release.isDestroyed).toBe(true);
      expect(review!.isDestroyed).toBe(true);
    } finally { checksum.mockRestore(); }
  });
});

describe("address-controlled history views", () => {
  it("opens an old revision with its own predecessor even when newer revisions exist", async () => {
    const api = client();
    const fix = mountRouted(api, { revision: "middle" });
    expect(fix.reading()).toMatchObject({ active: true, busy: true, selection: null });
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
    expect(fix.reading().entry?.id).toBe("middle");
    expect(getMeta(fix.reading().selection!.after).title).toBe("middle");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("earliest");
    expect(fix.navigate).not.toHaveBeenCalled();
  });

  it("captures a late-arriving live document before restoring a directly addressed revision", async () => {
    const checksum = vi.spyOn(revisionClient, "documentRevisionChecksum").mockImplementation(async doc => getMeta(doc).title);
    try {
      const api = client();
      vi.mocked(api.restore).mockResolvedValue({ revision: entries[0]!, applied: false });
      const fix = mountRouted(api, { revision: "middle" });
      await act(async () => {});
      expect(fix.reading().entry?.id).toBe("middle");
      await act(async () => {
        await expect(fix.reading().restore("middle")).rejects.toThrow(/Wait for the live document to load/);
      });
      expect(api.restore).not.toHaveBeenCalled();

      const live = document("Current synchronized document");
      fix.hydrate(live);
      await act(async () => {});
      setTitle(live, "Later collaborator change");
      await act(async () => { await expect(fix.reading().restore("middle")).resolves.toBe(false); });
      expect(api.restore).toHaveBeenCalledWith(UUID, "middle", "Current synchronized document", expect.any(AbortSignal));
      expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
      expect(fix.reading().entry?.id).toBe("middle");
      expect(fix.navigate).not.toHaveBeenCalled();
    } finally { checksum.mockRestore(); }
  });

  it.each([false, true])("opens fixed comparison ends with a named baseline: %s", async named => {
    const api = client();
    const earliest = { ...entries[2]!, ...(named ? { name: { text: "Reviewed", namer: null, namedAt: 50, canManage: false } } : {}) };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, earliest]);
    const fix = mountRouted(api, { revision: "middle", since: "earliest" });
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
    expect(getMeta(fix.reading().selection!.after).title).toBe("middle");
    expect(getMeta(fix.reading().selection!.before!).title).toBe("earliest");
    expect(fix.reading().selection?.comparedWith).toEqual(earliest);
    expect(fix.navigate).not.toHaveBeenCalled();
  });

  it.each([
    { revision: "gone" },
    { revision: "middle", since: "gone" },
    { revision: "middle", since: "middle" },
    { revision: "middle", since: "newest" },
  ])("keeps an invalid address in history with an error: %j", async address => {
    const api = client();
    const fix = mountRouted(api, address);
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ active: true, busy: false, selection: null });
    expect(fix.reading().error).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    expect(fix.navigate).not.toHaveBeenCalled();
    act(() => fix.reading().now());
    expect(fix.navigate).toHaveBeenLastCalledWith(null);
    expect(fix.reading()).toMatchObject({ active: false, selection: null, error: null });
  });

  it.each(["control", "browser"])("reads the current list when reopening history by %s after an invalid address", async navigation => {
    const api = client();
    const fix = mountRouted(api, { revision: "gone" });
    await act(async () => {});
    expect(fix.reading().error).toBeTruthy();
    act(() => fix.reading().now());

    const later: RevisionEntry = { ...entries[0]!, id: "later", title: "Later changes" };
    const currentEntries = [later, { ...entries[0]!, endedAt: 150 }, ...entries.slice(1)];
    vi.mocked(api.list).mockResolvedValue(currentEntries);
    if (navigation === "control") await act(async () => fix.reading().back());
    else {
      fix.visit({ revision: "later" });
      await act(async () => {});
    }

    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null, entries: currentEntries });
    expect(fix.reading().entry?.id).toBe("later");
    expect(getMeta(fix.reading().selection!.after).title).toBe("later");
    if (navigation === "control") expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "later" });
  });

  it.each([null, { revision: "newest" }])("recovers from an initial list failure when entering history again from %j", async address => {
    const api = client();
    vi.mocked(api.list).mockRejectedValueOnce(new DocumentHistoryError("unreachable"));
    const fix = mountRouted(api, address);
    await act(async () => {});
    expect(fix.reading().error).toMatch(/hub cannot be reached/);

    if (address === null) await act(async () => fix.reading().back());
    else {
      act(() => fix.reading().now());
      fix.visit(address);
      await act(async () => {});
    }

    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null, entries });
    expect(fix.reading().entry?.id).toBe("newest");
  });

  it("refreshes baseline naming metadata while keeping the addressed comparison ends", async () => {
    const api = client();
    const earliest = { ...entries[2]!, name: { text: "Reviewed", namer: null, namedAt: 50, canManage: false } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, earliest]);
    const fix = mountRouted(api, { revision: "middle", since: "earliest" });
    await act(async () => {});
    const selected = fix.reading().selection!;
    const renamed = { ...earliest, name: { ...earliest.name, text: "Renamed review" } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, renamed]);
    await act(async () => fix.reading().refresh());
    expect(fix.reading().selection).toMatchObject({ after: selected.after, before: selected.before, comparedWith: renamed });
    const unnamed = { ...earliest, name: null };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, unnamed]);
    await act(async () => fix.reading().refresh());
    expect(fix.reading().selection).toMatchObject({ after: selected.after, before: selected.before, comparedWith: unnamed });
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
    expect(fix.navigate).not.toHaveBeenCalled();
  });

  it("keeps a history address loading until its client becomes available", async () => {
    const fix = mountRouted(null, { revision: "middle" });
    expect(fix.reading()).toMatchObject({ available: false, active: true, busy: true, selection: null, error: null });
    fix.visit({ revision: "middle" }, client());
    await act(async () => {});
    expect(fix.reading()).toMatchObject({ available: true, active: true, busy: false, error: null });
    expect(fix.reading().entry?.id).toBe("middle");
  });

  it.each([
    { address: { revision: "newest" }, remaining: entries.slice(1) },
    { address: { revision: "middle", since: "earliest" }, remaining: entries.slice(0, 2) },
  ])("shows an error when a refresh loses an addressed endpoint: %j", async ({ address, remaining }) => {
    const api = client();
    const fix = mountRouted(api, address);
    await act(async () => {});
    expect(fix.reading().selection).not.toBeNull();
    vi.mocked(api.list).mockResolvedValue(remaining);
    await act(async () => fix.reading().refresh());
    expect(fix.reading()).toMatchObject({ active: true, busy: false, selection: null });
    expect(fix.reading().error).toBeTruthy();
    expect(fix.navigate).not.toHaveBeenCalled();
  });

  it("uses the latest address when browser navigation changes during the initial list read", async () => {
    const list = deferred<RevisionEntry[]>();
    const api = client();
    vi.mocked(api.list).mockReturnValue(list.promise);
    const fix = mountRouted(api, { revision: "newest" });
    fix.visit({ revision: "middle" });
    fix.visit({ revision: "earliest" });
    await act(async () => list.resolve(entries));
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
    expect(fix.reading().entry?.id).toBe("earliest");
    expect(fix.reading().selection?.before).toBeNull();
    expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["earliest"]);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(fix.navigate).not.toHaveBeenCalled();
  });

  it("discards a superseded snapshot read without replacing the newer address's view", async () => {
    const pending = deferred<Y.Doc>();
    const stale = document("Late middle");
    const api = client(async (_uuid, id) => id === "middle" ? pending.promise : document(id));
    const fix = mountRouted(api, { revision: "newest" });
    await act(async () => {});
    expect(fix.reading().busy).toBe(true);
    const firstReplacement = fix.seen.length;
    fix.visit({ revision: "earliest" });
    expect(fix.seen[firstReplacement]).toMatchObject({ active: true, selection: null, error: null });
    await act(async () => {});
    const chosen = fix.reading().selection;
    expect(fix.reading().entry?.id).toBe("earliest");
    await act(async () => pending.resolve(stale));
    expect(stale.isDestroyed).toBe(true);
    expect(fix.reading().selection).toBe(chosen);
    expect(fix.reading()).toMatchObject({ active: true, busy: false, error: null });
  });

  it("returns to now while a snapshot is pending and ignores its late result", async () => {
    const pending = deferred<Y.Doc>();
    const stale = document("Late newest");
    const api = client();
    vi.mocked(api.get).mockReturnValueOnce(pending.promise);
    const fix = mountRouted(api, { revision: "newest" });
    await act(async () => {});
    act(() => fix.reading().now());
    expect(fix.navigate).toHaveBeenLastCalledWith(null);
    expect(fix.reading()).toMatchObject({ active: false, busy: false, selection: null });
    await act(async () => pending.resolve(stale));
    expect(stale.isDestroyed).toBe(true);
    expect(fix.reading()).toMatchObject({ active: false, busy: false, selection: null, error: null });
    fix.visit({ revision: "newest" });
    await act(async () => {});
    expect(fix.reading().entry?.id).toBe("newest");
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
  });

  it("preserves cached snapshots and the session while moving between this document's addresses", async () => {
    const api = client();
    const fix = mountRouted(api, { revision: "middle" });
    await act(async () => {});
    const first = fix.reading().selection!;
    const signal = vi.mocked(api.list).mock.calls[0]![1];
    fix.visit({ revision: "earliest" });
    await act(async () => {});
    expect(fix.reading().selection!.after).toBe(first.before);
    fix.visit({ revision: "middle" });
    await act(async () => {});
    expect(fix.reading().selection).toMatchObject({ after: first.after, before: first.before });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["middle", "earliest"]);
    expect(signal.aborted).toBe(false);
    expect(first.after.isDestroyed).toBe(false);
    fix.view.unmount();
    expect(signal.aborted).toBe(true);
    expect(first.after.isDestroyed).toBe(true);
    expect(first.before!.isDestroyed).toBe(true);
  });

  it("writes resolved revision and comparison ends when history controls change the view", async () => {
    const api = client();
    const earliest = { ...entries[2]!, name: { text: "Reviewed", namer: null, namedAt: 50, canManage: false } };
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, earliest]);
    const fix = mountRouted(api, null);
    await act(async () => {});
    await act(async () => fix.reading().back());
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "newest" });
    await act(async () => fix.reading().open(1));
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "middle" });
    await act(async () => fix.reading().sinceNamed("earliest"));
    expect(fix.navigate).toHaveBeenLastCalledWith({ revision: "newest", since: "earliest" });
    expect(fix.reading().selection?.comparedWith).toEqual(earliest);
    expect(fix.navigate).toHaveBeenCalledTimes(3);
    act(() => fix.reading().now());
    expect(fix.navigate).toHaveBeenLastCalledWith(null);
    expect(fix.reading()).toMatchObject({ active: false, selection: null });
  });
});

describe("document history navigation", () => {
  it("restores from the state when history opened, then refreshes a stale list and starting point", async () => {
    const checksum = vi.spyOn(revisionClient, "documentRevisionChecksum").mockImplementation(async doc => getMeta(doc).title);
    try {
      const api = client();
      const live = document("State when history opened");
      const fix = mount(api, UUID, "/document/one", live);
      await act(async () => {});
      await act(async () => fix.reading().open(1));
      const displayed = fix.reading().selection?.after;
      setTitle(live, "New collaborator changes");
      const newer: RevisionEntry = { ...entries[0]!, id: "newer", title: "New collaborator changes" };
      vi.mocked(api.list).mockResolvedValue([newer, ...entries]);
      vi.mocked(api.restore).mockRejectedValueOnce(new DocumentHistoryError("stale-state"));
      await act(async () => {
        await expect(fix.reading().restore("middle")).rejects.toBeInstanceOf(DocumentHistoryError);
      });
      expect(api.restore).toHaveBeenLastCalledWith(UUID, "middle", "State when history opened", expect.any(AbortSignal));
      expect(fix.reading().entries?.[0]).toEqual(newer);
      expect(fix.reading().selection?.after).toBe(displayed);
      expect(fix.reading().entry?.id).toBe("middle");
      vi.mocked(api.restore).mockResolvedValue({ revision: newer, applied: true });
      await act(async () => { await expect(fix.reading().restore("middle")).resolves.toBe(true); });
      expect(api.restore).toHaveBeenLastCalledWith(UUID, "middle", "New collaborator changes", expect.any(AbortSignal));
      expect(fix.reading().busy).toBe(false);
      fix.view.unmount();
    } finally { checksum.mockRestore(); }
  });

  it("reopens and refreshes history with a fresh starting point and reports a restore no-op", async () => {
    const checksum = vi.spyOn(revisionClient, "documentRevisionChecksum").mockImplementation(async doc => getMeta(doc).title);
    try {
      const api = client();
      vi.mocked(api.restore).mockResolvedValue({ revision: entries[0]!, applied: false });
      const live = document("First opening");
      const fix = mount(api, UUID, "/document/one", live);
      await act(async () => {});
      await act(async () => fix.reading().back());
      await act(async () => fix.reading().now());
      setTitle(live, "Reopened history");
      await act(async () => fix.reading().back());
      await act(async () => { await expect(fix.reading().restore("newest")).resolves.toBe(false); });
      expect(api.restore).toHaveBeenLastCalledWith(UUID, "newest", "Reopened history", expect.any(AbortSignal));
      setTitle(live, "Refreshed history");
      await act(async () => fix.reading().refresh());
      await act(async () => fix.reading().restore("middle"));
      expect(api.restore).toHaveBeenLastCalledWith(UUID, "middle", "Refreshed history", expect.any(AbortSignal));
      fix.view.unmount();
    } finally { checksum.mockRestore(); }
  });

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
    vi.mocked(api.rename).mockRejectedValue(new DocumentHistoryError("forbidden"));
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
      await expect(fix.reading().rename(named.id, "Other")).rejects.toThrow(/refused access/);
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

  it.each([true, false])("loads only supplied sidebar rename information through named comparisons, with list titles: %s", async includeTitles => {
    const api = client(async (_uuid, id) => document(id === "earliest" || (!includeTitles && id === "newest") ? "Alpha" : "Beta"));
    const baseline = { ...entries[2]!, title: "Alpha", name: { text: "Kickoff", namer: null, namedAt: 50, canManage: false } };
    const listed = [{ ...entries[0]!, title: "Beta" }, { ...entries[1]!, title: "Beta" }, baseline];
    vi.mocked(api.list).mockResolvedValue(includeTitles ? listed : listed.map(({ id, author, startedAt, endedAt, name }) => ({
      id, author, startedAt, endedAt, ...(name === undefined ? {} : { name }),
    })));
    const fix = mount(api);
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalled();
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBe(includeTitles ? "Alpha" : null);
    await act(async () => fix.reading().back());
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBe(includeTitles ? "Alpha" : null);
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 0)).toBeNull();
    await act(async () => fix.reading().open(1));
    await act(async () => fix.reading().sinceNamed("earliest"));
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBe(includeTitles ? "Alpha" : null);
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 0)).toBeNull();
    expect(fix.reading().selection!.comparedWith?.id).toBe("earliest");
    expect(getMeta(fix.reading().selection!.after).title).toBe(includeTitles ? "Beta" : "Alpha");
    expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["newest", "middle", "earliest", "newest", "earliest"]);
    expect(fix.reading().error).toBeNull();
    if (!includeTitles) expect(fix.reading().titles).toEqual({});
    fix.view.unmount();
    expect(documents.every(doc => doc.isDestroyed)).toBe(true);
  });

  it.each([true, false])("reads only the selected comparison in a 200-revision history, with list titles: %s", async includeTitles => {
    const revisions = Array.from({ length: 200 }, (_, index) => ({
      id: `revision-${index}`, author: null, startedAt: index, endedAt: index,
      ...(includeTitles ? { title: index % 2 === 0 ? "Alpha" : "Beta" } : {}),
    }));
    const api = client();
    vi.mocked(api.list).mockResolvedValue(revisions);
    const fix = mount(api);
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => fix.reading().back());
    expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["revision-0", "revision-1"]);
    expect(renamedFrom(revisions, fix.reading().titles, 150)).toBe(includeTitles ? "Beta" : null);
    expect(fix.reading().error).toBeNull();
    await act(async () => fix.reading().now());
    await act(async () => fix.reading().back());
    expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["revision-0", "revision-1", "revision-0", "revision-1"]);
    if (!includeTitles) expect(fix.reading().titles).toEqual({});
    expect(fix.reading().error).toBeNull();
  });

  it("keeps history available when list titles are missing and never falls back to snapshot scans", async () => {
    const api = client(async (_uuid, id) => {
      if (id === "earliest") throw new DocumentHistoryError("unreachable");
      return document(id);
    });
    vi.mocked(api.list).mockResolvedValue([entries[0]!, entries[1]!, {
      id: "earliest", author: null, startedAt: null, endedAt: 50,
    }]);
    const fix = mount(api);
    await act(async () => {});
    await act(async () => fix.reading().back());
    const selected = fix.reading().selection;
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(renamedFrom(fix.reading().entries!, fix.reading().titles, 1)).toBeNull();
    expect(fix.reading().error).toBeNull();
    expect(selected!.after.isDestroyed).toBe(false);
    await act(async () => fix.reading().refresh());
    expect(getMeta(fix.reading().selection!.after).title).toBe("newest");
    expect(fix.reading().selection?.before).toBe(selected?.before);
    expect(selected?.after.isDestroyed).toBe(true);
    // Refresh re-reads the selected open revision, without scanning old snapshots for titles.
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(fix.reading().titles.earliest).toBeUndefined();
    expect(fix.reading().error).toBeNull();
  });

  it("keeps list titles through a metadata-only name mutation and replaces them on a fresh list", async () => {
    const api = client();
    const fix = mount(api);
    await act(async () => {});
    const named: RevisionEntry = { id: "middle", author: entries[1]!.author, startedAt: 50, endedAt: 100,
      name: { text: "Reviewed", namer: null, namedAt: 100, canManage: true } };
    vi.mocked(api.rename).mockResolvedValue(named);
    await act(async () => fix.reading().rename("middle", "Reviewed"));
    expect(fix.reading().titles.middle).toBe("middle");
    vi.mocked(api.list).mockResolvedValue([named]);
    await act(async () => fix.reading().refresh());
    expect(fix.reading().titles).toEqual({});
  });
});

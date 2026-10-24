import { expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import * as Y from "yjs";
import { createTagCatalogEntry, getTagCatalogIdentities, deleteTagCatalogEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { DocumentList, INITIAL_DOCUMENT_LIST_STATE } from "../src/shell/DocumentList.js";
import type { DocumentListState } from "../src/shell/DocumentList.js";
import { documentSearchRows, rankDocumentSearchRows } from "../src/shell/document-search-results.js";
import { act, renderSettled } from "./react-render.js";

const ONE = "00000000-0000-4000-8000-000000000001";
const TWO = "00000000-0000-4000-8000-000000000002";
const THREE = "00000000-0000-4000-8000-000000000003";
const FOUR = "00000000-0000-4000-8000-000000000004";
const RELEASE = "10000000-0000-4000-8000-000000000001";
const RELEASE_ALIAS = "10000000-0000-4000-8000-000000000002";
const CLI = "10000000-0000-4000-8000-000000000003";
const DELETED = "10000000-0000-4000-8000-000000000004";

function connection(ydoc = new Y.Doc(), synced = true): RoomConnection {
  const status = { connected: synced, synced, hasReceivedServerState: synced } as RoomStatus;
  return {
    ydoc, status,
    onStatusChange: (listener: (value: RoomStatus) => void) => { listener(status); return () => {}; },
  } as unknown as RoomConnection;
}

function catalog(): RoomConnection {
  const room = connection();
  createTagCatalogEntry(room.ydoc, "release", RELEASE);
  getTagCatalogIdentities(room.ydoc).set(RELEASE_ALIAS, "release");
  createTagCatalogEntry(room.ydoc, "cli", CLI);
  createTagCatalogEntry(room.ydoc, "old", DELETED);
  deleteTagCatalogEntry(room.ydoc, DELETED);
  return room;
}

function entry(uuid: string, title: string, extra: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return { uuid, title, tags: [], ...extra };
}

function titles(host: HTMLElement): string[] {
  return within(host).getAllByRole("rowheader").map((cell) => cell.querySelector(".ub-docs-title")?.textContent ?? "");
}

async function search(host: HTMLElement, text: string): Promise<void> {
  await act(async () => fireEvent.change(within(host).getByRole("searchbox", { name: "Search" }), { target: { value: text } }));
}

async function click(host: HTMLElement, name: string): Promise<void> {
  await act(async () => within(host).getByRole("button", { name }).click());
}

function list(props: {
  entries: DirectoryEntry[];
  searchClient?: { search: (query: string, signal: AbortSignal) => Promise<string[]> } | null;
  state?: DocumentListState;
  onStateChange?: (state: DocumentListState) => void;
  synced?: boolean;
  onSelect?: (uuid: string) => void;
}) {
  return <DocumentList connection={connection(undefined, props.synced)} catalog={catalog()} groups={[]}
    onSelect={props.onSelect ?? (() => {})} onTogglePin={() => {}} {...props} />;
}

it("uses returned ranks until a column is chosen, resets on every edit and remembers the column without text", async () => {
  const api = { search: vi.fn(async () => [TWO, ONE, THREE]) };
  const { container } = await renderSettled(list({ searchClient: api, entries: [
    entry(ONE, "Alpha", { updatedAt: 30 }), entry(TWO, "Zebra", { updatedAt: 10 }), entry(THREE, "Middle", { updatedAt: 20 }),
  ] }));
  expect(titles(container)).toEqual(["Alpha", "Middle", "Zebra"]);
  await search(container, "launch");
  expect(titles(container)).toEqual(["Zebra", "Alpha", "Middle"]);
  expect(container.querySelector("[aria-sort]")).toBeNull();
  await click(container, "Title");
  expect(titles(container)).toEqual(["Alpha", "Middle", "Zebra"]);
  expect(container.querySelector("[aria-sort]")?.getAttribute("aria-sort")).toBe("ascending");
  await search(container, "launch ");
  expect(titles(container)).toEqual(["Zebra", "Alpha", "Middle"]);
  expect(container.querySelector("[aria-sort]")).toBeNull();
  await click(container, "Title");
  await click(container, "Title");
  await search(container, "");
  expect(titles(container)).toEqual(["Zebra", "Middle", "Alpha"]);
  expect(container.querySelector("[aria-sort]")?.getAttribute("aria-sort")).toBe("descending");
});

it("ignores late success and failure for text that has changed", async () => {
  const pending = new Map<string, { resolve: (hits: string[]) => void; reject: (error: Error) => void; signal: AbortSignal }>();
  const api = { search: vi.fn((query: string, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    pending.set(query, { resolve, reject, signal });
  })) };
  const { container } = await renderSettled(list({ searchClient: api, entries: [entry(ONE, "One"), entry(TWO, "Two")] }));
  await search(container, "old");
  await search(container, "new");
  expect(pending.get("old")?.signal.aborted).toBe(true);
  expect(within(container).queryAllByRole("rowheader")).toHaveLength(0);
  expect(within(container).getByRole("status").textContent).toBe("Searching…");
  await act(async () => pending.get("new")?.resolve([TWO]));
  expect(titles(container)).toEqual(["Two"]);
  await act(async () => pending.get("old")?.resolve([ONE]));
  expect(titles(container)).toEqual(["Two"]);
  await search(container, "failing");
  await search(container, "latest");
  await act(async () => pending.get("latest")?.resolve([ONE]));
  await act(async () => pending.get("failing")?.reject(new Error("unavailable")));
  expect(titles(container)).toEqual(["One"]);
  expect(container.textContent).not.toMatch(/unavailable/i);
});

it("keeps search rows and focus during directory refreshes, then applies the latest answer", async () => {
  const pending: Array<{ resolve: (hits: string[]) => void; reject: (error: Error) => void; signal: AbortSignal }> = [];
  const api = { search: vi.fn((_query: string, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    pending.push({ resolve, reject, signal });
  })) };
  const entries = [entry(ONE, "One"), entry(TWO, "Two")];
  const { container, rerender } = await renderSettled(list({ entries, searchClient: api }));
  await search(container, "launch");
  await act(async () => pending[0]?.resolve([ONE, TWO]));
  const focused = within(container).getByRole("button", { name: "Two" });
  focused.focus();

  const updated = [...entries, entry(THREE, "Unrelated")];
  await act(async () => rerender(list({ entries: updated, searchClient: api })));
  expect(api.search).toHaveBeenCalledTimes(2);
  expect(titles(container)).toEqual(["One", "Two"]);
  expect(within(container).getByRole("button", { name: "Two" })).toBe(focused);
  expect(document.activeElement).toBe(focused);
  expect(within(container).queryByRole("status")).toBeNull();

  await act(async () => rerender(list({ entries: [...updated, entry(FOUR, "Four")], searchClient: api })));
  expect(pending[1]?.signal.aborted).toBe(true);
  await act(async () => pending[2]?.resolve([TWO, FOUR]));
  expect(titles(container)).toEqual(["Two", "Four"]);
  expect(document.activeElement).toBe(focused);
  await act(async () => pending[1]?.reject(new Error("unavailable")));
  expect(titles(container)).toEqual(["Two", "Four"]);
  expect(container.textContent).not.toMatch(/unavailable/i);

  await act(async () => rerender(list({ entries: [...updated], searchClient: api })));
  await act(async () => pending[3]?.reject(new Error("index unavailable")));
  expect(within(container).getByRole("status").textContent).toMatch(/Search is unavailable/);
  expect(container.textContent).not.toMatch(/No documents.*match/i);
});

it("invalidates the previous workspace client's answer even when the query stays the same", async () => {
  const entries = [entry(ONE, "One"), entry(TWO, "Two")];
  const state = { ...INITIAL_DOCUMENT_LIST_STATE, query: "launch", relevance: true };
  const { container, rerender } = await renderSettled(list({ entries, state, searchClient: { search: async () => [ONE] } }));
  expect(titles(container)).toEqual(["One"]);
  let answer: ((hits: string[]) => void) | undefined;
  const nextClient = { search: () => new Promise<string[]>((resolve) => { answer = resolve; }) };
  await act(async () => rerender(list({ entries, state, searchClient: nextClient })));
  expect(within(container).queryAllByRole("rowheader")).toHaveLength(0);
  expect(within(container).getByRole("status").textContent).toBe("Searching…");
  await act(async () => answer?.([TWO]));
  expect(titles(container)).toEqual(["Two"]);
});

it("keeps the 150th match when catalog aliases select its tag", async () => {
  const entries = Array.from({ length: 150 }, (_, index) => entry(
    `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`, `Document ${index}`,
    { tags: index === 149 ? [RELEASE_ALIAS] : [CLI] },
  ));
  const api = { search: vi.fn(async () => entries.map((record) => record.uuid)) };
  const { container } = await renderSettled(list({ entries, searchClient: api,
    state: { ...INITIAL_DOCUMENT_LIST_STATE, query: "sync", relevance: true, selectedTags: [RELEASE] },
  }));
  expect(titles(container)).toEqual(["Document 149"]);
});

it("ranks a decision topic by its best record, keeps one current row and maps through a later tombstone", async () => {
  const records = [
    entry(ONE, "Original", { kind: "decision", status: "decided", createdAt: 1 }),
    entry(TWO, "Current", { kind: "decision", status: "decided", topic: ONE, supersedes: ONE, createdAt: 2, answerPreview: "Current answer" }),
    entry(THREE, "Proposal", { kind: "decision", status: "open", topic: ONE, supersedes: TWO, createdAt: 3, deleted: true }),
    entry(FOUR, "Another topic", { kind: "decision", status: "open" }),
  ];
  const { container } = await renderSettled(list({ entries: records, searchClient: { search: async () => [THREE, FOUR, ONE, TWO] },
    state: { ...INITIAL_DOCUMENT_LIST_STATE, mode: "decision", query: "history", relevance: true },
  }));
  expect(titles(container)).toEqual(["Original", "Another topic"]);
  expect(container.textContent).not.toContain("Current answer");
});

it("merges documents and current decision topics in shared relevance order while excluding archives", () => {
  const archivedTopic = "00000000-0000-4000-8000-000000000005";
  const archivedSuccessor = "00000000-0000-4000-8000-000000000006";
  const rows = documentSearchRows([
    entry(ONE, "Historical answer", { kind: "decision", status: "decided", createdAt: 1 }),
    entry(TWO, "Current answer", { kind: "decision", status: "decided", topic: ONE, supersedes: ONE, createdAt: 2 }),
    entry(THREE, "Document"),
    entry(FOUR, "Archived document", { deleted: true }),
    entry(archivedTopic, "Archived topic", { kind: "decision", status: "decided", deleted: true }),
    entry(archivedSuccessor, "Archived successor", { kind: "decision", status: "decided", topic: archivedTopic, supersedes: archivedTopic }),
  ]);
  const ranked = rankDocumentSearchRows(rows, [FOUR, archivedSuccessor, ONE, THREE, TWO]);
  expect(ranked.map(({ uuid, title, kind }) => ({ uuid, title, kind }))).toEqual([
    { uuid: ONE, title: "Historical answer", kind: "decision" },
    { uuid: THREE, title: "Document", kind: undefined },
  ]);
});

it("combines type, state, query and OR tags; a chip replaces tags and clears no other filter", async () => {
  const onSelect = vi.fn();
  const records = [
    entry(ONE, "Release note", { tags: [RELEASE_ALIAS, CLI] }),
    entry(TWO, "CLI note", { tags: [CLI] }),
    entry(THREE, "Release decision", { kind: "decision", status: "open", tags: [RELEASE] }),
    entry(FOUR, "CLI decision", { kind: "decision", status: "decided", tags: [CLI] }),
  ];
  const { container } = await renderSettled(list({ entries: records, onSelect, searchClient: { search: async () => [TWO, ONE, FOUR, THREE] } }));
  await search(container, "sync");
  await click(container, "Filter by tags");
  await act(async () => {
    const picker = within(document.body).getByRole("listbox", { name: "Tags" });
    within(picker).getByRole("option", { name: "release" }).click();
  });
  expect(titles(container)).toEqual(["Release note"]);
  await act(async () => within(within(document.body).getByRole("listbox", { name: "Tags" })).getByRole("option", { name: "cli" }).click());
  expect(titles(container)).toEqual(["CLI note", "Release note"]);
  await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
  await act(async () => fireEvent.keyDown(within(container).getByRole("tab", { name: /^Decisions/ }), { key: "Enter" }));
  await act(async () => fireEvent.change(within(container).getByRole("combobox", { name: "Decision state" }), { target: { value: "not-yet-decided" } }));
  expect(titles(container)).toEqual(["Release decision"]);
  await click(container, "release");
  expect(onSelect).not.toHaveBeenCalled();
  expect(within(container).getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("sync");
  expect(within(container).getByRole<HTMLSelectElement>("combobox", { name: "Decision state" }).value).toBe("not-yet-decided");
  expect(within(container).getByRole("button", { name: "Filter by tags" }).textContent).toContain("release");
  expect(within(container).getByRole("button", { name: "Filter by tags" }).textContent).not.toContain("cli");
});

it("names all filters in a partial-sync empty answer and clears them together", async () => {
  const changed = vi.fn();
  const { container } = await renderSettled(list({ entries: [], synced: false, searchClient: { search: async () => [] },
    state: { ...INITIAL_DOCUMENT_LIST_STATE, mode: "decision", query: "sync", relevance: true,
      selectedTags: [RELEASE, CLI], stateFilter: "under-review" },
    onStateChange: (next) => changed(next),
  }));
  const text = container.textContent ?? "";
  for (const name of ["decisions", "Under review", "release", "cli", "sync", "synced so far"]) expect(text).toContain(name);
  await click(container, "Clear filters");
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ query: "", mode: "working", selectedTags: [], stateFilter: "all" }));
});

it.each([null, { search: async () => { throw new Error("index unavailable"); } }])("says search is unavailable without claiming no matches", async (searchClient) => {
  const { container } = await renderSettled(list({ entries: [entry(ONE, "One")], searchClient }));
  await search(container, "missing");
  expect(container.textContent).toMatch(/search is unavailable/i);
  expect(container.textContent).not.toMatch(/No documents.*match/i);
  await click(container, "Clear filters");
  expect(titles(container)).toEqual(["One"]);
});

it("shows named tags in stored order, omits provisional and unknown names, and offers only existing choices", async () => {
  const { container } = await renderSettled(list({ entries: [entry(ONE, "One", { tags: [CLI, RELEASE_ALIAS, DELETED, "provisional", FOUR] })] }));
  const row = within(container).getByRole("rowheader").closest("tr");
  expect(row).not.toBeNull();
  const chips = within(row as HTMLElement).getAllByRole("button").filter((button) => button.classList.contains("ub-docs-tag-chip"));
  expect(chips.map((chip) => chip.textContent)).toEqual(["cli", "release"]);
  await click(container, "Filter by tags");
  const options = within(within(document.body).getByRole("listbox", { name: "Tags" })).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["cli", "release"]);
});


it("ignores deleted and delayed tag selections restored from history without showing unknown labels", async () => {
  const { container } = await renderSettled(list({ entries: [entry(ONE, "One", { tags: [CLI, DELETED] })], state: { ...INITIAL_DOCUMENT_LIST_STATE, selectedTags: [DELETED, FOUR] } }));
  expect(titles(container)).toEqual(["One"]);
  expect(within(container).getByRole("button", { name: "Filter by tags" }).textContent).toContain("Any");
  expect(container.textContent).not.toContain("Unknown tag");
  expect(container.textContent).not.toContain("retired");
});

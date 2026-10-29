import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import * as Y from "yjs";
import { toast } from "sonner";
import { appendBlock, editBlock, initDoc, type RevisionEntry } from "@uberblick/schema";
import { act, cleanup, render } from "./react-render.js";
import { useDocumentHistory, type DocumentHistory } from "../src/ui/document/document-history.js";
import { DocumentHistoryError, type DocumentHistoryList, type DocumentRevisionsClient } from "../src/shell/document-revisions.js";
import { HistoryControls, RevisionPane } from "../src/ui/document/RevisionPane.js";

const person = { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } };
const entries: RevisionEntry[] = [
  { id: "newest", author: person, startedAt: 40, endedAt: null },
  { id: "selected", author: person, startedAt: 30, endedAt: 40 },
  { id: "adjacent", author: person, startedAt: 20, endedAt: 30 },
  { id: "baseline", author: person, startedAt: 10, endedAt: 20,
    name: { text: "Reviewed", namer: person, namedAt: 20, canManage: false } },
];
const documents: Y.Doc[] = [];
const nativeAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (nativeAnimations === undefined) Reflect.deleteProperty(Element.prototype, "getAnimations");
  else Object.defineProperty(Element.prototype, "getAnimations", nativeAnimations);
  for (const doc of documents.splice(0)) doc.destroy();
});

function snapshot(title: string): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "9f3c1a2b-0000-4000-8000-0123456789ab", title });
  appendBlock(doc, { type: "paragraph", text: title });
  documents.push(doc);
  return doc;
}

function historyAt(index: number, since = false, busy = false): DocumentHistory {
  const baseline = entries[3]!;
  return {
    entries, entry: entries[index]!, titles: {}, active: true, available: true, connected: true, history: null, localComparison: null, downloading: false, busy, error: null,
    filter: "all", setFilter: vi.fn(), comparisonView: "split", setComparisonView: vi.fn(), canBack: index < entries.length - 1, canForward: true,
    selection: { index, entry: entries[index]!, entries, before: snapshot(since ? baseline.id : entries[index + 1]!.id), after: snapshot(entries[index]!.id),
      ...(since ? { comparedWith: baseline } : {}) },
    collapseUnchanged: true, setCollapseUnchanged: vi.fn(), back: vi.fn(), forward: vi.fn(), open: vi.fn(), openSession: vi.fn(),
    sinceLastNamed: vi.fn(), sinceNamed: vi.fn(), name: vi.fn(async () => {}), rename: vi.fn(async () => {}),
    removeName: vi.fn(async () => {}), restore: vi.fn(async () => true), compareLocal: vi.fn(), now: vi.fn(), retry: vi.fn(), refresh: vi.fn(),
  };
}

function description(button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-describedby");
  const element = id === null ? null : document.getElementById(id);
  if (element === null) throw new Error("Restore has no accessible description");
  return element;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function HistoryDocument({ api, live }: { api: DocumentRevisionsClient; live: Y.Doc }) {
  const history = useDocumentHistory(api, "9f3c1a2b-0000-4000-8000-0123456789ab", "/document/one", live);
  return history.active ? <RevisionPane history={history} docLinks={null} workspaceSettings={null} />
    : <HistoryControls history={history} liveDocument={live} />;
}

describe("entering history through the live control", () => {
  it.each([
    { opening: "succeeds", later: "succeeds" },
    { opening: "fails", later: "succeeds" },
    { opening: "succeeds", later: "fails" },
  ])("opens the pane while the opening list $opening, then the later list $later", async ({ opening, later }) => {
    const pending = deferred<DocumentHistoryList>();
    const refreshed = deferred<DocumentHistoryList>();
    const listed = (revisions: RevisionEntry[]): DocumentHistoryList => ({ revisions, history: {
      complete: true, lastRefresh: null, refreshFailed: false, offline: false, newestDownloadedRevision: revisions[0]?.id ?? null,
    } });
    const api: DocumentRevisionsClient = {
      list: vi.fn<DocumentRevisionsClient["list"]>().mockReturnValueOnce(pending.promise).mockReturnValueOnce(refreshed.promise),
      get: vi.fn<DocumentRevisionsClient["get"]>(async (_uuid, id) => snapshot(id)),
      name: vi.fn(), rename: vi.fn(), removeName: vi.fn(), restore: vi.fn(),
    };
    const live = snapshot("Unsynced live page");
    const liveState = Y.encodeStateAsUpdate(live);
    const view = render(<HistoryDocument api={api} live={live} />);
    expect(view.container.querySelector(".ub-revision-pane")).toBeNull();
    const previous = screen.getByRole<HTMLButtonElement>("button", { name: "Previous revision" });
    expect(previous.disabled).toBe(false);
    fireEvent.click(previous);
    expect(view.container.querySelector(".ub-revision-pane")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading history…");
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();

    await act(async () => {
      if (opening === "succeeds") pending.resolve(listed(entries.slice(2)));
      else pending.reject(new DocumentHistoryError("unreachable"));
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Loading history…");

    await act(async () => {
      if (later === "succeeds") refreshed.resolve(listed(entries.slice(0, 2)));
      else refreshed.reject(new DocumentHistoryError("unreachable"));
    });
    expect(view.container.querySelector(".ub-revision-pane")).not.toBeNull();
    if (later === "succeeds") {
      expect(screen.getByRole("heading", { name: "newest" })).toBeTruthy();
      expect(vi.mocked(api.get).mock.calls.map(call => call[1])).toEqual(["newest", "selected"]);
      expect(view.container.querySelector(".ProseMirror")?.textContent).toContain("selected");
      expect(view.container.querySelector(".ProseMirror")?.textContent).toContain("newest");
    } else {
      expect(screen.getByRole("status").textContent).toContain("History is unavailable");
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Try again" }).disabled).toBe(false);
      expect(api.get).not.toHaveBeenCalled();
    }
    expect(Y.encodeStateAsUpdate(live)).toEqual(liveState);
    expect(live.isDestroyed).toBe(false);
  });
});

describe("revision attribution", () => {
  it("keeps comparison attribution and content fixed when the live catalog changes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1, true);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const header = view.container.querySelector(".ub-history-who")!.textContent;
    const sides = Array.from(view.container.querySelectorAll(".ub-revision-side")).map(side => side.textContent);
    const editors = Array.from(view.container.querySelectorAll(".ProseMirror"));
    const changed = { ...entries[1]!, author: { ...person, githubUsername: "later-author" }, title: "Later title" };
    const published = [{ ...entries[0]!, id: "later" }, entries[0]!, changed, entries[2]!, { ...entries[3]!, author: changed.author }];
    view.rerender(<RevisionPane history={{ ...history, entries: published, selection: { ...history.selection!, index: 2 } }} docLinks={null} workspaceSettings={null} writable />);
    expect(view.container.querySelector(".ub-history-who")!.textContent).toBe(header);
    expect(Array.from(view.container.querySelectorAll(".ub-revision-side")).map(side => side.textContent)).toEqual(sides);
    const preserved = view.container.querySelectorAll(".ProseMirror");
    expect(preserved[0]).toBe(editors[0]);
    expect(preserved[1]).toBe(editors[1]);
    expect(screen.getByText("2 of 4 ·")).toBeTruthy();
    expect(screen.queryByText(/later-author/)).toBeNull();
  });

  it.each([
    [{ kind: "browser", name: "Browser" }, "written by hand 👏", "in the browser"],
    [{ kind: "mcp", name: "Claude Desktop" }, "via Claude", "via Claude"],
    [{ kind: "CODEX", name: "Other client" }, "via Codex", "via Codex"],
    [{ kind: "mcp", name: "Review client" }, "via Review client", "via Review client"],
  ])("uses the same attribution in the visible, tooltip and screen-reader header for %j", (surface, authorLabel, namerLabel) => {
    const history = historyAt(1);
    history.entry = { ...history.entry!, author: { ...person, surface }, name: {
      text: "Accepted", namer: { githubUsername: "alice", surface }, namedAt: 40, canManage: false,
    } };
    history.entries = [entries[0]!, history.entry, entries[2]!, entries[3]!];
    history.selection = { ...history.selection!, entry: history.entry, entries: history.entries };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    const header = view.container.querySelector(".ub-history-who")!;
    expect(header.querySelector(".ub-history-author")?.textContent).toBe(`ben ${authorLabel}`);
    const label = header.getAttribute("title");
    expect(label).toContain(`ben ${authorLabel}, `);
    expect(label).toContain(`“Accepted”, named by alice ${namerLabel} at `);
    expect(header.querySelector(".sr-only")?.textContent).toBe(label);
  });

  it.each(["all", "named"] as const)("attributes every intervening account and surface in a non-adjacent %s comparison", filter => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const start = Date.UTC(2026, 9, 28, 9);
    vi.spyOn(Date, "now").mockReturnValue(start + 30 * 60_000);
    const named = entries[3]!.name!;
    const revisions: RevisionEntry[] = [
      { id: "outside", author: { ...person, githubUsername: "zoe" }, startedAt: start + 12 * 60_000, endedAt: null },
      { id: "selected", author: person, startedAt: start + 8 * 60_000, endedAt: start + 10 * 60_000, name: { ...named, text: "Release" } },
      { id: "agent", author: { githubUsername: "uberblick-agent", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: start + 6 * 60_000, endedAt: start + 8 * 60_000 },
      { id: "same-account-another-surface", author: { ...person, surface: { kind: "mcp", name: "Codex" } }, startedAt: start + 4 * 60_000, endedAt: start + 6 * 60_000 },
      { id: "same-author-again", author: person, startedAt: start + 2 * 60_000, endedAt: start + 4 * 60_000 },
      { id: "baseline", author: { ...person, githubUsername: "lena" }, startedAt: start, endedAt: start + 2 * 60_000, name: named },
    ];
    const history = historyAt(1, true);
    history.entries = revisions;
    history.entry = revisions[1]!;
    history.filter = filter;
    history.selection = { ...history.selection!, entry: history.entry, entries: revisions, comparedWith: revisions[5]! };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const header = view.container.querySelector(".ub-history-who")!;
    const authors = "ben written by hand 👏, uberblick-agent via Claude, ben via Codex";
    expect(header.querySelector(".ub-history-author")?.textContent).toBe(authors);
    const label = header.getAttribute("title")!;
    const exact = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    expect(label).toContain(exact.formatRange(start + 2 * 60_000, start + 10 * 60_000));
    expect(label).not.toContain(exact.formatRange(start, start + 10 * 60_000));
    expect(label).not.toContain("zoe");
    expect(label).toContain("“Release”, named by ben in the browser");
    expect(header.querySelector(".sr-only")?.textContent).toBe(label);
    const after = view.container.querySelectorAll(".ub-revision-side-label")[1]!;
    expect(after.textContent).toContain(`After · ${authors}`);
    expect(after.textContent).toContain("“Release”");
    const span = header.querySelector(".ub-history-when span")!;
    expect(span.textContent).not.toBe("");
    expect(after.textContent).toContain(span.textContent);
    expect(screen.getByText("Before · lena · “Reviewed”")).not.toBeNull();
  });
});

describe("cached history states", () => {
  it("identifies an offline downloaded comparison and hides its name management control", () => {
    const history = historyAt(0);
    const entry = { ...entries[0]!, name: { ...entries[3]!.name!, canManage: true } };
    history.entry = entry;
    history.selection = { ...history.selection!, entry, entries: [entry, ...entries.slice(1)] };
    history.connected = false;
    history.history = { complete: true, lastRefresh: null, refreshFailed: false, offline: true, newestDownloadedRevision: entry.id };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByRole("status").textContent).toBe("Offline. Showing downloaded history.");
    expect(screen.getByText(/· newest downloaded state/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename revision" })).toBeNull();
    view.rerender(<RevisionPane history={{ ...history, connected: true, history: { ...history.history, offline: false } }} docLinks={null} workspaceSettings={null} writable archived />);
    expect(screen.queryByRole("button", { name: "Rename revision" })).toBeNull();
  });

  it("distinguishes an incomplete empty catalog, a failed refresh and never-downloaded offline history", () => {
    const history = { ...historyAt(0), entry: null, selection: null, entries: [], history: {
      complete: false, lastRefresh: null, refreshFailed: false, offline: false, newestDownloadedRevision: null,
    } };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    expect(screen.getByRole("status").textContent).toBe("History is still downloading…");
    expect(screen.queryByText("No revisions yet")).toBeNull();
    view.rerender(<RevisionPane history={{ ...history, history: { ...history.history, refreshFailed: true } }} docLinks={null} workspaceSettings={null} />);
    expect(screen.getByRole("status").textContent).toContain("Last history refresh failed.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(history.refresh).toHaveBeenCalledOnce();
    view.rerender(<RevisionPane history={{ ...history, error: "Connect once to download history.", history: { ...history.history, offline: true } }} docLinks={null} workspaceSettings={null} />);
    expect(screen.getByText("Connect once to download history.")).toBeTruthy();
    expect(screen.getByText("Offline. History is not fully downloaded.")).toBeTruthy();
  });
});

describe("local comparison controls", () => {
  it("offers a local comparison for the downloaded displayed revision", () => {
    const history = historyAt(1);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    fireEvent.click(screen.getByRole("button", { name: "Compare with local version" }));
    expect(history.compareLocal).toHaveBeenCalledWith(entries[1]!.id);
  });

  it.each(["split", "inline"] as const)("keeps local inputs and labels in %s without revision metadata, naming or restore", comparisonView => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1);
    history.comparisonView = comparisonView;
    history.localComparison = { revision: entries[1]!.id, waiting: null, offline: true, newer: false };
    history.selection = { ...history.selection!, kind: "local", before: snapshot("Downloaded title"), after: snapshot("Local title") };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByText("Downloaded hub revision")).toBeTruthy();
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Local title");
    expect(screen.getByRole("status").textContent).toBe("Offline. Comparing against the last downloaded hub state.");
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy revision/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Name|Rename|Previous revision|Next revision/ })).toBeNull();
    expect(screen.queryByText(/ben/)).toBeNull();
    expect(screen.queryByText(/rev selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Previous change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next change" })).toBeTruthy();
    const editors = Array.from(view.container.querySelectorAll(".ProseMirror"));
    expect(editors.map(editor => editor.textContent).join(" ")).toContain("Local title");
    view.rerender(<RevisionPane history={{ ...history, localComparison: { ...history.localComparison, newer: true } }} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByRole("status").textContent).toContain("Newer content is available. Refresh to compare it.");
    const preserved = view.container.querySelectorAll(".ProseMirror");
    expect(preserved.length).toBe(editors.length);
    expect(editors.every((editor, index) => editor === preserved[index])).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(history.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Back to now" }));
    expect(history.now).toHaveBeenCalledOnce();
  });

  it.each([
    ["sync", "Waiting for this page's pending edits to reach the hub…"],
    ["history", "Refreshing this page's history…"],
  ] as const)("states the %s wait before showing comparison content", (waiting, message) => {
    const history = { ...historyAt(1), selection: null, entry: null, busy: true,
      localComparison: { revision: entries[1]!.id, waiting, offline: false, newer: false } };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByRole("status").textContent).toBe(message);
    expect(view.container.querySelector(".ProseMirror")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to now" }));
    expect(history.now).toHaveBeenCalledOnce();
  });
});

describe("revision restore control states", () => {
  it("disables the current After revision without a visible reason line outside since comparisons", async () => {
    const history = historyAt(0);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version", description: "This is the current version." });
    expect(button.disabled).toBe(true);
    expect(description(button).classList.contains("sr-only")).toBe(true);
    expect(button.closest("header")).not.toBeNull();
    expect(screen.getByText(/· current version/)).not.toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it.each([
    { archived: true, writable: false, reason: "This document is archived. Restore the document first, then restore a revision." },
    { archived: false, writable: false, reason: "Read-only access. Write access is required to restore a revision." },
  ].flatMap(state => [false, true].map(since => ({ ...state, since }))))("keeps the visible header reason ahead of current and busy states, since $since: $reason", async ({ archived, writable, reason, since }) => {
    const history = historyAt(0, since, true);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable={writable} archived={archived} />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: since ? "Restore “Reviewed”" : "Restore this version", description: reason });
    const explanation = description(button);
    expect(button.disabled).toBe(true);
    expect(explanation.classList.contains("sr-only")).toBe(false);
    expect(explanation.closest("header")).not.toBeNull();
    expect(screen.queryByText("This is the current version.")).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses restore while history loads and describes the wait without another visible line, since %s", async since => {
    const history = historyAt(1, since, true);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: since ? "Restore “Reviewed”" : "Restore this version", description: "Wait for history to load." });
    expect(button.disabled).toBe(true);
    expect(description(button).classList.contains("sr-only")).toBe(true);
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it("restores the selected After ID rather than its adjacent Before revision outside since comparisons", async () => {
    const history = historyAt(1);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version" });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(view.container.querySelector('.ProseMirror[aria-label="Document revision"]')).not.toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it.each([0, 1])("restores the named Before revision from the narrow header, After index %s", async index => {
    const history = historyAt(index, true);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore “Reviewed”" });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(button.closest("header")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("baseline");
  });

  it.each([700, 1200])("restores After when the baseline loses its name at width %s", async width => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 900));
    const history = historyAt(1, true);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByRole("button", { name: "Restore “Reviewed”" })).not.toBeNull();
    const unnamed = { ...entries[3]!, name: null };
    const updated = { ...history, selection: { ...history.selection!, comparedWith: unnamed } };
    view.rerender(<RevisionPane history={updated} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version" });
    expect(button.disabled).toBe(false);
    expect(button.closest(width < 900 ? "header" : ".ub-revision-side-label")?.textContent).toContain(width < 900 ? "selected" : "After ·");
    await act(async () => fireEvent.click(button));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it("disables restoring the current After in an unnamed comparison", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(0, true);
    history.selection = { ...history.selection!, comparedWith: { ...entries[3]!, name: null } };
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version", description: "This is the current version." });
    expect(button.disabled).toBe(true);
    expect(button.closest(".ub-revision-side-label")?.textContent).toContain("After ·");
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it.each([
    { applied: true, error: null, message: "Document restored to this version" },
    { applied: false, error: null, message: "The document already has this version. Nothing changed." },
    { applied: false, error: "The document changed. Review the newer changes and try again.", message: "The document changed. Review the newer changes and try again." },
  ])("keeps the restore result message for a named Before: $message", async ({ applied, error, message }) => {
    const history = historyAt(0, true);
    history.restore = vi.fn(async () => { if (error !== null) throw new Error(error); return applied; });
    const notice = vi.spyOn(toast, error === null ? "success" : "error");
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore “Reviewed”" })));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("baseline");
    expect(notice).toHaveBeenCalledWith(message);
  });
});

describe("revision comparison controls", () => {
  it.each([
    { width: 1200, preference: "inline" as const },
    { width: 700, preference: "split" as const },
  ])("composes inline word marks, folding and change navigation at $width with $preference selected", async ({ width, preference }) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 900));
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    const history = historyAt(1);
    const before = snapshot("Reading");
    const changed = appendBlock(before, { type: "paragraph", text: "Keep old words." });
    for (let index = 0; index < 12; index += 1) appendBlock(before, { type: "paragraph", text: `Unchanged ${index}` });
    const last = appendBlock(before, { type: "paragraph", text: "Earlier ending" });
    const after = new Y.Doc();
    documents.push(after);
    Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
    editBlock(after, changed, "Keep old words.", "Keep new words.");
    editBlock(after, last, "Earlier ending", "Later ending");
    history.selection = { index: 1, entry: entries[1]!, entries, before, after };
    history.comparisonView = preference;
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(view.container.querySelector(".ub-revision-split")).toBeNull();
    const editor = view.container.querySelector('.ProseMirror[aria-label="Document revision"]')!;
    expect(editor).not.toBeNull();
    expect(editor.getAttribute("role")).toBe("textbox");
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    expect(editor.getAttribute("aria-multiline")).toBe("true");
    expect(editor.getAttribute("inputmode")).toBe("none");
    expect(editor.querySelector('[data-revision-change="removed"]')?.textContent).toBe("old");
    expect(editor.querySelector('[data-revision-change="added"]')?.textContent).toBe("new");
    const paragraph = editor.querySelector("p[data-revision-block]");
    expect(editor.querySelectorAll(".ub-revision-fold-button").length).toBeGreaterThan(0);
    expect(editor.querySelectorAll(".ub-revision-row-start").length).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: "Changes" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Restore this version" }).closest("header")).not.toBeNull();
    view.rerender(<RevisionPane history={{ ...history, collapseUnchanged: false }} docLinks={null} workspaceSettings={null} writable />);
    expect(editor.querySelectorAll(".ub-revision-fold-button").length).toBe(0);
    expect(editor.querySelector("p[data-revision-block]")).toBe(paragraph);
    expect(editor.textContent).toContain("Unchanged 6");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next change" })));
    expect(history.setComparisonView).not.toHaveBeenCalled();
  });

  it("uses split when it fits, changes to Inline on request and leaves the earliest revision without comparison controls", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    expect(view.container.querySelectorAll(".ub-revision-split .ProseMirror").length).toBe(2);
    view.rerender(<RevisionPane history={{ ...history, comparisonView: "inline" }} docLinks={null} workspaceSettings={null} />);
    expect(view.container.querySelector(".ub-revision-split")).toBeNull();
    expect(view.container.querySelectorAll(".ProseMirror").length).toBe(1);
    expect(screen.getByRole("group", { name: "Changes" })).not.toBeNull();
    view.rerender(<RevisionPane history={{ ...history, comparisonView: "inline", selection: { ...history.selection!, before: null } }} docLinks={null} workspaceSettings={null} />);
    expect(view.container.querySelectorAll(".ProseMirror").length).toBe(1);
    const earliest = screen.getByRole("textbox", { name: "Document revision" });
    expect(earliest.getAttribute("aria-readonly")).toBe("true");
    expect(earliest.getAttribute("aria-multiline")).toBe("true");
    expect(earliest.getAttribute("inputmode")).toBe("none");
    expect(screen.queryByRole("group", { name: "Changes" })).toBeNull();
  });

  it("identifies the named endpoints and their authors, keeps the all-revision position and restores Before", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1, true);
    const selected = { ...entries[1]!, name: { text: "Release", namer: person, namedAt: 40, canManage: false } };
    const baseline = { ...entries[3]!, author: { ...person, githubUsername: "lena" } };
    history.entries = [entries[0]!, selected, entries[2]!, baseline];
    history.entry = selected;
    history.filter = "named";
    history.selection = { ...history.selection!, entry: selected, entries: history.entries, comparedWith: baseline };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByText("Before · lena · “Reviewed”")).not.toBeNull();
    expect(view.container.querySelectorAll(".ub-revision-side-label")[1]?.textContent).toContain("After · ben written by hand 👏");
    expect(view.container.querySelectorAll(".ub-revision-side-label")[1]?.textContent).toContain("“Release”");
    expect(screen.getByText("· compared with “Reviewed” · lena")).not.toBeNull();
    expect(screen.getByText("2 of 4 ·")).not.toBeNull();
    const restore = screen.getByRole("button", { name: "Restore “Reviewed”" });
    expect(restore.closest(".ub-revision-side-label")?.textContent).toContain("Before · lena");
    expect(view.container.querySelector(".ub-revision-side-after")?.textContent).toContain("selected");
    await act(async () => fireEvent.click(restore));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("baseline");
  });

  it("labels an authorless earliest baseline as Earlier content despite intervening revisions", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1, true);
    const baseline = { ...entries[3]!, author: null, name: null, startedAt: null, endedAt: null };
    const selected = { ...entries[1]!, name: { text: "Kickoff", namer: person, namedAt: 40, canManage: false } };
    history.entries = [entries[0]!, selected, entries[2]!, baseline];
    history.entry = selected;
    history.selection = { ...history.selection!, entry: selected, entries: history.entries, comparedWith: baseline };
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByText("Before · Earlier content")).not.toBeNull();
    expect(screen.getByText("· compared with Earlier content")).not.toBeNull();
    expect(screen.queryByText(/Unknown author/)).toBeNull();
  });

  it("delegates both directions to filter-aware navigation without selecting adjacent indices", async () => {
    const history = historyAt(1, true);
    history.filter = "named";
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Previous revision" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next revision" })));
    expect(history.back).toHaveBeenCalledExactlyOnceWith();
    expect(history.forward).toHaveBeenCalledExactlyOnceWith();
    expect(history.open).not.toHaveBeenCalled();
  });

  it("focuses the revision identifier when both named directions are disabled and keeps Back to now available", async () => {
    const history = historyAt(1, true);
    history.filter = "named";
    history.canBack = false;
    history.canForward = false;
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Previous revision" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next revision" }).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Copy revision ${history.entry!.id}` }));
    const now = screen.getByRole<HTMLButtonElement>("button", { name: "Back to now" });
    expect(now.disabled).toBe(false);
    await act(async () => fireEvent.click(now));
    expect(history.now).toHaveBeenCalledOnce();
  });
});

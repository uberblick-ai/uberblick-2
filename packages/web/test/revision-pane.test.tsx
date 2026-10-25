import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import * as Y from "yjs";
import { toast } from "sonner";
import { appendBlock, initDoc, type RevisionEntry } from "@uberblick/schema";
import { act, cleanup, render } from "./react-render.js";
import type { DocumentHistory } from "../src/ui/document/document-history.js";
import { RevisionPane } from "../src/ui/document/RevisionPane.js";

const person = { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } };
const entries: RevisionEntry[] = [
  { id: "newest", author: person, startedAt: 40, endedAt: null },
  { id: "selected", author: person, startedAt: 30, endedAt: 40 },
  { id: "adjacent", author: person, startedAt: 20, endedAt: 30 },
  { id: "baseline", author: person, startedAt: 10, endedAt: 20,
    name: { text: "Reviewed", namer: person, namedAt: 20, canManage: false } },
];
const documents: Y.Doc[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    entries, entry: entries[index]!, titles: {}, active: true, available: true, busy, error: null,
    filter: "all", setFilter: vi.fn(), canBack: index < entries.length - 1, canForward: true,
    selection: { index, before: snapshot(since ? baseline.id : entries[index + 1]!.id), after: snapshot(entries[index]!.id),
      ...(since ? { comparedWith: baseline } : {}) },
    collapseUnchanged: true, setCollapseUnchanged: vi.fn(), back: vi.fn(), forward: vi.fn(), open: vi.fn(),
    sinceLastNamed: vi.fn(), sinceNamed: vi.fn(), name: vi.fn(async () => {}), rename: vi.fn(async () => {}),
    removeName: vi.fn(async () => {}), restore: vi.fn(async () => true), now: vi.fn(), retry: vi.fn(), refresh: vi.fn(),
  };
}

function description(button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-describedby");
  const element = id === null ? null : document.getElementById(id);
  if (element === null) throw new Error("Restore has no accessible description");
  return element;
}

describe("revision attribution", () => {
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
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} />);
    const header = view.container.querySelector(".ub-history-who")!;
    expect(header.querySelector(".ub-history-author")?.textContent).toBe(`ben ${authorLabel}`);
    const label = header.getAttribute("title");
    expect(label).toContain(`ben ${authorLabel}, `);
    expect(label).toContain(`“Accepted”, named by alice ${namerLabel} at `);
    expect(header.querySelector(".sr-only")?.textContent).toBe(label);
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

  it("keeps restoring Before when its name disappears, including an unnamed since address", async () => {
    const history = historyAt(0, true);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByRole("button", { name: "Restore “Reviewed”" })).not.toBeNull();
    const unnamed = { ...entries[3]!, name: null };
    const updated = { ...history, selection: { ...history.selection!, comparedWith: unnamed } };
    view.rerender(<RevisionPane history={updated} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version" });
    expect(button.disabled).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("baseline");
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
  it("identifies the named endpoints and their authors, keeps the all-revision position and restores Before", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 900));
    const history = historyAt(1, true);
    const selected = { ...entries[1]!, name: { text: "Release", namer: person, namedAt: 40, canManage: false } };
    const baseline = { ...entries[3]!, author: { ...person, githubUsername: "lena" } };
    history.entries = [entries[0]!, selected, entries[2]!, baseline];
    history.entry = selected;
    history.filter = "named";
    history.selection = { ...history.selection!, comparedWith: baseline };
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    expect(screen.getByText("Before · lena · “Reviewed”")).not.toBeNull();
    expect(screen.getByText("After · ben · “Release”")).not.toBeNull();
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
    history.selection = { ...history.selection!, comparedWith: baseline };
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

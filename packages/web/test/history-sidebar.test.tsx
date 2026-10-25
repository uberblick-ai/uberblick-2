/**
 * The history pane: newest first, grouped by day, attribution that says what
 * is known, and named revisions that read as names rather than authors.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import * as Y from "yjs";
import type { RevisionEntry } from "@uberblick/schema";
import { cleanup, render } from "./react-render.js";
import type { DocumentHistory } from "../src/ui/document/document-history.js";
import { revisionAuthor, revisionGroups } from "../src/ui/document/revision-list.js";
import { HistorySidebar } from "../src/ui/sidebar/HistorySidebar.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOW = new Date(2026, 9, 23, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;
const browser = { githubUsername: "ben", surface: { kind: "browser" as const, name: "Browser" } };
const agent = { githubUsername: "ben", surface: { kind: "mcp" as const, name: "Claude Code" } };
const named = (text: string) => ({ text, namer: browser, namedAt: NOW - 2 * HOUR, canManage: true });
const entries: RevisionEntry[] = [
  { id: "head", author: agent, startedAt: NOW - HOUR, endedAt: null },
  { id: "reviewed", author: browser, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR, name: named("Reviewed after the auth rewrite") },
  { id: "yesterday", author: browser, startedAt: NOW - 25 * HOUR, endedAt: NOW - 24 * HOUR },
  { id: "week", author: null, startedAt: NOW - 80 * HOUR, endedAt: NOW - 72 * HOUR },
  { id: "august", author: browser, startedAt: new Date(2026, 7, 3).getTime(), endedAt: new Date(2026, 7, 4).getTime() },
  { id: "first", author: null, startedAt: null, endedAt: null },
];

function fakeHistory(overrides: Partial<DocumentHistory> = {}): DocumentHistory {
  return {
    filter: "all", setFilter: vi.fn(),
    entries, selection: null, busy: false, error: null, titles: {}, collapseUnchanged: true, setCollapseUnchanged: vi.fn(), available: true, active: true, entry: null,
    back: vi.fn(), forward: vi.fn(), open: vi.fn(), sinceLastNamed: vi.fn(), sinceNamed: vi.fn(),
    name: vi.fn(), rename: vi.fn(), removeName: vi.fn(), now: vi.fn(), retry: vi.fn(), refresh: vi.fn(),
    ...overrides,
  } as unknown as DocumentHistory;
}

describe("revision list model", () => {
  it("groups newest first by day, week and month, with an explicit bucket for unknown dates", () => {
    const groups = revisionGroups(entries, NOW);
    expect(groups.map(group => [group.label, group.items.map(item => item.entry.id)])).toEqual([
      ["Today", ["head", "reviewed"]],
      ["Yesterday", ["yesterday"]],
      ["Earlier this week", ["week"]],
      [new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(entries[4]!.endedAt!), ["august"]],
      ["Unknown date", ["first"]],
    ]);
  });

  it("keeps each named entry's original index when only named revisions show", () => {
    expect(revisionGroups(entries, NOW, true)).toEqual([{ label: "Today", items: [{ entry: entries[1], index: 1 }] }]);
  });

  it("says who and where when known, and never invents an author", () => {
    expect(revisionAuthor(entries[0]!, false)).toEqual({ name: "ben", surface: "via Claude", agent: true, initial: "B" });
    expect(revisionAuthor(entries[1]!, false)).toEqual({ name: "ben", surface: "written by hand 👏", agent: false, initial: "B" });
    expect(revisionAuthor(entries[3]!, false)).toMatchObject({ name: "Unknown author", initial: "?" });
    expect(revisionAuthor(entries[5]!, true)).toMatchObject({ name: "Earlier content", surface: "" });
  });

  it.each([
    [{ kind: "mcp", name: "claude-code" }, "via Claude"],
    [{ kind: "mcp", name: "Claude Desktop" }, "via Claude"],
    [{ kind: "mcp", name: "My CLAUDE client" }, "via Claude"],
    [{ kind: "CLAUDE", name: "Other client" }, "via Claude"],
    [{ kind: "mcp", name: "OpenAI CoDeX" }, "via Codex"],
    [{ kind: "codex-cli", name: "Other client" }, "via Codex"],
    [{ kind: "mcp", name: "Cursor" }, "via Cursor"],
    [{ kind: "cli", name: "ub data" }, "via ub data"],
    [{ kind: "unknown", name: "" }, "via unknown"],
  ])("names the agent surface %j as %s", (surface, label) => {
    const entry = { ...entries[0]!, author: { ...agent, surface } };
    expect(revisionAuthor(entry, false)).toEqual({ name: "ben", surface: label, agent: true, initial: "B" });
  });
});

describe("history sidebar", () => {
  it("lists every revision, marks the open head and the selected entry, and opens what is clicked", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const history = fakeHistory({ selection: { index: 2, after: new Y.Doc(), before: null } as DocumentHistory["selection"] });
    render(<HistorySidebar history={history} title="Auth plan" />);
    expect(screen.getByText("Auth plan · 6 revisions")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(within(rows[0]!).getByRole("button", { name: /via Claude/ }).querySelector(".ub-history-avatar-agent")).not.toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: /written by hand 👏/ }).querySelector(".ub-history-avatar-agent")).toBeNull();
    expect(rows[0]!.textContent).toContain("Current version");
    expect(rows[1]!.textContent).not.toContain("Current version");
    const selected = within(rows[2]!).getAllByRole("button")[0]!;
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByRole("button").filter(button => button.getAttribute("aria-current") === "true")).toHaveLength(1);
    fireEvent.click(within(rows[4]!).getAllByRole("button")[0]!);
    expect(history.open).toHaveBeenCalledWith(4);
  });

  it("leads a named entry with its full name and offers a comparison since it", () => {
    const history = fakeHistory();
    render(<HistorySidebar history={history} title="Auth plan" />);
    const name = document.querySelector(".ub-history-name");
    expect(name?.getAttribute("title")).toBe("Reviewed after the auth rewrite");
    fireEvent.click(screen.getByRole("button", { name: "Changes since this name" }));
    expect(history.sinceNamed).toHaveBeenCalledWith("reviewed");
  });

  it("marks Changes since this name only when the comparison ends at the newest revision", () => {
    const selection = { index: 0, after: new Y.Doc(), before: null, comparedWith: entries[1]! };
    const view = render(<HistorySidebar history={fakeHistory({ selection })} title="Auth plan" />);
    expect(screen.getByRole("button", { name: "Changes since this name" }).getAttribute("aria-current")).toBe("true");

    const olderBaseline = { ...entries[2]!, name: named("Earlier review") };
    view.rerender(<HistorySidebar history={fakeHistory({
      entries: [entries[0]!, entries[1]!, olderBaseline],
      selection: { ...selection, index: 1, comparedWith: olderBaseline },
    })} title="Auth plan" />);
    for (const button of screen.getAllByRole("button", { name: "Changes since this name" })) {
      expect(button.hasAttribute("aria-current")).toBe(false);
    }
  });

  it("marks the named After entry as current while showing its comparison", () => {
    const history = fakeHistory({ filter: "named", selection: { index: 1, after: new Y.Doc(), before: new Y.Doc(), comparedWith: entries[5]! } });
    render(<HistorySidebar history={history} title="Auth plan" />);
    const row = screen.getByRole("listitem");
    const button = within(row).getByRole("button", { name: /Reviewed after the auth rewrite/ });
    expect(button.getAttribute("aria-current")).toBe("true");
    fireEvent.click(button);
    expect(history.open).toHaveBeenCalledWith(1);
  });

  it.each([null, NOW - 30 * 60_000])("keeps the current caption, time and rename marker together when the head ends at %s", (endedAt) => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const head = { ...entries[0]!, endedAt, name: named("Current draft") };
    const history = fakeHistory({ entries: [head, entries[1]!], titles: { head: "New title", reviewed: "Old title" } });
    const view = render(<HistorySidebar history={history} title="New title" />);
    const rows = screen.getAllByRole("listitem");
    const caption = rows[0]!.querySelector(".ub-history-renamed-tag")!.parentElement!;
    expect(caption.textContent).toBe(endedAt === null ? "Current version · renamed" : "Current version · 30 minutes ago · renamed");
    expect(caption.querySelector("time")?.getAttribute("dateTime") ?? null).toBe(endedAt === null ? null : new Date(endedAt).toISOString());
    expect(rows[1]!.querySelector("time")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Named" }));
    expect(history.setFilter).toHaveBeenCalledWith("named");
    view.rerender(<HistorySidebar history={{ ...history, filter: "named" }} title="New title" />);
    expect(screen.getAllByText(/Current version/)).toHaveLength(1);
    expect(screen.queryByText("in progress")).toBeNull();
  });

  it("filters to named revisions and says so when there are none", () => {
    const history = fakeHistory();
    const { unmount, rerender } = render(<HistorySidebar history={history} title="Auth plan" />);
    fireEvent.click(screen.getByRole("button", { name: "Named" }));
    expect(history.setFilter).toHaveBeenCalledWith("named");
    rerender(<HistorySidebar history={{ ...history, filter: "named" }} title="Auth plan" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/Current version/)).toBeNull();
    expect(screen.getByRole("button", { name: "Named" }).getAttribute("aria-pressed")).toBe("true");
    unmount();
    render(<HistorySidebar history={fakeHistory({ filter: "named", entries: entries.filter(entry => entry.name == null) })} title="Auth plan" />);
    expect(screen.getByText("No named revisions yet")).toBeTruthy();
  });

  it("states loading, empty and unavailable history, with a retry and a way back", () => {
    const history = fakeHistory({ entries: null, busy: true });
    const view = render(<HistorySidebar history={history} title="" />);
    expect(screen.getByRole("status").textContent).toBe("Loading history…");
    view.rerender(<HistorySidebar history={fakeHistory({ entries: [] })} title="" />);
    expect(screen.getByRole("status").textContent).toBe("No revisions yet");
    const failed = fakeHistory({ entries: null, error: "History is unavailable: the hub cannot be reached." });
    view.rerender(<HistorySidebar history={failed} title="" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(failed.retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to now" }));
    expect(failed.now).toHaveBeenCalled();
  });
});

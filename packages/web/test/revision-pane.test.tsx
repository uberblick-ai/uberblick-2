import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import * as Y from "yjs";
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

describe("revision restore control states", () => {
  it.each([false, true])("disables the current After revision without a visible reason line, named comparison: %s", async since => {
    const history = historyAt(0, since);
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
  ])("keeps the visible header reason ahead of current and busy states: $reason", async ({ archived, writable, reason }) => {
    const history = historyAt(0, false, true);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable={writable} archived={archived} />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version", description: reason });
    const explanation = description(button);
    expect(button.disabled).toBe(true);
    expect(explanation.classList.contains("sr-only")).toBe(false);
    expect(explanation.closest("header")).not.toBeNull();
    expect(screen.queryByText("This is the current version.")).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it("refuses restore while history loads and describes the wait without another visible line", async () => {
    const history = historyAt(1, false, true);
    render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version", description: "Wait for history to load." });
    expect(button.disabled).toBe(true);
    expect(description(button).classList.contains("sr-only")).toBe(true);
    await act(async () => fireEvent.click(button));
    expect(history.restore).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores the selected After ID rather than its Before baseline, named comparison: %s", async since => {
    const history = historyAt(1, since);
    const view = render(<RevisionPane history={history} docLinks={null} workspaceSettings={null} writable />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore this version" });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(view.container.querySelector('.ProseMirror[aria-label="Document revision"]')).not.toBeNull();
    if (since) expect(screen.getByText("· compared with “Reviewed”")).not.toBeNull();
    await act(async () => fireEvent.click(button));
    expect(history.restore).toHaveBeenCalledExactlyOnceWith("selected");
  });
});

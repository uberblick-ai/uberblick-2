/**
 * Inline naming ends each opening exactly once. Browser tests cover the hub
 * round trip; these pin the keyboard and blur rules that decide whether a
 * request is sent at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import * as Y from "yjs";
import { initDoc } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import { act, cleanup, render } from "./react-render.js";
import type { DocumentHistory } from "../src/ui/document/document-history.js";
import { RevisionNameControls } from "../src/ui/document/RevisionNameControls.js";

vi.mock("../src/shell/document-revisions.js", async (original) => ({
  ...await original<typeof import("../src/shell/document-revisions.js")>(),
  documentRevisionChecksum: vi.fn(async () => "checksum-at-open"),
}));

afterEach(() => cleanup());

const person = { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } };
const named: RevisionEntry = { id: "rev-1", author: person, startedAt: 1, endedAt: 2,
  name: { text: "Reviewed", namer: person, namedAt: 2, canManage: true } };

function fakeHistory(overrides: Partial<DocumentHistory> = {}): DocumentHistory {
  return {
    entries: [named], selection: null, busy: false, error: null, titles: {}, collapseUnchanged: true, setCollapseUnchanged: vi.fn(), available: true, active: false, connected: true, history: null, downloading: false, entry: null,
    name: vi.fn(async () => {}), rename: vi.fn(async () => {}), removeName: vi.fn(async () => {}),
    ...overrides,
  } as unknown as DocumentHistory;
}

function liveDocument(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "9f3c1a2b-0000-4000-8000-0123456789ab", title: "Plan" });
  return doc;
}

const field = (): HTMLInputElement => screen.getByRole("textbox", { name: "Revision name" });

async function openNaming(history = fakeHistory()) {
  const view = render(<RevisionNameControls history={history} liveDocument={liveDocument()} writable />);
  fireEvent.click(screen.getByRole("button", { name: "Name current revision" }));
  return { history, view };
}

describe("inline revision naming", () => {
  it("offers naming and management only while connected, including names created by another writer", () => {
    const live = liveDocument();
    const history = fakeHistory({ connected: false });
    const view = render(<RevisionNameControls history={history} liveDocument={live} writable />);
    expect(screen.queryByRole("button", { name: "Name current revision" })).toBeNull();
    const otherWriter = { ...named, name: { ...named.name!, namer: { ...person, githubUsername: "lena" } } };
    const selected = fakeHistory({ connected: false, entry: otherWriter, selection: { index: 0 } as DocumentHistory["selection"] });
    view.rerender(<RevisionNameControls history={selected} liveDocument={null} writable />);
    expect(screen.queryByRole("button", { name: "Rename revision" })).toBeNull();
    view.rerender(<RevisionNameControls history={{ ...selected, connected: true }} liveDocument={null} writable />);
    expect(screen.getByRole("button", { name: "Rename revision" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename revision" }));
    fireEvent.change(field(), { target: { value: "Changed while disconnecting" } });
    view.rerender(<RevisionNameControls history={selected} liveDocument={null} writable />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(selected.rename).not.toHaveBeenCalled();
    expect(selected.removeName).not.toHaveBeenCalled();
    live.destroy();
  });

  it("submits once on Enter, even when blur follows", async () => {
    const { history } = await openNaming();
    fireEvent.change(field(), { target: { value: "Reviewed" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
      fireEvent.blur(field());
    });
    expect(history.name).toHaveBeenCalledTimes(1);
    expect(history.name).toHaveBeenCalledWith("Reviewed", "checksum-at-open");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("cancels on Escape and saves nothing on the blur that follows", async () => {
    const { history } = await openNaming();
    fireEvent.change(field(), { target: { value: "Reviewed" } });
    const input = field();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await act(async () => {});
    expect(history.name).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("ignores Enter that confirms an IME composition", async () => {
    const { history } = await openNaming();
    fireEvent.change(field(), { target: { value: "レビュー" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    await act(async () => {});
    expect(history.name).not.toHaveBeenCalled();
    expect(field().value).toBe("レビュー");
  });

  it("cancels on blur with an empty value and submits a changed one", async () => {
    const { history } = await openNaming();
    fireEvent.blur(field());
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Name current revision" }));
    fireEvent.change(field(), { target: { value: "Reviewed" } });
    await act(async () => fireEvent.blur(field()));
    expect(history.name).toHaveBeenCalledTimes(1);
  });

  it("disables the field while pending, keeps the text on refusal and shows the reason beside it", async () => {
    let refuse!: (error: Error) => void;
    const history = fakeHistory({ name: vi.fn(() => new Promise<void>((_, no) => { refuse = no; })) });
    await openNaming(history);
    fireEvent.change(field(), { target: { value: "Reviewed" } });
    await act(async () => fireEvent.keyDown(field(), { key: "Enter" }));
    expect(field().disabled).toBe(true);
    fireEvent.blur(field());
    await act(async () => refuse(new Error("This document has changed or is not synced.")));
    expect(history.name).toHaveBeenCalledTimes(1);
    expect(field().disabled).toBe(false);
    expect(field().value).toBe("Reviewed");
    expect(screen.getByRole("alert").textContent).toContain("has changed");
    expect(field().getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });

  it("renames the revision it opened on, removes the name when emptied, and cancels an unchanged blur", async () => {
    const history = fakeHistory({ selection: { index: 0 } as DocumentHistory["selection"], entry: named, active: true });
    render(<RevisionNameControls history={history} liveDocument={null} writable />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Rename revision" }));
    open();
    expect(field().value).toBe("Reviewed");
    fireEvent.blur(field());
    expect(history.rename).not.toHaveBeenCalled();
    open();
    fireEvent.change(field(), { target: { value: "Baseline" } });
    await act(async () => fireEvent.keyDown(field(), { key: "Enter" }));
    expect(history.rename).toHaveBeenCalledWith("rev-1", "Baseline");
    open();
    fireEvent.change(field(), { target: { value: "" } });
    await act(async () => fireEvent.keyDown(field(), { key: "Enter" }));
    expect(history.removeName).toHaveBeenCalledWith("rev-1");
  });

  it("closes without saving when authority goes away while the field is open", async () => {
    const history = fakeHistory({ selection: { index: 0 } as DocumentHistory["selection"], entry: named, active: true });
    const view = render(<RevisionNameControls history={history} liveDocument={null} writable />);
    fireEvent.click(screen.getByRole("button", { name: "Rename revision" }));
    fireEvent.change(field(), { target: { value: "Baseline" } });
    view.rerender(<RevisionNameControls history={history} liveDocument={null} writable={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    const reader = fakeHistory({ ...history, entry: { ...named, name: { ...named.name!, canManage: false } } });
    view.rerender(<RevisionNameControls history={reader} liveDocument={null} writable />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(history.rename).not.toHaveBeenCalled();
  });
});

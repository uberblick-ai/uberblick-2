/**
 * The document metadata line: tags, lifecycle, copy and document actions.
 *
 * These tests pin the document-local controls without a global-header double.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, render, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import {
  appendBlock,
  getMeta,
  getMetaMap,
  initDoc,
  setKind,
  setStatus,
  setTags,
} from "@uberblick/schema";
import { DocMetaLine } from "../src/ui/document/DocChrome.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { writeToClipboard } from "../src/editor/source-chrome.js";
import { toast } from "sonner";

vi.mock("../src/editor/source-chrome.js", async (original) => ({
  ...await original<typeof import("../src/editor/source-chrome.js")>(),
  writeToClipboard: vi.fn().mockResolvedValue(true),
}));
vi.mock("sonner", async (original) => ({
  ...await original<typeof import("sonner")>(),
  toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";

interface Fixture {
  ydoc: Y.Doc;
  connection: RoomConnection;
  blockIds: string[];
}

function fixture(): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC_UUID, title: "Sync and offline" });
  setTags(ydoc, ["needs-love", "feature"]);
  const blockIds = [
    appendBlock(ydoc, { type: "paragraph", text: "first block" }),
    appendBlock(ydoc, { type: "paragraph", text: "second block" }),
  ];
  const connection = {
    room: `${WORKSPACE}/${DOC_UUID}`,
    ydoc,
    provider: { awareness: null },
  } as unknown as RoomConnection;
  return { ydoc, connection, blockIds };
}

function mount(fix: Fixture): { host: HTMLElement; view: RenderResult } {
  const view = render(
    <DocMetaLine
      connection={fix.connection}
      segment={WORKSPACE}
      meta={getMeta(fix.ydoc)}
      archived={false}
      onTogglePin={() => {}}
    />,
  );
  return { host: view.container, view };
}

function openActions(host: HTMLElement): void {
  act(() => {
    const trigger = within(host).getByRole("button", { name: "Document actions" });
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

async function selectCopy(name: string): Promise<void> {
  await act(async () => screen.getByRole(name === "Copy link" ? "button" : "menuitem", { name }).click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the document identity line keeps its local controls", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    vi.mocked(writeToClipboard).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("makes archive unavailability reachable and non-activating", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    const { host } = mount(fixture());
    act(() => {
      const trigger = within(host).getByRole("button", { name: "Document actions" });
      trigger?.focus();
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const unavailable = screen.getByRole("menuitem", {
      name: "Archive unavailable — the directory or sidebar room is not ready to write, or there is no live entry for this document",
    });
    expect(unavailable?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Copy document id");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
      vi.runOnlyPendingTimers();
    });
    expect(document.activeElement).toBe(unavailable);
    act(() => {
      unavailable?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(screen.queryByRole("alertdialog", { name: /Archive/ })).toBeNull();
  });

  it("does not derive navigation from tags or show identity above the title", () => {
    const { host } = mount(fixture());
    expect(within(host).queryByText(/^(?:Product|Decision)(?: · .+)?$/)).toBeNull();
    // The legacy group badge for this fixture's feature tag is gone too.
    expect(within(host).queryByText("Features")).toBeNull();
    expect(host.querySelector(".ub-doc-ids, .ub-doc-rev")).toBeNull();
    expect(host.textContent).not.toContain("uuid");
    expect(within(host).getByRole("button", { name: "Document actions" })).not.toBeNull();
  });

  it("offers an icon-only copy button immediately before document actions", () => {
    const { host } = mount(fixture());
    const copy = within(host).getByRole("button", { name: "Copy link" });
    const actions = within(host).getByRole("button", { name: "Document actions" });
    expect(copy.getAttribute("title")).toBe("Copy link");
    expect(copy.textContent).toBe("");
    expect(copy.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    expect(copy.nextElementSibling?.contains(actions)).toBe(true);
    openActions(host);
    expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
  });

  it("starts a link copy during the input event without opening the menu", async () => {
    const { host } = mount(fixture());
    let dispatching = false;
    let startedInGesture = false;
    vi.mocked(writeToClipboard).mockImplementationOnce(async () => {
      startedInGesture = dispatching;
      return true;
    });
    act(() => {
      dispatching = true;
      within(host).getByRole("button", { name: "Copy link" }).click();
      dispatching = false;
    });
    expect(startedInGesture).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeToClipboard).toHaveBeenCalledTimes(1);
    expect(writeToClipboard).toHaveBeenCalledWith(`${window.location.origin}/${WORKSPACE}/${DOC_UUID}`, undefined);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["Copy link", "Couldn't copy the link. Select it in the address bar instead."],
    ["Copy document id", "Couldn't copy the document id. Try again in a browser with clipboard access."],
  ])("gives a next step when %s fails", async (name, message) => {
    vi.mocked(writeToClipboard).mockResolvedValueOnce(false);
    const { host } = mount(fixture());
    if (name === "Copy document id") openActions(host);
    await selectCopy(name);
    expect(toast.error).toHaveBeenLastCalledWith(message, { id: "clipboard" });
  });

  it("names lifecycle records, omits ordinary documents and tolerates a mismatched status", () => {
    const decision = fixture();
    setKind(decision.ydoc, "decision");
    setStatus(decision.ydoc, "open");
    const mountedDecision = mount(decision);
    try {
      expect(within(mountedDecision.host).getByText("Decision").textContent).toBe(
        "Decision",
      );
    } finally {
      mountedDecision.view.unmount();
    }

    const mismatched = fixture();
    getMetaMap(mismatched.ydoc).set("kind", "decision");
    getMetaMap(mismatched.ydoc).set("status", "planned");
    const mountedMismatch = mount(mismatched);
    try {
      expect(within(mountedMismatch.host).getByText("Decision").textContent).toBe("Decision");
    } finally {
      mountedMismatch.view.unmount();
    }

    const ordinary = mount(fixture());
    try {
      expect(within(ordinary.host).queryByText(/^(?:Product|Decision)(?: · .+)?$/)).toBeNull();
    } finally {
      ordinary.view.unmount();
    }
  });

  it.each([undefined, "planned", "open"])("shows a stored requirement with status %s as ordinary without rewriting its room", (status) => {
    const legacy = fixture();
    getMetaMap(legacy.ydoc).set("kind", "requirement");
    if (status !== undefined) getMetaMap(legacy.ydoc).set("status", status);
    const mountedLegacy = mount(legacy);
    try {
      expect(within(mountedLegacy.host).queryByText(/^(?:Product|Decision)(?: · .+)?$/)).toBeNull();
      expect(getMetaMap(legacy.ydoc).get("kind")).toBe("requirement");
      expect(getMetaMap(legacy.ydoc).get("status")).toBe(status);
    } finally {
      mountedLegacy.view.unmount();
    }
  });

  it.each([
    { kind: "regular", archived: false, readOnly: false, status: undefined, copyPath: undefined },
    { kind: "regular", archived: false, readOnly: true, status: undefined, copyPath: undefined },
    { kind: "decision", archived: false, readOnly: false, status: undefined, copyPath: `/${WORKSPACE}/topic/record/${DOC_UUID}` },
    { kind: "decision", archived: false, readOnly: true, status: "decided" as const, copyPath: `/${WORKSPACE}/topic` },
    { kind: "regular", archived: true, readOnly: true, status: undefined, copyPath: undefined },
    { kind: "decision", archived: true, readOnly: true, status: "decided" as const, copyPath: `/${WORKSPACE}/topic` },
  ])("copies the shown $kind document's canonical path and full id when archived=$archived, readOnly=$readOnly and status=$status", async ({ kind, archived, readOnly, status, copyPath }) => {
    const fix = fixture();
    if (kind === "decision") setKind(fix.ydoc, "decision");
    if (status !== undefined) setStatus(fix.ydoc, status);
    const { container: host } = render(<DocMetaLine
      connection={fix.connection}
      segment={WORKSPACE}
      meta={getMeta(fix.ydoc)}
      archived={archived}
      readOnly={readOnly}
      copyPath={copyPath}
    />);
    await selectCopy("Copy link");
    expect(writeToClipboard).toHaveBeenLastCalledWith(`${window.location.origin}${copyPath ?? `/${WORKSPACE}/${DOC_UUID}`}`, undefined);
    expect(toast.success).toHaveBeenLastCalledWith("Link copied", { id: "clipboard" });
    expect(screen.queryByRole("menu")).toBeNull();
    openActions(host);
    expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
    if (archived) expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy document id"]);
    await selectCopy("Copy document id");
    expect(writeToClipboard).toHaveBeenLastCalledWith(DOC_UUID, expect.any(Promise));
    expect(toast.success).toHaveBeenLastCalledWith("Document id copied", { id: "clipboard" });
  });
});

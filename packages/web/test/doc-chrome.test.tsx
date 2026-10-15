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
import { notifyTransient } from "../src/notifications.js";

vi.mock("../src/editor/source-chrome.js", async (original) => ({
  ...await original<typeof import("../src/editor/source-chrome.js")>(),
  writeToClipboard: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/notifications.js", async (original) => ({
  ...await original<typeof import("../src/notifications.js")>(),
  notifyTransient: vi.fn(),
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
  await act(async () => screen.getByRole("menuitem", { name }).click());
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
    expect(document.activeElement?.textContent).toBe("Copy link");
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

  it("starts a selected copy during the input event", async () => {
    const { host } = mount(fixture());
    openActions(host);
    let dispatching = false;
    let startedInGesture = false;
    vi.mocked(writeToClipboard).mockImplementationOnce(async () => {
      startedInGesture = dispatching;
      return true;
    });
    act(() => {
      dispatching = true;
      screen.getByRole("menuitem", { name: "Copy link" }).click();
      dispatching = false;
    });
    expect(startedInGesture).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeToClipboard).toHaveBeenCalledTimes(1);
  });

  it("names lifecycle records, omits ordinary documents and tolerates a mismatched status", () => {
    const decision = fixture();
    setKind(decision.ydoc, "decision");
    setStatus(decision.ydoc, "open");
    const mountedDecision = mount(decision);
    try {
      expect(within(mountedDecision.host).getByText("Decision · open").textContent).toBe(
        "Decision · open",
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
    { kind: "regular", archived: false, copyPath: undefined },
    { kind: "decision", archived: false, copyPath: `/${WORKSPACE}/topic/record/${DOC_UUID}` },
    { kind: "regular", archived: true, copyPath: undefined },
    { kind: "decision", archived: true, copyPath: `/${WORKSPACE}/topic` },
  ])("copies the shown $kind document's canonical path and full id when archived=$archived", async ({ kind, archived, copyPath }) => {
    const fix = fixture();
    if (kind === "decision") setKind(fix.ydoc, "decision");
    const { container: host } = render(<DocMetaLine
      connection={fix.connection}
      segment={WORKSPACE}
      meta={getMeta(fix.ydoc)}
      archived={archived}
      copyPath={copyPath}
    />);
    openActions(host);
    if (archived) expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy link", "Copy document id"]);
    await selectCopy("Copy link");
    expect(writeToClipboard).toHaveBeenLastCalledWith(`${window.location.origin}${copyPath ?? `/${WORKSPACE}/${DOC_UUID}`}`, expect.any(Promise));
    expect(notifyTransient).toHaveBeenLastCalledWith({ key: "clipboard", message: "URL copied to clipboard", severity: "success" });
    openActions(host);
    await selectCopy("Copy document id");
    expect(writeToClipboard).toHaveBeenLastCalledWith(DOC_UUID, expect.any(Promise));
    expect(notifyTransient).toHaveBeenLastCalledWith({ key: "clipboard", message: "Document id copied to clipboard", severity: "success" });
  });
});

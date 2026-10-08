/**
 * The document identity line: tags, uuid/revision, copy and document actions.
 *
 * The removed global header deliberately has no test double here. These tests
 * pin only the document-local controls that survive #611.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, render, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import {
  appendBlock,
  editBlock,
  getMeta,
  getMetaMap,
  initDoc,
  setKind,
  setStatus,
  setTags,
} from "@uberblick/schema";
import { DocMetaLine } from "../src/ui/DocChrome.js";
import type { RoomConnection } from "../src/collab/rooms.js";

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

function identityText(host: HTMLElement): string {
  const rev = within(host).getByText(/^· rev [0-9a-f]{8}$/);
  // The identity grouping has no role or name; keep its entire text so extra
  // full-address or revision text cannot hide between the visible fragments.
  return (rev.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("the document identity line keeps its local controls", () => {
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
    expect(document.activeElement?.textContent).toBe("Pin to sidebar");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
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

  it("does not derive navigation from tags and keeps the shortened identity", () => {
    const { host } = mount(fixture());
    expect(within(host).queryByText(/^(?:Product|Decision)(?: · .+)?$/)).toBeNull();
    // The legacy group badge for this fixture's feature tag is gone too.
    expect(within(host).queryByText("Features")).toBeNull();
    expect(identityText(host)).toMatch(
      /^uuid 9f3c1a2b · rev [0-9a-f]{8}$/,
    );
    expect(within(host).getByRole("button", { name: /copies the canonical document URL/ })).not.toBeNull();
    expect(within(host).getByRole("button", { name: "Document actions" })).not.toBeNull();
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
    getMetaMap(mismatched.ydoc).set("kind", "requirement");
    getMetaMap(mismatched.ydoc).set("status", "open");
    const mountedMismatch = mount(mismatched);
    try {
      expect(within(mountedMismatch.host).getByText("Product").textContent).toBe("Product");
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

  it("moves the rev when a block's content changes", () => {
    const fix = fixture();
    const { host } = mount(fix);
    const before = identityText(host);
    act(() => {
      editBlock(fix.ydoc, fix.blockIds[0] ?? "", "first block", "first block!");
    });
    const after = identityText(host);
    expect(after).not.toBe(before);
    expect(after).toMatch(/^uuid 9f3c1a2b · rev [0-9a-f]{8}$/);
  });
});

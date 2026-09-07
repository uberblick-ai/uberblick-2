/**
 * The document identity line: tags, uuid/revision, copy and document actions.
 *
 * The removed global header deliberately has no test double here. These tests
 * pin only the document-local controls that survive #611.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
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

function mount(fix: Fixture): { host: HTMLElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DocMetaLine
        connection={fix.connection}
        segment={WORKSPACE}
        meta={getMeta(fix.ydoc)}
        archived={false}
        onTogglePin={() => {}}
      />,
    ),
  );
  return { host, root };
}

function text(host: HTMLElement, selector: string): string | null {
  const found = host.querySelector(selector);
  return found === null ? null : (found.textContent ?? "").replace(/\s+/g, " ").trim();
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
    const { host, root } = mount(fixture());
    try {
      act(() => {
        const trigger = host.querySelector<HTMLButtonElement>(".ub-actions-trigger");
        trigger?.focus();
        trigger?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      const unavailable = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-slot=dropdown-menu-item]",
        ),
      ].find(
        (item) =>
          item.textContent ===
          "Archive unavailable — the directory or sidebar room is not ready to write, or there is no live entry for this document",
      );
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
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("does not derive navigation from tags and keeps the shortened identity", () => {
    const { host, root } = mount(fixture());
    try {
      expect(text(host, ".ub-badge")).toBeNull();
      expect(text(host, ".ub-doc-ids")).toMatch(
        /^uuid 9f3c1a2b · rev [0-9a-f]{8}$/,
      );
      expect(host.querySelector(".ub-copy-link")).not.toBeNull();
      expect(host.querySelector(".ub-actions-trigger")).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("names lifecycle records, omits ordinary documents and tolerates a mismatched status", () => {
    const decision = fixture();
    setKind(decision.ydoc, "decision");
    setStatus(decision.ydoc, "open");
    const mountedDecision = mount(decision);
    try {
      expect(text(mountedDecision.host, ".ub-lifecycle-badge")).toBe(
        "Decision · open",
      );
    } finally {
      act(() => mountedDecision.root.unmount());
      mountedDecision.host.remove();
    }

    const mismatched = fixture();
    getMetaMap(mismatched.ydoc).set("kind", "requirement");
    getMetaMap(mismatched.ydoc).set("status", "open");
    const mountedMismatch = mount(mismatched);
    try {
      expect(text(mountedMismatch.host, ".ub-lifecycle-badge")).toBe("Product");
    } finally {
      act(() => mountedMismatch.root.unmount());
      mountedMismatch.host.remove();
    }

    const ordinary = mount(fixture());
    try {
      expect(ordinary.host.querySelector(".ub-lifecycle-badge")).toBeNull();
    } finally {
      act(() => ordinary.root.unmount());
      ordinary.host.remove();
    }
  });

  it("moves the rev when a block's content changes", () => {
    const fix = fixture();
    const { host, root } = mount(fix);
    try {
      const before = text(host, ".ub-doc-ids");
      act(() => {
        editBlock(fix.ydoc, fix.blockIds[0] ?? "", "first block", "first block!");
      });
      const after = text(host, ".ub-doc-ids");
      expect(after).not.toBe(before);
      expect(after).toMatch(/^uuid 9f3c1a2b · rev [0-9a-f]{8}$/);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

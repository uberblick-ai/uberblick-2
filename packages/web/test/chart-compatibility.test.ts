/** Previous web vocabulary must refuse binding and preserve chart source as raw text. */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  editBlock,
  getBlocksFragment,
  initDoc,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import {
  BLOCK_NODE_NAMES,
  describeForeignBlocks,
  findForeignBlocks,
} from "../src/editor/palette.js";
import { EditorPane } from "../src/ui/EditorPane.js";
import { act, render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

// Isolate the old package vocabulary in this test module. The existing gate,
// guarded binding and raw fallback run unchanged, just as in the older bundle.
vi.mock("@uberblick/schema", async (importOriginal) => {
  const schema = await importOriginal<typeof import("@uberblick/schema")>();
  return {
    ...schema,
    BLOCK_TYPES: schema.BLOCK_TYPES.filter((type) => type !== "chart"),
    isBlockType: (value: string): value is typeof schema.BLOCK_TYPES[number] =>
      value !== "chart" && schema.isBlockType(value),
  };
});

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const mapping = JSON.stringify({
  version: 1, type: "line", collection: "observations",
  x: { field: "day", type: "date" }, y: [{ field: "count", label: "Count" }],
});

function fixture() {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "A chart from a newer client" });
  appendBlock(ydoc, { type: "paragraph", text: "Trend explanation" });
  const id = appendBlock(ydoc, { type: "chart", text: mapping });
  const fragment = getBlocksFragment(ydoc);
  const chart = fragment.get(1) as Y.XmlElement;
  const status: RoomStatus = {
    connected: true, synced: true, writable: true,
    hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
    unsyncedChanges: 0, protocolMismatch: null, authFailed: false, tokenMissing: false,
  };
  const connection = {
    room: `${WORKSPACE}/${UUID}`, ydoc, provider: { awareness: null }, status,
    onStatusChange(listener: (reading: RoomStatus) => void) {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
  let localUpdates = 0;
  ydoc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => {
    if (transaction.local) localUpdates += 1;
  });
  onTestCleanup(() => ydoc.destroy());
  return { ydoc, fragment, chart, id, connection, localUpdates: () => localUpdates };
}

describe("chart content on the previous web vocabulary", () => {
  it("closes the palette gate without binding, dropping or rewriting the chart", () => {
    const fix = fixture();
    const before = Y.encodeStateAsUpdate(fix.ydoc);
    const source = fix.chart.firstChild;
    expect(BLOCK_NODE_NAMES).not.toContain("chart");
    const foreign = findForeignBlocks(fix.fragment);
    expect(foreign).toEqual([expect.objectContaining({ index: 1, id: fix.id, nodeName: "chart" })]);
    expect(describeForeignBlocks(foreign)).toContain("unsupported type (chart)");
    expect(describeForeignBlocks(foreign)).toContain("editing is disabled");

    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const binding = bindGuardedEditor({ element: host, fragment: fix.fragment, awareness: null });
      expect(binding.refused).toBe(true);
      expect(binding.editor).toBeNull();
      binding.destroy();
      expect(fix.fragment.get(1)).toBe(fix.chart);
      expect(fix.chart.firstChild).toBe(source);
      expect((source as Y.XmlText).toString()).toBe(mapping);
      expect(Y.encodeStateAsUpdate(fix.ydoc)).toEqual(before);
      expect(fix.localUpdates()).toBe(0);
    } finally {
      host.remove();
    }
  });

  it("shows the actual read-only raw fallback and follows remote mapping edits without local updates", () => {
    const fix = fixture();
    const before = Y.encodeStateAsUpdate(fix.ydoc);
    const page = render(createElement(EditorPane, {
      connection: fix.connection, segment: WORKSPACE, presence: [], author: "Reader",
      archived: false, docLinks: null, onRestore: null, onSelectThread: () => {},
    }));
    expect(page.container.querySelector(".ProseMirror")).toBeNull();
    expect(page.container.querySelector(".ub-foreign-banner")?.textContent).toContain("Editor disabled.");
    expect(page.container.querySelector(".ub-foreign-banner")?.textContent).toContain("unsupported type (chart)");
    expect(page.container.querySelectorAll(".ub-foreign-list pre")[1]?.textContent).toBe(mapping);
    expect(page.container.querySelector("canvas")).toBeNull();
    expect(Y.encodeStateAsUpdate(fix.ydoc)).toEqual(before);
    expect(fix.localUpdates()).toBe(0);

    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, before);
      const next = mapping.replace('"Count"', '"Total"');
      editBlock(peer, fix.id, mapping, next);
      act(() => Y.applyUpdate(fix.ydoc, Y.encodeStateAsUpdate(peer)));
      expect(page.container.querySelector(".ProseMirror")).toBeNull();
      expect(page.container.querySelectorAll(".ub-foreign-list pre")[1]?.textContent).toBe(next);
      expect(fix.fragment.get(1)).toBe(fix.chart);
      expect(fix.chart.nodeName).toBe("chart");
      expect(fix.localUpdates()).toBe(0);
    } finally {
      peer.destroy();
    }
    page.unmount();
    expect(fix.localUpdates()).toBe(0);
  });
});

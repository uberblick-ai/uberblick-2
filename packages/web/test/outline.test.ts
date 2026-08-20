/**
 * The "on this page" outline.
 *
 * The outline is a derivation of the document, not a second copy of it, and that
 * is the property worth pinning: the same headings in the same order as the
 * blocks fragment, levels 1-3 only, refreshed from an observer so a remote
 * client's edit reaches the reader with no extra plumbing.
 *
 * The click target is pinned too: an entry's id is the block id, and the editor
 * renders that id onto the heading element — which is the whole mechanism behind
 * click-to-scroll.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  editBlock,
  getBlocks,
  initDoc,
  setBlockLevel,
} from "@uberblick/schema";
import { observeOutline, outlineFromDoc } from "../src/ui/outline.js";
import type { OutlineEntry } from "../src/ui/outline.js";
import { mountEditor } from "./helpers.js";

function docWithHeadings(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Outlined" });
  appendBlock(ydoc, { type: "paragraph", text: "intro" });
  appendBlock(ydoc, { type: "heading", text: "Install", level: 1 });
  appendBlock(ydoc, { type: "paragraph", text: "body" });
  appendBlock(ydoc, { type: "heading", text: "Homebrew", level: 2 });
  appendBlock(ydoc, { type: "heading", text: "Flags", level: 3 });
  appendBlock(ydoc, { type: "code", text: "brew install", language: "sh" });
  appendBlock(ydoc, { type: "mermaid", text: "graph TD;" });
  return ydoc;
}

/** Two replicas of one document, wired the way the hub wires them. */
function replicas(): { local: Y.Doc; remote: Y.Doc } {
  const local = docWithHeadings();
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return { local, remote };
}

describe("the outline derives from the document's heading blocks", () => {
  it("lists headings in document order, with their level and text", () => {
    expect(outlineFromDoc(docWithHeadings())).toEqual([
      { id: expect.any(String), level: 1, text: "Install" },
      { id: expect.any(String), level: 2, text: "Homebrew" },
      { id: expect.any(String), level: 3, text: "Flags" },
    ]);
  });

  it("carries the block ids, in the fragment's order", () => {
    const ydoc = docWithHeadings();
    const headingIds = getBlocks(ydoc)
      .filter((block) => block.type === "heading")
      .map((block) => block.id);
    expect(outlineFromDoc(ydoc).map((entry) => entry.id)).toEqual(headingIds);
  });

  it("stops at level 3 — deeper headings are structure, not navigation", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "deep", title: "Deep" });
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      appendBlock(ydoc, { type: "heading", text: `h${level}`, level });
    }
    expect(outlineFromDoc(ydoc).map((entry) => entry.text)).toEqual([
      "h1",
      "h2",
      "h3",
    ]);
  });

  it("is empty for a document with no headings", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "flat", title: "Flat" });
    appendBlock(ydoc, { type: "paragraph", text: "just prose" });
    expect(outlineFromDoc(ydoc)).toEqual([]);
  });
});

describe("the outline updates live", () => {
  /** The latest outline an observer has seen. */
  function watch(ydoc: Y.Doc): {
    latest: () => OutlineEntry[];
    stop: () => void;
  } {
    let seen: OutlineEntry[] = [];
    const stop = observeOutline(ydoc, (outline) => {
      seen = outline;
    });
    return { latest: () => seen, stop };
  }

  it("reports the current outline as soon as it is observed", () => {
    const ydoc = docWithHeadings();
    const watcher = watch(ydoc);
    expect(watcher.latest().map((entry) => entry.text)).toEqual([
      "Install",
      "Homebrew",
      "Flags",
    ]);
    watcher.stop();
  });

  it("sees a heading a remote replica adds", () => {
    const { local, remote } = replicas();
    const watcher = watch(local);
    appendBlock(remote, { type: "heading", text: "Upgrade", level: 2 });
    expect(watcher.latest().map((entry) => entry.text)).toEqual([
      "Install",
      "Homebrew",
      "Flags",
      "Upgrade",
    ]);
    watcher.stop();
  });

  /**
   * The reason the subscription is deep. A heading's text lives in the
   * Y.XmlText one level below the blocks fragment, so a shallow observer would
   * see headings appear and disappear but never see one retitled.
   */
  it("sees a heading a remote replica retitles", () => {
    const { local, remote } = replicas();
    const watcher = watch(local);
    const heading = outlineFromDoc(remote).find((entry) => entry.text === "Homebrew");
    expect(heading).toBeDefined();

    // Edited through the schema's block write, the way an agent's `edit_block`
    // does it: a splice inside the heading's Y.XmlText, one level below the
    // fragment.
    editBlock(remote, heading!.id, "Homebrew", "Homebrew (macOS)");

    expect(watcher.latest().map((entry) => entry.text)).toEqual([
      "Install",
      "Homebrew (macOS)",
      "Flags",
    ]);
    watcher.stop();
  });

  it("sees a heading a remote replica re-levels out of range", () => {
    const { local, remote } = replicas();
    const watcher = watch(local);
    const flags = outlineFromDoc(remote).find((entry) => entry.text === "Flags");
    expect(flags).toBeDefined();
    setBlockLevel(remote, flags!.id, 4);
    expect(watcher.latest().map((entry) => entry.text)).toEqual([
      "Install",
      "Homebrew",
    ]);
    watcher.stop();
  });

  it("stops reporting once unsubscribed", () => {
    const { local, remote } = replicas();
    const watcher = watch(local);
    watcher.stop();
    appendBlock(remote, { type: "heading", text: "Later", level: 1 });
    expect(watcher.latest().map((entry) => entry.text)).toEqual([
      "Install",
      "Homebrew",
      "Flags",
    ]);
  });
});

describe("an outline entry addresses the rendered heading", () => {
  it("uses the block id the editor renders as the element id", () => {
    const ydoc = docWithHeadings();
    const { editor, element } = mountEditor(ydoc);
    try {
      for (const entry of outlineFromDoc(ydoc)) {
        const rendered = element.querySelector(`[id="${entry.id}"]`);
        expect(rendered).not.toBeNull();
        expect(rendered?.tagName).toBe(`H${entry.level}`);
        expect(rendered?.textContent).toBe(entry.text);
      }
    } finally {
      editor.destroy();
    }
  });
});

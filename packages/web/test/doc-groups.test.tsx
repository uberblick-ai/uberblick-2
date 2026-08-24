/**
 * The sidebar's tag groups.
 *
 * Two properties are worth pinning. First, the grouping is a *derivation* of the
 * directory listing: canonical group order, first-known-tag-wins placement, one
 * trailing group for everything else, and no header without documents under it —
 * so a retag replicating into the directory doc moves a document between groups
 * with nothing else to update. Second, the collapse state is a stored preference
 * that survives a reload, which is the only thing here that is not derived.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { listDirectory, upsertDirectoryEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { DocList } from "../src/ui/DocList.js";
import { GROUP_TAGS, groupEntries, groupKeyFor } from "../src/ui/groups.js";

function entry(uuid: string, title: string, tags: string[] = []): DirectoryEntry {
  return { uuid, title, tags };
}

/** Group keys in the order the sidebar would render them. */
function keys(entries: DirectoryEntry[]): string[] {
  return groupEntries(entries).map((group) => group.key);
}

describe("grouping derives from the directory listing", () => {
  it("orders the known groups canonically, with the leftovers last", () => {
    const entries = [
      entry("d", "Test protocols", ["verify"]),
      entry("a", "Architecture", ["reference"]),
      entry("c", "Untitled", []),
      entry("b", "Overview", ["start-here"]),
      entry("e", "Editing", ["feature"]),
    ];
    expect(keys(entries)).toEqual([...GROUP_TAGS, "other"]);
  });

  it("places a multi-tagged doc under the first group in canonical order", () => {
    // Not the document's own tag order — the canonical order is the tie-break,
    // so every replica groups the same doc identically.
    const doc = entry("m", "Annotations", ["reference", "feature"]);
    expect(groupKeyFor(doc)).toBe("feature");
    expect(groupEntries([doc])).toEqual([
      { key: "feature", label: "Features", entries: [doc] },
    ]);
  });

  it("drops an untagged or unknown-tagged doc into the trailing group", () => {
    expect(groupKeyFor(entry("u", "Untitled", []))).toBe("other");
    expect(groupKeyFor(entry("x", "Scratch", ["misc", "wip"]))).toBe("other");
  });

  it("omits empty groups — never a header with nothing under it", () => {
    expect(keys([entry("a", "Install", ["start-here"])])).toEqual(["start-here"]);
    expect(keys([])).toEqual([]);
  });

  it("keeps the listing's order inside a group", () => {
    const entries = [
      entry("b", "Annotations", ["feature"]),
      entry("a", "Blocks", ["feature"]),
      entry("c", "Cursors", ["feature"]),
    ];
    expect(groupEntries(entries)[0]?.entries.map((e) => e.uuid)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

describe("a retag moves a doc between groups", () => {
  it("follows the directory doc, with no second copy to update", () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));

    upsertDirectoryEntry(remote, { uuid: "u1", title: "Annotations", tags: ["feature"] });
    expect(keys(listDirectory(local))).toEqual(["feature"]);

    // What `set_tags` (or a meta edit repairing the stub) does to the stub.
    upsertDirectoryEntry(remote, { uuid: "u1", title: "Annotations", tags: ["reference"] });
    expect(keys(listDirectory(local))).toEqual(["reference"]);

    upsertDirectoryEntry(remote, { uuid: "u1", title: "Annotations", tags: [] });
    expect(keys(listDirectory(local))).toEqual(["other"]);
  });
});

describe("group collapse is a stored preference", () => {
  const entries = [
    entry("s1", "Overview", ["start-here"]),
    entry("f1", "Editing", ["feature"]),
  ];

  function render(): { host: HTMLElement; unmount: () => void } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <DocList
          connection={null}
          entries={entries}
          selected={null}
          onSelect={() => {}}
          onCreate={() => {}}
        />,
      );
    });
    return {
      host,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  /**
   * Titles currently listed, group headers excluded.
   *
   * A collapsed group keeps its list in the DOM — the open/closed transition is
   * a CSS animation, which needs something to animate (#110) — so "visible"
   * means "under a group body that is not collapsed", not "present". The body
   * is `inert` while collapsed, so nothing here is reachable either.
   */
  function visibleDocs(host: HTMLElement): string[] {
    return [
      ...host.querySelectorAll('.ub-group-body:not([data-collapsed="true"]) li button'),
    ].map((el) => el.textContent ?? "");
  }

  function headers(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>(".ub-group-head")];
  }

  /**
   * A fresh in-memory Storage. Node's own experimental `localStorage` global
   * shadows jsdom's here and is unusable without `--localstorage-file`, so the
   * test provides the one thing `useStoredFlag` needs.
   */
  function installStorage(): void {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  }

  beforeEach(() => {
    installStorage();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  it("starts expanded and collapses only the group that was clicked", () => {
    const view = render();
    expect(
      [...view.host.querySelectorAll(".ub-group-label")].map((el) => el.textContent),
    ).toEqual(["Start here", "Features"]);
    expect(visibleDocs(view.host)).toEqual(["Overview", "Editing"]);

    act(() => headers(view.host)[0]!.click());
    expect(visibleDocs(view.host)).toEqual(["Editing"]);
    expect(headers(view.host)[0]!.getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });

  it("survives a reload", () => {
    const first = render();
    act(() => headers(first.host)[1]!.click());
    expect(visibleDocs(first.host)).toEqual(["Overview"]);
    first.unmount();

    // A fresh mount is what a reload looks like to the component.
    const second = render();
    expect(visibleDocs(second.host)).toEqual(["Overview"]);
    expect(headers(second.host)[1]!.getAttribute("aria-expanded")).toBe("false");
    second.unmount();
  });
});

/**
 * Getting to a comment thread without a mouse, and without a wide window (#101).
 *
 * Two claims, and both are about the *whole* app rather than a pane, because
 * both cross panes: a highlight lives in the editor and the card it leads to
 * lives in the rail, and the toggle that opens the rail lives in the topbar. So
 * this mounts `App` over rooms that are plain shared Y.Docs — the pattern
 * `archived.test.tsx` uses — and drives it the way a reader does.
 *
 * 1. **The keyboard reaches the card.** Every highlight is a `role="button"` tab
 *    stop; Enter on a focused one selects its thread and DOM focus lands on the
 *    card's button. Enter with the *caret* in the prose is untouched — the
 *    editor's own key, not an activation.
 * 2. **The rail can be opened where it is hidden.** Below 1100px the stylesheet
 *    hides the rail; the topbar's "Threads (N)" toggle opens it as a drawer, and
 *    Escape closes it again. The width itself is the stylesheet's business —
 *    jsdom computes no media queries — so what is pinned here is the mechanism
 *    the stylesheet keys off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  directoryRoom,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  initDoc,
  roomForDoc,
  setAnnotationResolved,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { threadCardId } from "../src/ui/threads.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** The annotated paragraph. "quick brown" — [4, 15) — is the marked range. */
const PARAGRAPH = "The quick brown fox jumps.";
const UUID = "5c2f8a41-7b93-4d6e-a018-3f9c2b7e5d04";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
  hasLocalCache: false,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

const rooms = new Map<string, RoomConnection>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: OFFLINE,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(OFFLINE);
      return () => {};
    },
    whenLocalReplicaLoaded: Promise.resolve(),
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom implements none of these. The rail scrolls a card into view, and
  // ProseMirror measures the caret's Range to scroll a split block into view.
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () =>
    [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  vi.restoreAllMocks();
});

/**
 * One annotated document, opened. `await act(async …)`: the app holds every room
 * back until it has read its hub endpoint, so a synchronous render commits a
 * shell with no panes in it.
 */
async function openAnnotatedDoc(resolved = false): Promise<{
  host: HTMLElement;
  ydoc: Y.Doc;
  threadId: string;
}> {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
  initDoc(ydoc, { uuid: UUID, title: "Annotated" });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  upsertDirectoryEntry(directory, { uuid: UUID, title: "Annotated" });
  const blockId = getBlocks(ydoc)[0]!.id;
  const thread = createAnnotation(ydoc, blockId, 4, 15, "ben", "why quick?");
  if (resolved) setAnnotationResolved(ydoc, thread.id, true);

  window.history.replaceState(null, "", `/${WORKSPACE}/${UUID}`);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<App />);
  });
  return { host, ydoc, threadId: thread.id };
}

function highlight(host: HTMLElement, threadId: string): HTMLElement {
  const span = host.querySelector<HTMLElement>(
    `[data-comment-thread="${CSS.escape(threadId)}"]`,
  );
  if (span === null) throw new Error("no highlight for that thread");
  return span;
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("a keyboard reaches a thread from its range in the prose", () => {
  it("makes the highlight a control, and Enter on it focuses the card", async () => {
    const { host, threadId } = await openAnnotatedDoc();
    const span = highlight(host, threadId);

    // Reachable by Tab, and announced as something to activate. jsdom does no
    // sequential focus navigation, so what is asserted is what makes the span a
    // tab stop at all.
    expect(span.tabIndex).toBe(0);
    expect(span.getAttribute("role")).toBe("button");
    expect(span.getAttribute("aria-label")).toBe("Comment thread");

    span.focus();
    expect(document.activeElement).toBe(span);
    press(span, "Enter");

    const card = host.querySelector<HTMLButtonElement>(
      `#${CSS.escape(threadCardId(threadId))} button`,
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("why quick?");
    expect(document.activeElement).toBe(card);
  });

  it("reveals a resolved conversation without changing or toggling it", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    const { host, ydoc, threadId } = await openAnnotatedDoc(true);

    // Already correct when the editor first binds after the rail mounts.
    let span = highlight(host, threadId);
    expect(span.getAttribute("aria-label")).toBe(
      "Resolved comment thread — activate to open",
    );
    expect(span.getAttribute("title")).toBe(
      "Resolved comment thread — activate to open",
    );

    // And rewritten after the mark's DOM is redrawn, rather than being a
    // one-time class on a ProseMirror-owned span.
    const text = (getBlocksFragment(ydoc).get(0) as Y.XmlElement)
      .firstChild as Y.XmlText;
    await act(async () => {
      text.insert(0, "Now ");
      await Promise.resolve();
    });
    span = highlight(host, threadId);
    expect(span.getAttribute("aria-label")).toBe(
      "Resolved comment thread — activate to open",
    );
    expect(span.getAttribute("title")).toBe(
      "Resolved comment thread — activate to open",
    );

    const before = [...Y.encodeStateAsUpdate(ydoc)];
    await act(async () => span.click());
    const item = host.querySelector<HTMLElement>(
      `#${CSS.escape(threadCardId(threadId))}`,
    );
    const card = item?.querySelector<HTMLButtonElement>(".ub-thread");
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(card?.textContent).toContain("why quick?");
    expect(scrolled).toContain(item);
    expect(getAnnotation(ydoc, threadId)?.resolved).toBe(true);
    expect(item?.querySelector(".ub-comment-input")).toBeNull();
    expect(
      [...(item?.querySelectorAll<HTMLButtonElement>("button") ?? [])].some(
        (button) => button.textContent === "Reply",
      ),
    ).toBe(false);

    // A second anchor activation is another request to reveal, never the
    // resolved card's own collapse toggle.
    await act(async () => span.click());
    expect(card?.getAttribute("aria-expanded")).toBe("true");

    // The card itself keeps that existing toggle. Once it has collapsed the
    // conversation, the keyboard path from the prose reveals it and lands on
    // the card.
    await act(async () => card?.click());
    expect(card?.getAttribute("aria-expanded")).toBe("false");
    span = highlight(host, threadId);
    span.focus();
    await act(async () => {
      span.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(card);

    // Selection state, DOM state and scrolling are the whole operation.
    expect(getAnnotation(ydoc, threadId)?.resolved).toBe(true);
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
  });

  /**
   * The other half of the same mechanism, and the reason it is a *capture*
   * handler that stops propagation: an Enter meant for the editor must still
   * reach ProseMirror, which would otherwise never split a block again.
   *
   * The caret is put inside the annotated range itself — the worst case, where
   * the highlight is an ancestor of the text the reader is typing in — and the
   * key press is aimed at the contenteditable, which is what holds focus when
   * someone types. What is asserted is the editor's own outcome: the block
   * splits, in the document. An intercepted Enter cannot produce that, and no
   * amount of the handler behaving well can fake it.
   */
  it("leaves Enter alone when the caret, not the highlight, is what is focused", async () => {
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    const prose = host.querySelector<HTMLElement>(".ub-editor .ProseMirror");
    expect(prose).not.toBeNull();
    const span = highlight(host, threadId);
    expect(getBlocks(ydoc)).toHaveLength(1);

    // A real caret, inside the annotated text — and set *after* focusing, since
    // focusing a ProseMirror view syncs the DOM selection from its own state.
    prose!.focus();
    const range = document.createRange();
    range.setStart(span.firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(document.activeElement).toBe(prose);
    expect(selection.anchorNode?.parentElement).toBe(span);

    act(() => {
      prose!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // ProseMirror got the key and did what Enter does: the paragraph is two
    // blocks now, and no text was lost between them.
    //
    // Where the split fell is not asserted. jsdom fires no `selectionchange`,
    // so ProseMirror never observes the DOM caret set above and splits at the
    // position its own state still holds — a jsdom gap, not a claim of this
    // test. That the split happened at all is what an intercepted Enter could
    // not produce.
    const blocks = getBlocks(ydoc);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.text).join("")).toBe(PARAGRAPH);
    // And nothing was selected, so nothing took focus off the prose.
    const card = host.querySelector<HTMLButtonElement>(
      `#${CSS.escape(threadCardId(threadId))} button`,
    );
    expect(document.activeElement).not.toBe(card);
  });
});

describe("the threads rail can be opened where the layout hides it", () => {
  function toggle(host: HTMLElement): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>(".ub-threads-toggle");
    if (button === null) throw new Error("no threads toggle");
    return button;
  }

  function rail(host: HTMLElement): HTMLElement {
    const aside = host.querySelector<HTMLElement>(".ub-rail");
    if (aside === null) throw new Error("no rail");
    return aside;
  }

  it("counts the open threads, opens the rail as a drawer, and closes on Escape", async () => {
    const { host } = await openAnnotatedDoc();

    expect(toggle(host).textContent).toBe("Threads 1");
    expect(toggle(host).getAttribute("aria-controls")).toBe(rail(host).id);
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(rail(host).classList.contains("ub-rail-open")).toBe(false);

    act(() => toggle(host).click());
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    expect(rail(host).classList.contains("ub-rail-open")).toBe(true);

    // An Escape a control in the rail already handled — a reply form cancelling
    // — is that form's dismissal, not the drawer's.
    const consume = (event: Event): void => event.preventDefault();
    rail(host).addEventListener("keydown", consume);
    press(rail(host), "Escape");
    rail(host).removeEventListener("keydown", consume);
    expect(rail(host).classList.contains("ub-rail-open")).toBe(true);

    press(document.body, "Escape");
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(rail(host).classList.contains("ub-rail-open")).toBe(false);
  });
});

/**
 * Getting to a comment thread without a mouse, and without a wide window (#101).
 *
 * Two claims, and both are about the *whole* app rather than a pane, because
 * both cross panes: a highlight lives in the editor and the card it leads to
 * lives in the rail, and the toggle that opens the rail lives at the pane's
 * right edge. So
 * this mounts `App` over rooms that are plain shared Y.Docs — the pattern
 * `archived.test.tsx` uses — and drives it the way a reader does.
 *
 * 1. **The keyboard reaches the card.** Every highlight is a `role="button"` tab
 *    stop; Enter on a focused one selects its thread and DOM focus lands on the
 *    card's button. Enter with the *caret* in the prose is untouched — the
 *    editor's own key, not an activation.
 * 2. **The narrow drawer keeps application state.** The pane's Threads toggle
 *    opens the modal sheet, reply-form Escape takes precedence over dismissal,
 *    and a draft survives dismissing the sheet or switching to the wide rail.
 *    jsdom supplies the media-query result; actual layout and touch input belong
 *    to the browser suite.
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
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
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
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

let mounted: { root: Root; host: HTMLElement } | null = null;

function threadsWidth(narrow: boolean): { change: (next: boolean) => Promise<void> } {
  let matches = narrow;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: "(max-width: 1100px)",
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", (query: string) =>
    query === media.media
      ? media
      : { matches: false, addEventListener: () => {}, removeEventListener: () => {} },
  );
  return {
    change: async (next) => {
      await act(async () => {
        matches = next;
        for (const listener of listeners) {
          listener({ matches, media: media.media } as MediaQueryListEvent);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

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
  threadsWidth(false);
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
  vi.unstubAllGlobals();
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

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
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
    const { host, ydoc, threadId } = await openAnnotatedDoc();

    // The live annotations subscription repaints an already-mounted mark; this
    // state change touches no prose and gives ProseMirror no reason to redraw.
    let span = highlight(host, threadId);
    expect(span.getAttribute("aria-label")).toBe("Comment thread");
    expect(span.getAttribute("title")).toBeNull();
    await act(async () => setAnnotationResolved(ydoc, threadId, true));
    expect(span.getAttribute("aria-label")).toBe(
      "Resolved comment thread",
    );
    expect(span.getAttribute("title")).toBe("Resolved comment thread");

    // And rewritten after the mark's DOM is redrawn, rather than being a
    // one-time class on a ProseMirror-owned span.
    const text = (getBlocksFragment(ydoc).get(0) as Y.XmlElement)
      .firstChild as Y.XmlText;
    await act(async () => {
      text.insert(0, "Now ");
      await Promise.resolve();
    });
    span = highlight(host, threadId);
    expect(span.getAttribute("aria-label")).toBe("Resolved comment thread");
    expect(span.getAttribute("title")).toBe("Resolved comment thread");

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

  function sheet(): HTMLElement {
    const content = document.querySelector<HTMLElement>("[data-slot=sheet-content]");
    if (content === null) throw new Error("no threads sheet");
    return content;
  }

  function button(label: string): HTMLButtonElement {
    const control = [...sheet().querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
    );
    if (control === undefined) throw new Error(`no ${label} button`);
    return control;
  }

  async function settle(action: () => void): Promise<void> {
    await act(async () => action());
    await act(async () => {
      // Radix restores focus after unmounting its focus scope.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function typeReply(text: string): void {
    const field = sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input");
    if (field === null) throw new Error("no reply field");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function composingKey(field: HTMLTextAreaElement, key: string, afterCompositionEnd: boolean): void {
    act(() => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      if (afterCompositionEnd) {
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      }
      press(field, key, {
        isComposing: !afterCompositionEnd,
        ...(afterCompositionEnd ? { keyCode: 229 } : {}),
      });
      if (!afterCompositionEnd) {
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      }
    });
  }

  it.each([
    ["before compositionend", false],
    ["after compositionend", true],
  ] as const)("keeps a composing Escape %s in a drawer reply, then cancels only the form", async (_order, afterCompositionEnd) => {
    threadsWidth(true);
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    await settle(() => toggle(host).click());
    await settle(() => button("Reply").click());
    typeReply("日本語の返信");
    const field = sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input")!;

    // Radix's capture-phase dismissal runs before the textarea sees Escape.
    await settle(() => composingKey(field, "Escape", afterCompositionEnd));
    expect(sheet().querySelector(".ub-comment-input")).toBe(field);
    expect(field.value).toBe("日本語の返信");
    expect(document.activeElement).toBe(field);
    expect(getAnnotation(ydoc, threadId)?.comments).toHaveLength(1);
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");

    await settle(() => press(field, "Escape"));
    expect(sheet().querySelector(".ub-comment-input")).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    await settle(() => button("Reply").click());
    expect(sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe("");
  });

  it("counts threads and lets reply-form Escape cancel only the form", async () => {
    threadsWidth(true);
    const { host } = await openAnnotatedDoc();

    expect(toggle(host).closest(".ub-pane")).not.toBeNull();
    expect(toggle(host).textContent).toBe("Threads 1");
    expect(toggle(host).getAttribute("aria-controls")).toBe("ub-rail");
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();

    await settle(() => toggle(host).click());
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    expect(sheet().id).toBe("ub-rail");

    await settle(() => button("Reply").click());
    const field = sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await settle(() => press(field!, "Escape"));
    expect(sheet().querySelector(".ub-comment-input")).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");

    const card = sheet().querySelector<HTMLButtonElement>(".ub-thread");
    card?.focus();
    expect(document.activeElement).toBe(card);
    await settle(() => press(card!, "Escape"));
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    expect(document.activeElement).toBe(toggle(host));
  });

  it("keeps an unsent reply through dismissal and crossing the rail breakpoint", async () => {
    const width = threadsWidth(true);
    const { host } = await openAnnotatedDoc();
    await settle(() => toggle(host).click());
    await settle(() => button("Reply").click());
    typeReply("Keep this unsent reply");

    for (const close of [
      () => button("Close threads").click(),
      () => {
        const card = sheet().querySelector<HTMLButtonElement>(".ub-thread");
        card!.focus();
        press(card!, "Escape");
      },
    ]) {
      await settle(close);
      expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
      await settle(() => toggle(host).click());
      expect(sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe(
        "Keep this unsent reply",
      );
    }

    await width.change(false);
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>(".ub-rail .ub-comment-input")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe(
      "Keep this unsent reply",
    );

    // A retained draft is not another request to start replying. While the
    // sheet is closed, resizing must leave the writer in the prose.
    await settle(() => button("Close threads").click());
    const prose = host.querySelector<HTMLElement>(".ub-editor .ProseMirror");
    expect(prose).not.toBeNull();
    await settle(() => prose!.focus());
    await width.change(false);
    expect(document.activeElement).toBe(prose);
    expect(host.querySelector<HTMLTextAreaElement>(".ub-rail .ub-comment-input")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    expect(document.activeElement).toBe(prose);
    await settle(() => toggle(host).click());
    expect(sheet().querySelector<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe(
      "Keep this unsent reply",
    );
  });

  it("keeps focus in the prose when a closed keyboard-opened drawer crosses the breakpoint", async () => {
    const width = threadsWidth(true);
    const { host, threadId } = await openAnnotatedDoc();
    const opener = highlight(host, threadId);
    opener.focus();
    await settle(() => press(opener, "Enter"));
    const card = sheet().querySelector<HTMLButtonElement>(".ub-thread");
    expect(document.activeElement).toBe(card);
    await settle(() => press(card!, "Escape"));
    expect(document.activeElement).toBe(opener);

    const prose = host.querySelector<HTMLElement>(".ub-editor .ProseMirror");
    expect(prose).not.toBeNull();
    await settle(() => prose!.focus());
    await width.change(false);
    expect(document.activeElement).toBe(prose);
    await width.change(true);
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    expect(document.activeElement).toBe(prose);
  });

  it("returns to the Threads toggle when the opening highlight was removed", async () => {
    threadsWidth(true);
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    const opener = highlight(host, threadId);
    opener.focus();
    await settle(() => press(opener, "Enter"));

    // A concurrent edit removes the annotated range, while the conversation
    // remains in the sheet as an orphaned thread.
    const text = (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    await settle(() => text.delete(4, 11));
    expect(opener.isConnected).toBe(false);
    expect(sheet().querySelector(".ub-thread-orphaned")).not.toBeNull();

    await settle(() => button("Close threads").click());
    expect(document.activeElement).toBe(toggle(host));
  });
});

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
import { act, renderSettled } from "./react-render.js";
import { screen, within } from "@testing-library/react";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  createAnnotation,
  directoryRoom,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  initDoc,
  roomForDoc,
  setAnnotationResolved,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

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
const roomStatus = new Map<string, RoomStatus>();
const statusListeners = new Map<string, Set<(next: RoomStatus) => void>>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const listeners = new Set<(next: RoomStatus) => void>();
  statusListeners.set(name, listeners);
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    get status() { return roomStatus.get(name) ?? OFFLINE; },
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(roomStatus.get(name) ?? OFFLINE);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

function emitStatus(name: string, change: Partial<RoomStatus>): void {
  const next = { ...(roomStatus.get(name) ?? OFFLINE), ...change };
  roomStatus.set(name, next);
  for (const listener of statusListeners.get(name) ?? []) listener(next);
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

function threadsWidth(narrow: boolean): { change: (next: boolean) => Promise<void> } {
  let matches = narrow;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: "(width < 80rem)",
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
  rooms.clear();
  roomStatus.clear();
  statusListeners.clear();
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
  const { container: host } = await renderSettled(<App />);
  return { host, ydoc, threadId: thread.id };
}

function highlight(host: HTMLElement, threadId: string): HTMLElement {
  // The mark's UUID is the editor-to-thread routing contract.
  const span = host.querySelector<HTMLElement>(
    `[data-comment-thread="${CSS.escape(threadId)}"]`,
  );
  if (span === null) throw new Error("no highlight for that thread");
  return span;
}

function threadButton(item: HTMLElement): HTMLButtonElement {
  return within(item).getByRole<HTMLButtonElement>("button", { name: /^Paragraph \d/ });
}

function threadCard(host: HTMLElement, excerpt = "quick brown"): HTMLElement {
  const region = within(host).getByRole("region", { name: "Threads" });
  const control = within(region).getByRole("button", { name: new RegExp(excerpt) });
  return within(region).getAllByRole("listitem").find((item) => item.contains(control))!;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("thread writes require a writable, unarchived document", () => {
  function findButton(host: HTMLElement, label: string): HTMLButtonElement | null {
    return within(host).queryByRole<HTMLButtonElement>("button", { name: label });
  }

  function button(host: HTMLElement, label: string): HTMLButtonElement {
    const control = findButton(host, label);
    if (control === null) throw new Error(`no ${label} button`);
    return control;
  }

  function replyField(item: HTMLElement): HTMLTextAreaElement {
    return within(item).getByPlaceholderText<HTMLTextAreaElement>("Reply…");
  }

  function typeReply(field: HTMLTextAreaElement, text: string): void {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(field.value).toBe(text);
  }

  // The archive path to the same read-only rail is the unsent-reply test below.
  it("keeps open and expanded resolved conversations readable without write actions while the room is not writable, then restores them", async () => {
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    let resolvedId = "";
    await act(async () => {
      addComment(ydoc, threadId, "Peer", "open reply");
      resolvedId = createAnnotation(ydoc, getBlocks(ydoc)[0]!.id, 20, 25, "Peer", "why jumps?").id;
      addComment(ydoc, resolvedId, "Reader", "resolved reply");
      setAnnotationResolved(ydoc, resolvedId, true);
    });
    const open = threadCard(host);
    const resolved = threadCard(host, "jumps");
    // A collapsed resolved card has no actions even when writable. Expand
    // first so removing the read-only gate cannot pass this test vacuously.
    await act(async () => threadButton(resolved).click());
    expect(threadButton(resolved).getAttribute("aria-expanded")).toBe("true");
    expect(button(open, "Reply")).toBeDefined();
    expect(button(open, "Resolve")).toBeDefined();
    expect(button(resolved, "Reopen")).toBeDefined();
    const before = [...Y.encodeStateAsUpdate(ydoc)];

    await act(async () => emitStatus(roomForDoc(WORKSPACE, UUID), { writable: false }));

    for (const [item, excerpt, comments] of [
      [open, "quick brown", ["why quick?", "open reply"]],
      [resolved, "jumps", ["why jumps?", "resolved reply"]],
    ] as const) {
      expect(within(item).getByText(excerpt).textContent).toBe(excerpt);
      expect(within(item).getAllByRole("time").map((time) =>
        within(time.parentElement!.parentElement!).getByText((text) => comments.some((comment) => comment === text)).textContent,
      )).toEqual(comments);
      for (const label of ["Reply", "Resolve", "Reopen"]) {
        expect(findButton(item, label)).toBeNull();
      }
      expect(within(item).queryByPlaceholderText("Reply…")).toBeNull();
    }
    expect(threadButton(resolved).getAttribute("aria-expanded")).toBe("true");
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);

    await act(async () => emitStatus(roomForDoc(WORKSPACE, UUID), { writable: true }));
    expect(button(open, "Reply")).toBeDefined();
    expect(button(open, "Resolve")).toBeDefined();
    expect(button(resolved, "Reopen")).toBeDefined();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    });

  it("lets an unsent reply go on archive, without writing or reviving it on Restore", async () => {
    const { host, ydoc } = await openAnnotatedDoc();
    const item = threadCard(host);
    await act(async () => button(item, "Reply").click());
    typeReply(replyField(item), "Unsent draft");
    const before = [...Y.encodeStateAsUpdate(ydoc)];

    await act(async () => tombstoneDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, UUID));
    expect(within(item).queryByPlaceholderText("Reply…")).toBeNull();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    await act(async () => button(host, "Restore").click());
    expect(within(item).queryByPlaceholderText("Reply…")).toBeNull();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    await act(async () => button(item, "Reply").click());
    expect(replyField(item).value).toBe("");
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
  });

  it("refuses Reply when the room stops being writable before the rail re-renders", async () => {
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    const item = threadCard(host);
    await act(async () => button(item, "Reply").click());
    const field = replyField(item);
    typeReply(field, "Reply from the stale form");
    const submit = button(item, "Reply");
    expect(submit.disabled).toBe(false);
    const before = [...Y.encodeStateAsUpdate(ydoc)];
    const name = roomForDoc(WORKSPACE, UUID);
    // Change only the imperative reading. With no status notification, the
    // rail still offers the action and must refuse in its write handler.
    roomStatus.set(name, { ...room(name).status, writable: false });
    expect(button(item, "Reply")).toBe(submit);
    await act(async () => submit.click());
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    expect(getAnnotation(ydoc, threadId)?.comments).toHaveLength(1);
    expect(replyField(item)).toBe(field);
    expect(field.value).toBe("Reply from the stale form");

    // The same gesture succeeds once writable: the refusal above reached a
    // working handler, rather than an inert or incorrectly queried control.
    await act(async () => {
      emitStatus(name, { writable: true });
      button(item, "Reply").click();
    });
    expect(getAnnotation(ydoc, threadId)?.comments.map(({ text }) => text)).toEqual([
      "why quick?", "Reply from the stale form",
    ]);
  });
});

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

    const card = threadButton(threadCard(host));
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
    const item = threadCard(host);
    const card = threadButton(item);
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(card?.textContent).toContain("why quick?");
    expect(scrolled).toContain(item);
    expect(getAnnotation(ydoc, threadId)?.resolved).toBe(true);
    expect(within(item!).queryByPlaceholderText("Reply…")).toBeNull();
    expect(
      within(item).queryByRole("button", { name: "Reply" }) !== null,
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
    const prose = within(host).getByRole("textbox", { name: "Document content" });
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
    const card = threadButton(threadCard(host));
    expect(document.activeElement).not.toBe(card);
  });
});

describe("the threads rail can be opened where the layout hides it", () => {
  const toggles = new WeakMap<HTMLElement, HTMLButtonElement>();

  function toggle(host: HTMLElement): HTMLButtonElement {
    // Radix hides the app while its modal is open; keep the opener found before
    // that transition so assertions can inspect its expanded state afterward.
    const found = toggles.get(host)
      ?? within(host).getByRole<HTMLButtonElement>("button", { name: /^Threads \d+$/ });
    toggles.set(host, found);
    return found;
  }

  function sheet(): HTMLElement {
    return screen.getByRole("dialog", { name: "Threads" });
  }

  function button(label: string): HTMLButtonElement {
    return within(sheet()).getByRole<HTMLButtonElement>("button", { name: label });
  }

  async function settle(action: () => void): Promise<void> {
    await act(async () => action());
    await act(async () => {
      // Radix restores focus after unmounting its focus scope.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function typeReply(text: string): void {
    const field = within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…");
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

  // Safari's order, which only the IME keyCode still marks as composing.
  it("keeps a composing Escape after compositionend in a drawer reply, then cancels only the form", async () => {
    threadsWidth(true);
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    await settle(() => toggle(host).click());
    await settle(() => button("Reply").click());
    typeReply("日本語の返信");
    const field = within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")!;

    // Radix's capture-phase dismissal runs before the textarea sees Escape.
    await settle(() => composingKey(field, "Escape", true));
    expect(within(sheet()).queryByPlaceholderText("Reply…")).toBe(field);
    expect(field.value).toBe("日本語の返信");
    expect(document.activeElement).toBe(field);
    expect(getAnnotation(ydoc, threadId)?.comments).toHaveLength(1);
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");

    await settle(() => press(field, "Escape"));
    expect(within(sheet()).queryByPlaceholderText("Reply…")).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    await settle(() => button("Reply").click());
    expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe("");
  });

  it("counts threads and lets reply-form Escape cancel only the form", async () => {
    threadsWidth(true);
    const { host } = await openAnnotatedDoc();

    // The unnamed scroll container is the placement contract, not a control.
    expect(toggle(host).closest(".ub-pane")).not.toBeNull();
    expect(toggle(host).textContent).toBe("Threads 1");
    expect(toggle(host).getAttribute("aria-controls")).toBe("ub-rail");
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();

    await settle(() => toggle(host).click());
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    expect(sheet().id).toBe("ub-rail");

    await settle(() => button("Reply").click());
    const field = within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await settle(() => press(field!, "Escape"));
    expect(within(sheet()).queryByPlaceholderText("Reply…")).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");

    const card = threadButton(sheet());
    card?.focus();
    expect(document.activeElement).toBe(card);
    await settle(() => press(card!, "Escape"));
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
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
        const card = threadButton(sheet());
        card!.focus();
        press(card!, "Escape");
      },
    ]) {
      await settle(close);
      expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
      await settle(() => toggle(host).click());
      expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
        "Keep this unsent reply",
      );
    }

    await width.change(false);
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
    expect(within(within(host).getByRole("region", { name: "Threads" })).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );

    // A retained draft is not another request to start replying. While the
    // sheet is closed, resizing must leave the writer in the prose.
    await settle(() => button("Close threads").click());
    const prose = within(host).getByRole("textbox", { name: "Document content" });
    expect(prose).not.toBeNull();
    await settle(() => prose!.focus());
    await width.change(false);
    expect(document.activeElement).toBe(prose);
    expect(within(within(host).getByRole("region", { name: "Threads" })).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
    expect(document.activeElement).toBe(prose);
    await settle(() => toggle(host).click());
    expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );
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
    expect(within(sheet()).queryByRole("button", { name: /orphaned/ })).not.toBeNull();

    await settle(() => button("Close threads").click());
    expect(document.activeElement).toBe(toggle(host));
  });
});

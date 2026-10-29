/**
 * Getting to a comment thread without a mouse, and without a wide window.
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
  createTagCatalogEntry,
  deleteTagCatalogEntry,
  directoryRoom,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  getMeta,
  initDoc,
  roomForDoc,
  setAnnotationResolved,
  settingsRoom,
  setTags,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { ShellThreads } from "../src/ui/shell/ShellThreads.js";
import type { AppShell } from "../src/ui/shell/use-app-shell.js";
import { focusThread, threadsFromDoc } from "../src/ui/comments/threads.js";
import type { AccountIdentity } from "../src/shell/account.js";

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

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
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

function threadButton(item: HTMLElement): HTMLElement {
  return item.querySelector<HTMLButtonElement>(".ub-thread-select") ?? within(item).getByRole("button", { name: "Comment" });
}

function threadCard(host: HTMLElement, excerpt = "quick brown"): HTMLElement {
  const region = within(host).getByRole("region", { name: "Comments" });
  const comment = excerpt === "quick brown" ? "why quick?" : excerpt === "jumps" ? "why jumps?" : excerpt;
  const card = within(region).getAllByRole("group", { name: "Comment" }).find((item) => item.textContent?.includes(comment));
  if (card === undefined) throw new Error(`no comment card: ${comment}`);
  return card;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("comment edit eligibility in the shell", () => {
  const noop = (): void => {};
  function shellFor(connection: RoomConnection, threadId: string): AppShell {
    return {
      rooms: { doc: connection, docStatus: OFFLINE, topic: null, catalog: null, directory: null, deleted: false },
      readings: { archived: false, meta: getMeta(connection.ydoc) },
      environment: { identity: { name: "Reader" }, account: { state: "signed-in", handle: "BK-ONE" } },
      layout: { narrowLayout: false }, history: { active: false }, navigation: { docLinks: null },
      threads: { threads: threadsFromDoc(connection.ydoc), focusedThread: focusThread(null, threadId), threadsOpen: false,
        onFocusThread: noop, setThreadsOpen: noop, setHasReplyDrafts: noop, restoreThreadsFocus: noop },
    } as unknown as AppShell;
  }

  it("offers focused own person and agent comments independently of their author names", async () => {
    const connection = room(roomForDoc(WORKSPACE, UUID));
    initDoc(connection.ydoc, { uuid: UUID, title: "Ownership" });
    const block = appendBlock(connection.ydoc, { type: "paragraph", text: "Prose" });
    const thread = createAnnotation(connection.ydoc, block, 0, 5, "Different display name", "Mine", undefined, { kind: "person", account: "bk-one" });
    addComment(connection.ydoc, thread.id, "Agent", "Agent wrote this", { account: "bk-one", kind: "agent", agent: "codex" });
    addComment(connection.ydoc, thread.id, "Reader", "Someone else's", { kind: "person", account: "peer" });
    addComment(connection.ydoc, thread.id, "Reader", "Legacy comment");
    const shell = shellFor(connection, thread.id);
    const { container, rerender } = await renderSettled(<ShellThreads shell={shell} />);
    expect(within(container).getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    const deletions = within(container).getAllByRole("button", { name: "Delete" });
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.closest(".ub-thread-comment")?.textContent).toContain("Agent wrote this");
    expect(container.querySelector(".ub-thread-select .ub-comment-edit")).toBeNull();
    expect(container.querySelector(".ub-thread-select .ub-comment-delete")).toBeNull();
    shell.threads.focusedThread = null;
    rerender(<ShellThreads shell={shell} />);
    expect(within(container).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it.each(["signed-out", "unavailable", "archived", "unwritable", "decision-without-first-record", "resolved"] as const)("hides Edit and Delete in %s state", async (state) => {
    const connection = room(roomForDoc(WORKSPACE, UUID));
    initDoc(connection.ydoc, { uuid: UUID, title: "Edit access" });
    const block = appendBlock(connection.ydoc, { type: "paragraph", text: "Prose" });
    const thread = createAnnotation(connection.ydoc, block, 0, 5, "Reader", "Own comment", undefined, { kind: "person", account: "bk-one" });
    const shell = shellFor(connection, thread.id);
    if (state === "signed-out" || state === "unavailable") shell.environment.account = { state } as AccountIdentity;
    else if (state === "archived") shell.readings.archived = true;
    else if (state === "unwritable") shell.rooms.docStatus = { ...OFFLINE, writable: false };
    else if (state === "decision-without-first-record") shell.readings.meta = { ...getMeta(connection.ydoc), kind: "decision" };
    else {
      setAnnotationResolved(connection.ydoc, thread.id, true);
      shell.threads.threads = threadsFromDoc(connection.ydoc);
    }
    const { container } = await renderSettled(<ShellThreads shell={shell} />);
    expect(within(container).getByText("Own comment")).toBeDefined();
    expect(within(container).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(container).queryByPlaceholderText("Edit comment…")).toBeNull();
  });

  it("offers an opening Delete only while every reply belongs to the signed-in account", async () => {
    const connection = room(roomForDoc(WORKSPACE, UUID));
    initDoc(connection.ydoc, { uuid: UUID, title: "Deletion access" });
    const block = appendBlock(connection.ydoc, { type: "paragraph", text: "Prose" });
    const thread = createAnnotation(connection.ydoc, block, 0, 5, "Reader", "Own opening", undefined, { account: "bk-one", kind: "person" });
    addComment(connection.ydoc, thread.id, "Agent", "Own reply", { account: "BK-ONE", kind: "agent", agent: "codex" });
    const shell = shellFor(connection, thread.id);
    const { container, rerender } = await renderSettled(<ShellThreads shell={shell} />);
    expect(within(container).getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    addComment(connection.ydoc, thread.id, "Legacy", "No account reply");
    shell.threads.threads = threadsFromDoc(connection.ydoc);
    rerender(<ShellThreads shell={shell} />);
    const actions = within(container).getAllByRole("button", { name: "Delete" });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.closest(".ub-thread-comment")?.textContent).toContain("Own reply");
  });
});

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
    await act(async () => within(host).getByRole("button", { name: "1 resolved" }).click());
    const resolved = threadCard(host, "jumps");
    // Expanded resolved cards stay read-only even when the room is writable.
    await act(async () => threadButton(resolved).click());
    expect(threadButton(resolved).getAttribute("aria-expanded")).toBe("true");
    expect(button(open, "Reply")).toBeDefined();
    expect(button(open, "Resolve")).toBeDefined();
    expect(findButton(resolved, "Reopen")).toBeNull();
    const before = [...Y.encodeStateAsUpdate(ydoc)];

    await act(async () => emitStatus(roomForDoc(WORKSPACE, UUID), { writable: false }));

    for (const [item, comments] of [
      [open, ["why quick?"]],
      [resolved, ["why jumps?", "resolved reply"]],
    ] as const) {
      expect(Array.from(item.querySelectorAll(".ub-thread-text")).map((node) => node.textContent)).toEqual(comments);
      for (const label of ["Reply", "Resolve", "Reopen"]) {
        expect(findButton(item, label)).toBeNull();
      }
      expect(within(item).queryByPlaceholderText("Reply…")).toBeNull();
    }
    expect(threadButton(resolved).getAttribute("aria-expanded")).toBe("true");
    await act(async () => threadButton(open).click());
    expect(Array.from(open.querySelectorAll(".ub-thread-text")).map((node) => node.textContent)).toEqual(["why quick?", "open reply"]);
    expect(within(open).queryByPlaceholderText("Reply…")).toBeNull();
    await act(async () => threadButton(resolved).click());
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);

    await act(async () => emitStatus(roomForDoc(WORKSPACE, UUID), { writable: true }));
    expect(button(open, "Reply")).toBeDefined();
    expect(button(open, "Resolve")).toBeDefined();
    expect(findButton(resolved, "Reopen")).toBeNull();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    });

  it("keeps an unsent reply through archive and Restore without writing it", async () => {
    const { host, ydoc } = await openAnnotatedDoc();
    const item = threadCard(host);
    await act(async () => item.click());
    typeReply(replyField(item), "Unsent draft");
    const before = [...Y.encodeStateAsUpdate(ydoc)];

    await act(async () => tombstoneDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, UUID));
    expect(within(item).queryByPlaceholderText("Reply…")).toBeNull();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    await act(async () => button(host, "Restore").click());
    expect(replyField(item).value).toBe("Unsent draft");
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    await act(async () => item.click());
    expect(replyField(item).value).toBe("Unsent draft");
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
  });

  it("refuses Reply when the room stops being writable before the rail re-renders", async () => {
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    const catalog = room(settingsRoom(WORKSPACE)).ydoc;
    const deleted = createTagCatalogEntry(catalog, "thread-fixture");
    const delayed = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await act(async () => {
      setTags(ydoc, [deleted.id, delayed]);
      deleteTagCatalogEntry(catalog, deleted.id);
    });
    const item = threadCard(host);
    await act(async () => item.click());
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
    expect(getMeta(ydoc).tags).toEqual([delayed]);
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
    expect(span.getAttribute("aria-label")).toBe("Comment");

    span.focus();
    expect(document.activeElement).toBe(span);
    press(span, "Enter");

    const card = threadButton(threadCard(host));
    expect(card).not.toBeNull();
    expect(threadCard(host).textContent).toContain("why quick?");
    expect(document.activeElement).toBe(card);
  });

  it("keeps resolved anchors ordinary text after live updates and redraws", async () => {
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    let span = highlight(host, threadId);
    expect(span.getAttribute("aria-label")).toBe("Comment");
    await act(async () => setAnnotationResolved(ydoc, threadId, true));
    const ordinary = (node: HTMLElement): void => {
      expect(node.getAttribute("role")).toBeNull();
      expect(node.getAttribute("tabindex")).toBeNull();
      expect(node.getAttribute("aria-label")).toBeNull();
      expect(node.getAttribute("title")).toBeNull();
      expect(node.classList.contains("ub-comment")).toBe(false);
    };
    ordinary(span);
    const text = (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    await act(async () => { text.insert(0, "Now "); await Promise.resolve(); });
    span = highlight(host, threadId);
    ordinary(span);
    const before = [...Y.encodeStateAsUpdate(ydoc)];
    await act(async () => span.click());
    expect(within(host).queryByRole("group", { name: "Comment" })).toBeNull();
    expect([...Y.encodeStateAsUpdate(ydoc)]).toEqual(before);
    await act(async () => within(host).getByRole("button", { name: "1 resolved" }).click());
    const card = threadCard(host);
    await act(async () => card.click());
    expect(within(card).queryByPlaceholderText("Reply…")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Reopen" })).toBeNull();
    ordinary(highlight(host, threadId));
    expect(getAnnotation(ydoc, threadId)?.resolved).toBe(true);
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
      ?? within(host).getByRole<HTMLButtonElement>("button", { name: /^Comments \d+$/ });
    toggles.set(host, found);
    return found;
  }

  function sheet(): HTMLElement {
    return screen.getByRole("dialog", { name: "Comments" });
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
  it("keeps a composing Escape after compositionend in a drawer reply, then closes while retaining its draft", async () => {
    threadsWidth(true);
    const { host, ydoc, threadId } = await openAnnotatedDoc();
    await settle(() => toggle(host).click());
    await settle(() => { const card = threadButton(sheet()); card.click(); within(card.closest(".ub-thread")!).getByPlaceholderText<HTMLTextAreaElement>("Reply…").focus(); });
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
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    await settle(() => toggle(host).click());
    expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe("日本語の返信");
  });

  it("counts open comments and lets reply-field Escape close the drawer and restore its opener", async () => {
    threadsWidth(true);
    const { host } = await openAnnotatedDoc();

    // The unnamed scroll container is the placement contract, not a control.
    expect(toggle(host).closest(".ub-pane")).not.toBeNull();
    expect(toggle(host).textContent).toBe("Comments 1");
    expect(toggle(host).getAttribute("aria-controls")).toBe("ub-rail");
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();

    await settle(() => toggle(host).click());
    expect(toggle(host).getAttribute("aria-expanded")).toBe("true");
    expect(sheet().id).toBe("ub-rail");

    await settle(() => { const card = threadButton(sheet()); card.click(); within(card.closest(".ub-thread")!).getByPlaceholderText<HTMLTextAreaElement>("Reply…").focus(); });
    const field = within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await settle(() => press(field!, "Escape"));
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle(host));
    await settle(() => toggle(host).click());
    const card = threadButton(sheet());
    card?.focus();
    expect(document.activeElement).toBe(card);
    await settle(() => press(card!, "Escape"));
    expect(toggle(host).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(document.activeElement).toBe(toggle(host));
  });

  it("keeps an unsent reply through dismissal and crossing the rail breakpoint", async () => {
    const width = threadsWidth(true);
    const { host } = await openAnnotatedDoc();
    await settle(() => toggle(host).click());
    await settle(() => { const card = threadButton(sheet()); card.click(); within(card.closest(".ub-thread")!).getByPlaceholderText<HTMLTextAreaElement>("Reply…").focus(); });
    typeReply("Keep this unsent reply");

    for (const close of [
      () => button("Close comments").click(),
      () => {
        const card = threadButton(sheet());
        card!.focus();
        press(card!, "Escape");
      },
    ]) {
      await settle(close);
      expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
      await settle(() => toggle(host).click());
      expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
        "Keep this unsent reply",
      );
    }

    await width.change(false);
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(within(within(host).getByRole("region", { name: "Comments" })).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(within(sheet()).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );

    // A retained draft is not another request to start replying. While the
    // sheet is closed, resizing must leave the writer in the prose.
    await settle(() => button("Close comments").click());
    const prose = within(host).getByRole("textbox", { name: "Document content" });
    expect(prose).not.toBeNull();
    await settle(() => prose!.focus());
    await width.change(false);
    expect(document.activeElement).toBe(prose);
    expect(within(within(host).getByRole("region", { name: "Comments" })).queryByPlaceholderText<HTMLTextAreaElement>("Reply…")?.value).toBe(
      "Keep this unsent reply",
    );
    await width.change(true);
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
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
    expect(within(sheet()).getByText(/text removed/)).not.toBeNull();

    await settle(() => button("Close comments").click());
    expect(document.activeElement).toBe(toggle(host));
  });
});

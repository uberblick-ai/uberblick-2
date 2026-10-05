/**
 * The terminal block: a transcript that plays itself (#843).
 *
 * Four families of contract, and the first one is the reason the other three
 * are allowed to exist at all.
 *
 * 1. **Playing writes nothing.** Whatever the panel is doing, the block has the
 *    same text and the same stored `rev` afterwards as before. There is no
 *    second copy of the demonstration anywhere: no attribute, no transaction,
 *    nothing that could reach another replica.
 * 2. **The grammar and the loop**, which is what a reader is actually shown:
 *    one `$ ` prompt whole, the command typed behind a cursor, output lines
 *    whole, then a hold, a clear and the same run again.
 * 3. **Everything that stops a run.** WCAG 2.2.2 asks for one mechanism a
 *    reader can stop auto-playing content with, and the pause control is it —
 *    the reduced-motion preference, the viewport and the caret each stop a run
 *    for their own reason and none of them substitutes for that control. Every
 *    one of them must also release the scheduled work rather than leave a timer
 *    running behind a panel nobody is looking at.
 * 4. **What assistive technology gets**: the complete transcript, exactly once,
 *    never the animation.
 *
 * Timings are asserted as *order and completeness*, never as numbers: the
 * clock is advanced past whatever the module's constants are, so tuning the
 * pace does not fail a test that was never about the pace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  getBlockRev,
  getBlocks,
  initDoc,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor } from "./helpers.js";

/* ------------------------------------------------- the browser, stood in for */

/**
 * jsdom has neither of the two APIs the block reads the world through, so the
 * suite supplies them and drives them: a run only starts because a test says
 * the panel is on screen, and only degrades because a test says the reader
 * asked for less motion.
 */
interface FakeObserver {
  callback: IntersectionObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

let observers: FakeObserver[] = [];
let onScreen = false;
let reducedMotion = false;
let motionListeners: Set<() => void>;

function notify(observer: FakeObserver, targets: Element[]): void {
  observer.callback(
    targets.map(
      (target) => ({ target, isIntersecting: onScreen }) as IntersectionObserverEntry,
    ),
    null as unknown as IntersectionObserver,
  );
}

function setViewport(visible: boolean): void {
  onScreen = visible;
  for (const observer of observers) notify(observer, observer.targets);
}

const enterViewport = (): void => setViewport(true);
const leaveViewport = (): void => setViewport(false);

function prefersReducedMotion(value: boolean): void {
  reducedMotion = value;
  for (const listener of [...motionListeners]) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  onScreen = false;
  reducedMotion = false;
  motionListeners = new Set();

  class StubObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    private readonly record: FakeObserver;
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.targets.push(target);
      // The real API delivers an initial observation, which is what a NodeView
      // rebuilt mid-run depends on to know it is still on screen.
      notify(this.record, [target]);
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true;
      this.record.targets = [];
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", StubObserver);

  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches(): boolean {
      return query.includes("prefers-reduced-motion") && reducedMotion;
    },
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      motionListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      motionListeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* --------------------------------------------------------------- the fixture */

/** Two commands and their output, plus the blank line between them. */
const TRANSCRIPT = "$ ub init\nworkspace ready\n\n$ ub open";

function docWithTerminal(text: string): { ydoc: Y.Doc; id: string } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "terminal-doc", title: "Demos" });
  // Prose first: the editor's caret starts in the document's first block, and a
  // caret in the terminal block is one of the things that stops a run.
  appendBlock(ydoc, { type: "paragraph", text: "before" });
  const id = appendBlock(ydoc, { type: "terminal", text });
  appendBlock(ydoc, { type: "paragraph", text: "elsewhere" });
  return { ydoc, id };
}

/** The document position just inside the block at `index`. */
function insideBlock(editor: Editor, index: number): number {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos;
}

/**
 * A mounted editor whose own startup timers have already fired, so
 * `vi.getTimerCount()` afterwards counts the block's scheduled steps and
 * nothing else.
 */
function mount(ydoc: Y.Doc): Editor {
  const { editor } = mountEditor(ydoc);
  vi.advanceTimersByTime(1_000);
  return editor;
}

function block(editor: Editor): HTMLElement | null {
  return editor.view.dom.querySelector(".ub-terminal");
}

function screen(editor: Editor): HTMLElement | null {
  return editor.view.dom.querySelector(".ub-terminal-screen");
}

function frame(editor: Editor): HTMLElement | null {
  return editor.view.dom.querySelector(".ub-terminal-frame");
}

/** What the panel is showing, cursor excluded — the cursor is asserted apart. */
function shown(editor: Editor): string {
  const element = frame(editor);
  if (element === null) return "";
  return [...element.childNodes]
    .filter((child) => child.nodeType === child.TEXT_NODE)
    .map((child) => child.textContent)
    .join("");
}

function cursorShowing(editor: Editor): boolean {
  return frame(editor)?.querySelector(".ub-terminal-cursor") !== null;
}

function toggle(editor: Editor): HTMLButtonElement | null {
  return editor.view.dom.querySelector<HTMLButtonElement>(".ub-terminal-toggle");
}

/** The off-screen copy assistive technology reads, or null when there is none. */
function spokenTranscript(editor: Editor): string | null {
  const element = editor.view.dom.querySelector<HTMLElement>(".ub-terminal-transcript");
  return element === null || element.hidden ? null : element.textContent;
}

/**
 * Every distinct frame the panel shows over `ms`, in order. One step at a time,
 * so a frame that is painted and replaced within the same tick is still seen.
 */
function framesOver(editor: Editor, ms: number): string[] {
  const seen: string[] = [shown(editor)];
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    vi.advanceTimersByTime(10);
    const now = shown(editor);
    if (now !== seen[seen.length - 1]) seen.push(now);
  }
  return seen;
}

/* ----------------------------------------------------------------- the tests */

describe("the terminal block", () => {
  it("types commands, shows output whole, loops — and writes nothing doing it", () => {
    const { ydoc, id } = docWithTerminal(TRANSCRIPT);
    const before = getBlocks(ydoc);
    const revBefore = getBlockRev(ydoc, id);
    const editor = mount(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
      // Nothing plays until the panel is on screen — however long nobody looks.
      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe("");

      enterViewport();
      const frames = framesOver(editor, 8_000);

      // The prompt lands whole — never `$` alone — and the command types itself.
      expect(frames).toContain("$ ");
      expect(frames).toContain("$ ub i");
      expect(frames).toContain("$ ub init");
      // Output arrives whole: no frame ever holds a fragment of one.
      expect(frames.filter((f) => f.includes("workspace"))).not.toContain(
        "$ ub init\nworkspa",
      );
      expect(frames).toContain("$ ub init\nworkspace ready\n");
      // The blank line is a step of the transcript, so the second prompt only
      // appears after it.
      expect(frames).toContain("$ ub init\nworkspace ready\n\n$ ub open\n");

      // …then the panel clears and the same run begins again.
      const restart = frames.indexOf("$ ub init\nworkspace ready\n\n$ ub open\n");
      expect(frames.slice(restart)).toContain("");
      expect(frames.slice(restart)).toContain("$ ub init");

      // The document never moved.
      expect(getBlocks(ydoc)).toEqual(before);
      expect(getBlockRev(ydoc, id)).toBe(revBefore);
      // …and the panel is chrome, not content.
      expect(screen(editor)?.getAttribute("contenteditable")).toBe("false");
    } finally {
      editor.destroy();
    }
  });

  it("stops and resumes on its own control, holding the frame it stopped on", () => {
    const { ydoc, id } = docWithTerminal(TRANSCRIPT);
    const revBefore = getBlockRev(ydoc, id);
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(1_000);
      const held = shown(editor);
      expect(held).not.toBe("");

      const control = toggle(editor);
      expect(control?.hidden).toBe(false);
      expect(control?.textContent).toBe("Pause");
      control?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Held: the frame stands and nothing is scheduled behind it.
      expect(control?.textContent).toBe("Play");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe(held);

      // …and the hold survives the panel scrolling away and back. The reader
      // stopped it deliberately, so coming back to a blank panel under a
      // `Play` button would read as a broken block rather than a paused one.
      leaveViewport();
      vi.advanceTimersByTime(1_000);
      enterViewport();
      vi.advanceTimersByTime(1_000);
      expect(shown(editor)).toBe(held);
      expect(control?.textContent).toBe("Play");
      expect(vi.getTimerCount()).toBe(0);

      control?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(control?.textContent).toBe("Pause");
      vi.advanceTimersByTime(2_000);
      expect(shown(editor)).not.toBe(held);

      // Pausing and playing are view state, not document state.
      expect(getBlockRev(ydoc, id)).toBe(revBefore);
    } finally {
      editor.destroy();
    }
  });

  it("shows the whole transcript, unanimated and uncontrolled, under reduced motion", () => {
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(1_000);
      expect(toggle(editor)?.hidden).toBe(false);

      // Switched on mid-run, and answered immediately rather than at the next
      // frame — which is the case WCAG's "including one who enables it" covers.
      prefersReducedMotion(true);
      expect(shown(editor)).toBe(TRANSCRIPT);
      expect(cursorShowing(editor)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // Nothing plays, so there is no control to offer.
      expect(toggle(editor)?.hidden).toBe(true);

      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe(TRANSCRIPT);

      // …and turning it back off restores the demonstration and its control.
      prefersReducedMotion(false);
      expect(toggle(editor)?.hidden).toBe(false);
      vi.advanceTimersByTime(500);
      expect(shown(editor)).not.toBe(TRANSCRIPT);
    } finally {
      editor.destroy();
    }
  });

  it("starts with the whole transcript when reduced motion was already requested", () => {
    prefersReducedMotion(true);
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      expect(shown(editor)).toBe(TRANSCRIPT);
      expect(cursorShowing(editor)).toBe(false);
      expect(toggle(editor)?.hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe(TRANSCRIPT);
    } finally {
      editor.destroy();
    }
  });

  it("gives assistive technology the complete transcript exactly once", () => {
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(600);

      // The animation is hidden from the accessibility tree; the transcript
      // beside it is not, and it is complete however far the run has got.
      expect(frame(editor)?.getAttribute("aria-hidden")).toBe("true");
      expect(spokenTranscript(editor)).toBe(TRANSCRIPT);
      // Nothing is announced as it happens: no live region anywhere in the block.
      expect(block(editor)?.querySelector("[aria-live]")).toBeNull();

      // With the caret in the block the reader is given the editable source,
      // so the copy beside it would be that same transcript a second time.
      editor.commands.setTextSelection(insideBlock(editor, 1));
      expect(spokenTranscript(editor)).toBeNull();
      editor.commands.setTextSelection(insideBlock(editor, 2));
      expect(spokenTranscript(editor)).toBe(TRANSCRIPT);

      // Where the frame is already the whole transcript, the off-screen copy
      // goes — one reading, never two.
      prefersReducedMotion(true);
      expect(frame(editor)?.hasAttribute("aria-hidden")).toBe(false);
      expect(spokenTranscript(editor)).toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it("cancels a stale run when the transcript changes, and restarts from the new text", () => {
    const { ydoc, id } = docWithTerminal("$ old command\ndone");
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(700);
      expect(shown(editor)).toContain("$ old");

      // An agent's edit arrives as an ordinary update.
      editBlock(ydoc, id, "$ old command\ndone", "$ new command\ndone");
      // The stale run is gone, and the new text starts at its own first frame.
      expect(shown(editor)).toBe("$ ");
      vi.advanceTimersByTime(600);
      expect(shown(editor)).toContain("$ new");
      expect(shown(editor)).not.toContain("old");
    } finally {
      editor.destroy();
    }
  });

  it("releases every scheduled step when the panel goes away", () => {
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(500);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      leaveViewport();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe("");

      // Coming back is a fresh run, not the middle of the old one.
      enterViewport();
      expect(shown(editor)).toBe("$ ");

      // Destroying the view releases the step it had scheduled: the panel it
      // would have painted into is detached, and it is never painted again.
      const detached = frame(editor);
      editor.destroy();
      const last = detached?.textContent;
      vi.advanceTimersByTime(20_000);
      expect(detached?.textContent).toBe(last);
      expect(observers.every((observer) => observer.disconnected)).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("stops while the caret is in the block, and starts again from the top when it leaves", () => {
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(900);
      expect(shown(editor)).not.toBe("");

      // The caret in the block is what shows the source, so the demonstration
      // behind it has nothing to demonstrate.
      editor.commands.setTextSelection(insideBlock(editor, 1));
      vi.advanceTimersByTime(20_000);
      expect(shown(editor)).toBe("");

      // Out again, into the paragraph after it — from the top, not the middle.
      editor.commands.setTextSelection(insideBlock(editor, 2));
      expect(shown(editor)).toBe("$ ");
    } finally {
      editor.destroy();
    }
  });

  it("draws an empty transcript as a complete, idle panel", () => {
    const { ydoc } = docWithTerminal("");
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(20_000);
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
      expect(shown(editor)).toBe("");
      expect(vi.getTimerCount()).toBe(0);
      expect(toggle(editor)?.hidden).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("keeps an annotated block as its source, so the anchor stays visible", () => {
    const { ydoc, id } = docWithTerminal(TRANSCRIPT);
    createAnnotation(ydoc, id, 0, 7, "reviewer", "which init?");
    const editor = mount(ydoc);
    try {
      enterViewport();
      vi.advanceTimersByTime(20_000);
      expect(block(editor)?.getAttribute("data-rendered")).toBe("false");
      expect(shown(editor)).toBe("");
    } finally {
      editor.destroy();
    }
  });

  it("hands the caret to the source when the panel is activated", () => {
    const { ydoc } = docWithTerminal(TRANSCRIPT);
    const editor = mount(ydoc);
    try {
      enterViewport();
      const panel = screen(editor);
      expect(panel?.getAttribute("role")).toBe("button");
      expect(panel?.getAttribute("tabindex")).toBe("0");
      expect(panel?.getAttribute("aria-label")).toMatch(/transcript/i);

      panel?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      const { $head } = editor.state.selection;
      expect($head.parent.type.name).toBe("terminal");
    } finally {
      editor.destroy();
    }
  });
});

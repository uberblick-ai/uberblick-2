/**
 * Persist transcript text only; playback state is local chrome and survives
 * neither reload nor synchronization. Lines starting `$ ` are typed commands;
 * other lines, including blanks, appear whole. Timings are fixed and there is no
 * escape for output beginning `$ `.
 *
 * Keep a persistent keyboard-reachable pause/play button for animation. Manual
 * pause retains its frame/generator across scrolling. Offscreen or source-editing
 * playback restarts at the top; annotation marks force source mode. Live reduced
 * motion, no IntersectionObserver or no content shows the complete static text.
 *
 * Keep at most one timer, cleared on every stop path, and generate frames lazily.
 * Expose the complete transcript exactly once to assistive technology; hide
 * animation, remove its offscreen copy when static/source is visible, and use no
 * live region. Async writes stay in ignored chrome, never the root element.
 */

import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Plugin } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import {
  copyButton,
  selectedBlock,
  sourceEditingPlugin,
  terminalChrome,
} from "./source-chrome.js";

/** On the terminal block whose source the reader is editing. */
const EDITING_CLASS = "ub-terminal-editing";

/** What marks a line as a command rather than output. */
const PROMPT = "$ ";

/** The pace, fixed: a reader follows it, nobody authors it. */
const TYPE_MS = 45;
const PROMPT_MS = 320;
const OUTPUT_MS = 360;
/** How long the finished transcript stands before the panel clears. */
const LOOP_MS = 2_400;
/** …and how long it stands empty before the same run begins again. */
const BLANK_MS = 500;

/* -------------------------------------------------------------------- steps */

/** One painted frame, and how long it stands before the next one. */
interface Step {
  text: string;
  cursor: boolean;
  delay: number;
}

/**
 * Generate frames lazily: a long command must not allocate its entire animation.
 * Restart creates a new generator from the beginning.
 */
export function* transcriptSteps(transcript: string): Generator<Step> {
  let committed = "";
  for (const line of transcript.split("\n")) {
    if (line.startsWith(PROMPT)) {
      const typed = line.slice(PROMPT.length);
      yield { text: committed + PROMPT, cursor: true, delay: PROMPT_MS };
      for (let i = 1; i <= typed.length; i += 1) {
        yield {
          text: committed + PROMPT + typed.slice(0, i),
          cursor: true,
          delay: TYPE_MS,
        };
      }
      // A completed command loses its cursor before the output pause.
      committed += `${line}\n`;
      yield { text: committed, cursor: false, delay: OUTPUT_MS };
    } else {
      committed += `${line}\n`;
      yield { text: committed, cursor: false, delay: OUTPUT_MS };
    }
  }
  // Keep the blank as a timed frame so a loop restart is visible.
  yield { text: committed, cursor: false, delay: LOOP_MS };
  yield { text: "", cursor: false, delay: BLANK_MS };
}

/** Whether there is anything to play. Whitespace alone is an idle panel. */
function playable(transcript: string): boolean {
  return transcript.trim() !== "";
}

/** Whether any of the block's text carries an annotation's anchor. */
function carriesComment(node: ProseMirrorNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.marks.some((mark) => mark.type.name === COMMENT_MARK)) found = true;
  });
  return found;
}

/* ------------------------------------------------------------------ nodeview */

/**
 * Keep playback, controls and transcript inside the NodeView's owned chrome.
 */
export const terminalBlockView: NodeViewRenderer = ({
  node,
  editor,
  getPos,
}: NodeViewRendererProps): NodeView => {
  let current: ProseMirrorNode = node;

  const dom = terminalChrome.root();
  const contentDOM = terminalChrome.content();

  // Rendered output hides source, so opening it needs a named keyboard control.
  const screen = document.createElement("div");
  screen.className = "ub-terminal-screen";
  screen.setAttribute("contenteditable", "false");
  screen.setAttribute("role", "button");
  screen.setAttribute("tabindex", "0");
  screen.setAttribute("aria-label", "Terminal demonstration — open its transcript");

  const frame = document.createElement("pre");
  frame.className = "ub-terminal-frame";
  const cursor = document.createElement("span");
  cursor.className = "ub-terminal-cursor";
  screen.append(frame);

  // The one thing assistive technology reads while the frame is animating.
  const spoken = document.createElement("pre");
  spoken.className = "ub-terminal-transcript ub-sr-only";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ub-terminal-toggle";
  toggle.setAttribute("contenteditable", "false");

  const copy = copyButton(() => current.textContent);
  dom.append(screen, spoken, toggle, copy.element, contentDOM);

  /** Cleared on every stop path; at most one is ever outstanding. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let steps: Generator<Step> | null = null;
  let paused = false;
  let onScreen = false;

  const motion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const observable = typeof IntersectionObserver === "function";
  /** Whether this panel animates at all, as opposed to standing complete. */
  const animates = (): boolean => observable && motion?.matches !== true;

  const paint = (text: string, showCursor = false): void => {
    frame.replaceChildren(document.createTextNode(text));
    if (showCursor) frame.append(cursor);
  };

  /**
   * Write only on change; even identical setAttribute calls emit root mutations.
   */
  const setRendered = (value: boolean): void => {
    const next = String(value);
    if (dom.getAttribute("data-rendered") !== next) {
      dom.setAttribute("data-rendered", next);
    }
  };

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const play = (): void => {
    stop();
    if (steps === null) steps = transcriptSteps(current.textContent);
    let next = steps.next();
    if (next.done === true) {
      // The pass is over, so the same one begins again — a fresh generator is
      // also why a restart is always from the top.
      steps = transcriptSteps(current.textContent);
      next = steps.next();
      if (next.done === true) return;
    }
    paint(next.value.text, next.value.cursor);
    // Timer callbacks must enter the same failure boundary as the first frame.
    timer = setTimeout(() => guarded(play), next.value.delay);
  };

  /** Whether the reader's caret is in *this* block — the stylesheet's rule. */
  const beingEdited = (): boolean => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return false;
    return selectedBlock(editor.state, "terminal")?.pos === pos;
  };

  /**
   * Mirror root attrs only inside a PM update, while its DOM observer is stopped.
   * Async root writes cannot be ignored and cause rebuild/callback loops. Playback
   * may write only inside screen, toggle and spoken, whose mutations are ignored.
   */
  const renderChrome = (): void => {
    terminalChrome.sync(current, dom);
    setRendered(!carriesComment(current));
    spoken.textContent = current.textContent;
  };

  /**
   * Centralize all stop conditions so no entry path omits one.
   */
  const sync = (): void => {
    const transcript = current.textContent;
    const drawn = !carriesComment(current);
    /** Whether the stylesheet is showing the source instead of the panel. */
    const sourceShown = !drawn || beingEdited();

    if (!animates() || !playable(transcript)) {
      // Static text needs no animation control or duplicate accessible transcript.
      stop();
      steps = null;
      toggle.hidden = true;
      spoken.hidden = true;
      frame.removeAttribute("aria-hidden");
      paint(transcript);
      return;
    }

    toggle.hidden = false;
    // Visible source is already readable; remove the duplicate accessible transcript.
    spoken.hidden = sourceShown;
    frame.setAttribute("aria-hidden", "true");
    toggle.textContent = paused ? "Play" : "Pause";
    toggle.title = paused
      ? "Play this terminal demonstration"
      : "Pause this terminal demonstration";

    if (paused) {
      // Manual pause takes precedence over viewport restart and retains its frame.
      stop();
      return;
    }
    if (sourceShown || !onScreen) {
      // Automatic stops restart from the beginning when output becomes visible.
      stop();
      steps = null;
      paint("");
      return;
    }
    if (timer === null) play();
  };

  /**
   * Catch failures from every entry point so NodeView updates cannot break the
   * editor. The degraded fallback uses only DOM primitives to avoid another throw.
   */
  const guarded = (run: () => void): void => {
    try {
      run();
    } catch (error) {
      console.error("uberblick: rendering a terminal block failed", error);
      stop();
      steps = null;
      setRendered(false);
      toggle.hidden = true;
    }
  };

  /** Reconcile playback alone — safe from an asynchronous callback. */
  const settle = (): void => guarded(sync);

  /** Reconcile the chrome as well: only from inside a ProseMirror update. */
  const settleNode = (): void => guarded(() => {
    renderChrome();
    sync();
  });

  const onToggle = (event: Event): void => {
    event.preventDefault();
    paused = !paused;
    settle();
  };
  toggle.addEventListener("mousedown", (event) => event.preventDefault());
  toggle.addEventListener("click", onToggle);

  // Opening source must explicitly place its caret.
  const open = (event: Event): void => {
    event.preventDefault();
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return;
    const { view } = editor;
    const inside = view.state.doc.resolve(pos + 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(inside)));
    view.focus();
  };
  const openByKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") open(event);
  };
  screen.addEventListener("mousedown", open);
  screen.addEventListener("keydown", openByKey);

  const onMotionChange = (): void => settle();
  motion?.addEventListener("change", onMotionChange);

  // A selection-only transaction moves no node, so the NodeView is not updated
  // for it — and the caret entering this block is exactly such a transaction.
  const onSelection = (): void => settle();
  editor.on("selectionUpdate", onSelection);

  const watcher = observable
    ? new IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        settle();
      })
    : null;
  watcher?.observe(screen);

  settleNode();

  return {
    dom,
    contentDOM,
    update(updated: ProseMirrorNode): boolean {
      if (updated.type !== current.type) return false;
      // See source-chrome.ts: a contentDOM the browser's editing engine has
      // taken out of the tree cannot be patched in place.
      if (contentDOM.parentNode !== dom) return false;
      const changed = updated.textContent !== current.textContent;
      current = updated;
      // Source changes invalidate playback; restart from the new transcript.
      if (changed) {
        stop();
        steps = null;
      }
      settleNode();
      return true;
    },
    // The panel's own events and the two buttons'. Everything else — a click in
    // the source, the padding around it — must reach ProseMirror and place the
    // caret.
    stopEvent: (event: Event): boolean => {
      if (!(event.target instanceof Node)) return false;
      if (copy.element.contains(event.target)) return true;
      if (toggle.contains(event.target)) return true;
      if (screen.contains(event.target)) {
        return event.type === "mousedown" || event.type === "keydown";
      }
      return false;
    },
    // Ignore owned frame/transcript/control mutations only; source mutations
    // must reach ProseMirror for document updates and DOM repair.
    ignoreMutation: (mutation: { target: Node }): boolean =>
      screen.contains(mutation.target) ||
      spoken.contains(mutation.target) ||
      toggle.contains(mutation.target) ||
      copy.element.contains(mutation.target),
    destroy: () => {
      stop();
      watcher?.disconnect();
      motion?.removeEventListener("change", onMotionChange);
      editor.off("selectionUpdate", onSelection);
      toggle.removeEventListener("click", onToggle);
      screen.removeEventListener("mousedown", open);
      screen.removeEventListener("keydown", openByKey);
    },
  };
};

/** Tiptap wrapper around the terminal block's one plugin. */
export const TerminalBlocks = Extension.create({
  name: "uberblickTerminalBlocks",
  addProseMirrorPlugins(): Plugin[] {
    return [sourceEditingPlugin("terminal", EDITING_CLASS)];
  },
});

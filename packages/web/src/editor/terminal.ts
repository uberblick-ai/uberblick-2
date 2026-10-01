/**
 * The terminal block: an authored transcript that plays itself (#843).
 *
 * The block is source text, like `code`, `mermaid` and `table`, and its
 * Y.XmlText is the only representation of the demonstration. Playback derives a
 * frame from that text and paints it into the NodeView's own chrome: no
 * attribute is written on the node, no transaction is dispatched, and nothing
 * about where a run had got to travels between clients or survives a reload.
 * Two readers of the same block see the same demonstration because they see the
 * same text, not because anything synchronises the animation.
 *
 * ## The grammar
 *
 * One line, one step. A line beginning `$ ` is a command: the panel shows the
 * one `$ ` prompt whole and then types the rest of the line character by
 * character behind a visible cursor. Every other line — blank lines included —
 * is output that appears whole after a short pause. That is the entire format:
 * no authored timings, and no escape, so output that itself begins with `$ `
 * cannot be written in this version.
 *
 * ## What stops a run, and why every one of them matters
 *
 * WCAG 2.2.2 (Pause, Stop, Hide) governs content that starts moving by itself
 * and keeps moving. The mechanism it asks for is {@link toggleButton} — one
 * persistent, keyboard-reachable native button per panel. Focusing the block,
 * or scrolling it away, is *not* that mechanism, so both exist for their own
 * reasons and neither substitutes for the control:
 *
 * - **the reader paused it.** Held frame, held generator: play resumes where
 *   pause left off, and scrolling away and back does not throw that away — a
 *   panel that came back blank under a `Play` button would read as broken
 *   rather than paused.
 * - **`prefers-reduced-motion: reduce`**, watched live so a reader who turns it
 *   on mid-run is answered immediately. Nothing plays, so there is no control
 *   to offer and the panel shows the complete transcript instead.
 * - **off screen**, via `IntersectionObserver`: a demonstration nobody can see
 *   is a timer nobody needs. A run that was playing comes back from the top; a
 *   run the reader paused is held, per the bullet above. A browser without the
 *   observer never animates — the static transcript is the honest fallback,
 *   not an unpaced run.
 * - **the caret is in the block**, which is also when the stylesheet swaps the
 *   panel for the source. Coming back is a fresh run from the top, because the
 *   text the reader just edited is the text the demonstration is of.
 * - **the block carries a `comment` anchor.** A picture over the text hides the
 *   range an annotation is anchored in, so an annotated block stays source.
 *
 * Exactly one timer is outstanding at any moment, whatever the transcript's
 * length: {@link play} schedules the next step from the current one and every
 * stop path clears it. Frames are produced lazily by a generator, so a long
 * transcript costs no more memory than a short one.
 *
 * ## What a screen reader gets
 *
 * The complete transcript, once, as static text — never the animation. The
 * animated frame is `aria-hidden`, and the transcript beside it is off-screen
 * text that stays in the accessibility tree. Where the frame is *already* the
 * complete transcript (reduced motion, no observer, nothing to play) the
 * off-screen copy is removed instead, so there is exactly one at all times and
 * no live region anywhere.
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
 * The frames of one pass over the transcript, in order.
 *
 * A generator rather than an array: a thousand-character command is a thousand
 * frames, and only one of them is ever on screen. Restarting is a fresh
 * generator, which is also why a run always resumes from the top.
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
      // The command is finished, so the cursor leaves it — and the pause before
      // whatever answers it is this frame's own.
      committed += `${line}\n`;
      yield { text: committed, cursor: false, delay: OUTPUT_MS };
    } else {
      committed += `${line}\n`;
      yield { text: committed, cursor: false, delay: OUTPUT_MS };
    }
  }
  // The finished transcript stands, then the panel clears. The blank is a frame
  // rather than a side effect of restarting, because a reader has to *see* the
  // run start again rather than watch it jump back to its first line.
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
 * `<div class="ub-terminal" data-block-type="terminal" data-rendered="…">`
 * holding the panel, the pause/play control, the copy button, and the
 * transcript all of it came from.
 */
export const terminalBlockView: NodeViewRenderer = ({
  node,
  editor,
  getPos,
}: NodeViewRendererProps): NodeView => {
  let current: ProseMirrorNode = node;

  const dom = terminalChrome.root();
  const contentDOM = terminalChrome.content();

  // The panel is the control that opens the source: the drawn representation
  // hides the text, so reaching the text has to be a named, keyboard-reachable
  // thing to do.
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
   * `data-rendered`, written only when it actually changes.
   *
   * The guard is not a micro-optimisation: `setAttribute` reports a mutation
   * even when the value is unchanged, and a mutation on the node's own element
   * is what {@link renderChrome} explains the cost of.
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
    // Through the boundary, not raw: every later step of a run is a fresh call
    // stack of its own, and a throw on one of them must degrade the panel the
    // same way a throw on the first one does.
    timer = setTimeout(() => guarded(play), next.value.delay);
  };

  /** Whether the reader's caret is in *this* block — the stylesheet's rule. */
  const beingEdited = (): boolean => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return false;
    return selectedBlock(editor.state, "terminal")?.pos === pos;
  };

  /**
   * The block's own attributes, mirrored onto the NodeView's root.
   *
   * **Only ever called from inside a ProseMirror update**, and that is
   * load-bearing rather than tidy. ProseMirror's DOM observer is stopped for
   * the duration of an update, so a write here is invisible to it; the same
   * write from an asynchronous callback — the intersection observer, the media
   * query — is a mutation on the node's own element, which `ignoreMutation`
   * cannot answer for and which makes ProseMirror rebuild the whole NodeView.
   * That rebuild starts a fresh observer whose first callback writes again, and
   * the block never draws at all (observed against Chromium, #843). Everything
   * playback touches lives inside `screen`, `toggle` or `spoken` instead, all
   * of which `ignoreMutation` does answer for.
   */
  const renderChrome = (): void => {
    terminalChrome.sync(current, dom);
    setRendered(!carriesComment(current));
    spoken.textContent = current.textContent;
  };

  /**
   * Reconcile the panel with the block and with everything outside it. Every
   * reason a run stops meets here, so there is one predicate rather than five
   * places that each remember four of them.
   */
  const sync = (): void => {
    const transcript = current.textContent;
    const drawn = !carriesComment(current);
    /** Whether the stylesheet is showing the source instead of the panel. */
    const sourceShown = !drawn || beingEdited();

    if (!animates() || !playable(transcript)) {
      // Nothing plays, so there is no control to offer (WCAG 2.2.2 asks for one
      // only where content moves) and the frame *is* the transcript — which
      // makes the off-screen copy a second reading of the same text.
      stop();
      steps = null;
      toggle.hidden = true;
      spoken.hidden = true;
      frame.removeAttribute("aria-hidden");
      paint(transcript);
      return;
    }

    toggle.hidden = false;
    // The off-screen copy is the *animation's* stand-in. Where the stylesheet
    // shows the editable source instead, that source is the reading, and the
    // copy beside it is the same transcript announced twice.
    spoken.hidden = sourceShown;
    frame.setAttribute("aria-hidden", "true");
    toggle.textContent = paused ? "Play" : "Pause";
    toggle.title = paused
      ? "Play this terminal demonstration"
      : "Pause this terminal demonstration";

    if (paused) {
      // Before the viewport: a reader who deliberately stopped the run keeps
      // the frame they stopped on, whatever they scroll past in the meantime.
      stop();
      return;
    }
    if (sourceShown || !onScreen) {
      // Out of sight is a fresh run when it comes back: the reader who edited
      // the transcript, or scrolled away and back, is owed the demonstration
      // from its start rather than its middle.
      stop();
      steps = null;
      paint("");
      return;
    }
    if (timer === null) play();
  };

  /**
   * The boundary. Every entry point runs on the update ProseMirror is in the
   * middle of, and one throw from any of it bricks the editor for every client
   * of the document, so the catch is total. Nothing but DOM primitives runs
   * in the catch, so the degraded state cannot fail too.
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

  // Clicking the panel is how a reader opens the source, and the caret has to
  // be put there explicitly — see the same comment in table.ts.
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
      // An edit during a run makes that run stale: it is of text nobody has any
      // more, so it is cancelled and the new text starts from the top.
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
    // Ours, all three: the frame is repainted from the document, the off-screen
    // transcript is written from the same place, and the buttons rewrite their
    // own labels. Mutations inside the source are ProseMirror's and are
    // deliberately not ignored — see the warning in source-chrome.ts.
    ignoreMutation: (mutation: { target: Node }): boolean =>
      screen.contains(mutation.target) ||
      spoken.contains(mutation.target) ||
      toggle.contains(mutation.target) ||
      copy.element.contains(mutation.target),
    destroy: () => {
      stop();
      copy.destroy();
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

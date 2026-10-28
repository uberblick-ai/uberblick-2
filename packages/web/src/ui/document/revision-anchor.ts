import { alignRevisionSides } from "../../editor/revision-split.js";
import type { Editor } from "@tiptap/core";
import type { RevisionRow } from "../../editor/revision-split.js";

export interface RevisionComparisonView {
  readonly model: { rows: readonly RevisionRow[] };
  before?: Editor;
  after: Editor;
  expand: (run: number) => void;
  setCollapse: (collapse: boolean) => void;
}

export interface RevisionRowHold {
  /** Correct the settled layout before row motion is applied. */
  align: () => { key: string; top: number } | null;
  /** Keep correcting while drawings and row motion settle. */
  follow: () => void;
  stop: () => void;
}

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Tab"]);
/** Read just below the header, past the preceding row's trailing sliver. */
export const REVISION_READING_INSET = 8;

/**
 * Holds the row crossing the header through one switch transaction. Individual
 * fold bars and all scrolling after the transition keep native anchoring.
 */
export function holdRevisionRow(pane: HTMLElement, header: HTMLElement, comparison: RevisionComparisonView): RevisionRowHold | null {
  const side = comparison.after.view.dom;
  const starts = [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start[data-key]")]
    .filter((element) => element.getClientRects().length > 0);
  const line = header.getBoundingClientRect().bottom;
  const reader = starts.find((element) => {
    const end = side.querySelector<HTMLElement>(`:scope > .ub-revision-row-end[data-row="${element.dataset.row}"]`);
    // Native scroll offsets can round by a pixel on WebKit.
    return end !== null && end.getBoundingClientRect().bottom > line + REVISION_READING_INSET + 1;
  }) ?? starts.at(-1);
  const row = reader === undefined ? undefined : comparison.model.rows[Number(reader.dataset.row)];
  if (reader === undefined || row === undefined) return null;
  const originalTop = reader.getBoundingClientRect().top;
  const originalFold = row.fold !== undefined;
  const previousAnchor = pane.style.getPropertyValue("overflow-anchor");
  const previousPriority = pane.style.getPropertyPriority("overflow-anchor");
  pane.style.setProperty("overflow-anchor", "none");
  let stopped = false;
  let frame = 0;
  let stable = 0;
  let height = pane.scrollHeight;
  let scroll = pane.scrollTop;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    pane.removeEventListener("wheel", stop);
    pane.removeEventListener("touchmove", stop);
    pane.removeEventListener("pointerdown", pointerdown, true);
    pane.removeEventListener("keydown", keydown, true);
    if (previousAnchor === "") pane.style.removeProperty("overflow-anchor");
    else pane.style.setProperty("overflow-anchor", previousAnchor, previousPriority);
  };
  const pointerdown = (event: PointerEvent): void => {
    if (event.target instanceof Element && event.target.closest(".ub-revision-ruler") !== null) stop();
  };
  const keydown = (event: KeyboardEvent): void => { if (SCROLL_KEYS.has(event.key)) stop(); };
  pane.addEventListener("wheel", stop, { passive: true });
  pane.addEventListener("touchmove", stop, { passive: true });
  pane.addEventListener("pointerdown", pointerdown, true);
  pane.addEventListener("keydown", keydown, true);

  const align = (): { key: string; top: number } | null => {
    if (stopped) return null;
    if (!pane.isConnected || !side.isConnected) { stop(); return null; }
    const replacement = comparison.model.rows.find((current) => current.at === row.at
      || (current.fold !== undefined && current.fold.run <= row.at && row.at < current.fold.run + current.fold.count));
    if (replacement === undefined) { stop(); return null; }
    const key = `${replacement.fold === undefined ? "row" : "fold"}-${replacement.at}`;
    const target = side.querySelector<HTMLElement>(`:scope > .ub-revision-row-start[data-key="${key}"]`);
    if (target === null) { stop(); return null; }
    // A bar replacing a partly hidden row must be reachable below the header.
    const top = replacement.fold !== undefined && !originalFold ? Math.max(originalTop, line) : originalTop;
    if (comparison.before !== undefined) alignRevisionSides(comparison.before.view, comparison.after.view);
    pane.scrollTop += target.getBoundingClientRect().top - top;
    return { key, top };
  };
  const sides = comparison.before === undefined ? [side] : [comparison.before.view.dom, side];
  const pendingDrawings = (): boolean => document.fonts?.status === "loading" || sides.some((element) =>
    [...element.querySelectorAll<HTMLElement>(".ub-wireframe, .ub-ablauf, .ub-chart")].some((drawing) => {
      if (drawing.getClientRects().length === 0) return false;
      const state = drawing.dataset.drawState;
      if (state !== "success" && state !== "error") return true;
      // A detached wireframe can finish drawing before its fitted height exists.
      const fit = state === "success" ? drawing.querySelector<HTMLElement>(".ub-wireframe-fit") : null;
      return fit !== null && fit.getClientRects().length > 0 && fit.getBoundingClientRect().height <= 0;
    }));
  const movingRows = (): boolean => pane.getAnimations({ subtree: true }).some((animation) => {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return (animation.playState === "running" || animation.playState === "paused") && target instanceof Element
      && target.matches(".ub-revision-row-start, .ub-revision-row, .ub-revision-row-end, .ub-revision-ghost");
  });
  const tick = (): void => {
    if (align() === null) return;
    const nextHeight = pane.scrollHeight;
    const nextScroll = pane.scrollTop;
    stable = nextHeight === height && Math.abs(nextScroll - scroll) < 0.5 ? stable + 1 : 0;
    height = nextHeight;
    scroll = nextScroll;
    if (!pendingDrawings() && !movingRows() && stable >= 2) { stop(); return; }
    frame = requestAnimationFrame(tick);
  };
  return { align, follow: () => { if (!stopped) { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); } }, stop };
}

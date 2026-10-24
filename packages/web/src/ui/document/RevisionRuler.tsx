import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactElement } from "react";
import { jsonChangeRows, spanningComparison } from "../../editor/json-compare-panel.js";
import type { RevisionRow } from "../../editor/revision-split.js";
import { FOLD_MOTION } from "./revision-motion.js";

/** The ruler ends this far above the pane's bottom edge. */
const RULER_INSET = 12;

type MarkKind = "same" | "added" | "removed" | "changed" | "fold";
/** Changes stay visible however long the comparison is. */
const MARK_MIN: Record<MarkKind, number> = { same: 2, added: 4, removed: 4, changed: 4, fold: 3 };

interface RulerLayout {
  /** The track, relative to the header it hangs from. */
  top: number;
  height: number;
  marks: { key: string; kind: MarkKind; top: number; height: number }[];
  /** The part of the comparison in view. */
  view: { top: number; height: number };
}

/** What a pointer position on the track means in the scrolling pane. */
interface RulerScale {
  base: number;
  scale: number;
  /** Where the sticky header's bottom edge sits in the pane. */
  headerBottom: number;
  visible: number;
}

/** A row with any change is coloured by its kind, the same rule as previous and next change. */
function markKind(row: RevisionRow): MarkKind {
  if (row.kind === "folded") return "fold";
  if (!row.changed) return "same";
  return row.kind === "added" || row.kind === "removed" ? row.kind : "changed";
}

function measure(scroller: HTMLElement, header: HTMLElement, side: HTMLElement, rows: readonly RevisionRow[]): { layout: RulerLayout; scale: RulerScale } | null {
  const paneTop = scroller.getBoundingClientRect().top;
  const scrolled = (top: number): number => top - paneTop + scroller.scrollTop;
  const starts = [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")];
  const last = [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-end")].at(-1);
  const split = side.closest(".ub-revision-split");
  if (starts.length === 0 || last === undefined || split === null) return null;
  const tops = starts.map((start) => scrolled(start.getBoundingClientRect().top));
  const base = tops[0] ?? 0;
  const end = scrolled(last.getBoundingClientRect().bottom);
  const span = Math.max(1, end - base);
  // The track starts level with the first row while the pane is at its top.
  const naturalBottom = scrolled(split.getBoundingClientRect().top) - (Number.parseFloat(getComputedStyle(header).marginBottom) || 0);
  const gap = base - naturalBottom;
  const headerBottom = header.getBoundingClientRect().bottom - paneTop;
  const height = Math.max(40, scroller.clientHeight - headerBottom - gap - RULER_INSET);
  // A comparison shorter than the track keeps its own scale instead of stretching.
  const scale = height / Math.max(span, height);
  const marks = starts.flatMap((start, index) => {
    const top = tops[index] ?? 0;
    const next = tops[index + 1] ?? end;
    const row = rows[index];
    if (row === undefined) return [];
    const key = `${row.kind}-${row.at}`;
    const own = { key, kind: markKind(row), top: (top - base) * scale, height: Math.max(0, next - top) * scale };
    // A JSON comparison marks each changed row inside it, so a small change in a long block stays small.
    const block = row.after.spanned === true ? spanningComparison(start) : null;
    // Hidden comparisons keep the row's mark until their toggle section opens.
    if (block === null) return [own];
    if (block.getClientRects().length === 0) return [{ ...own, height: Math.max(MARK_MIN[own.kind], own.height) }];
    return [{ ...own, kind: "same" as const }, ...jsonChangeRows(block).map(({ element, kind }, inner) => {
      const rect = element.getBoundingClientRect();
      return { key: `${key}-${inner}`, kind, top: (scrolled(rect.top) - base) * scale, height: rect.height * scale };
    })];
  });
  const viewTop = Math.min(span, Math.max(0, scroller.scrollTop + headerBottom - base));
  const viewBottom = Math.min(span, Math.max(viewTop, scroller.scrollTop + scroller.clientHeight - base));
  return {
    layout: { top: header.offsetHeight + gap, height, marks, view: { top: viewTop * scale, height: (viewBottom - viewTop) * scale } },
    scale: { base, scale, headerBottom, visible: scroller.clientHeight - headerBottom },
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A slim map of the whole comparison at its right edge, like an editor's
 * overview ruler: a faint mark per row, a coloured mark per change, and a box
 * for the part in view. Pressing or dragging scrolls there. It is a pointer
 * shortcut; previous and next change and the scroll keys reach the same places.
 */
export function RevisionRuler({ pane, header, side, rows }: {
  pane: { current: HTMLElement | null }; header: { current: HTMLElement | null };
  side: HTMLElement; rows: readonly RevisionRow[];
}): ReactElement | null {
  const [layout, setLayout] = useState<RulerLayout | null>(null);
  const scale = useRef<RulerScale | null>(null);
  const drag = useRef<{ offset: number } | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const update = useCallback((): void => {
    const scroller = pane.current;
    const top = header.current;
    // A rebuilt side is measured by its own ruler; the detached one would blank this ruler for a frame.
    if (scroller === null || top === null || !side.isConnected) return;
    const measured = measure(scroller, top, side, rows);
    scale.current = measured?.scale ?? null;
    const next = measured?.layout ?? null;
    setLayout((current) => {
      if (next === null) return null;
      const rounded: RulerLayout = {
        top: round(next.top), height: round(next.height),
        marks: next.marks.map((mark) => ({ key: mark.key, kind: mark.kind, top: round(mark.top), height: round(mark.height) })),
        view: { top: round(next.view.top), height: round(next.view.height) },
      };
      return JSON.stringify(rounded) === JSON.stringify(current) ? current : rounded;
    });
  }, [pane, header, side, rows]);
  useEffect(() => {
    const scroller = pane.current;
    if (scroller === null) return;
    let frame = 0;
    // Rows slide for a moment after folding; the marks follow them.
    const until = performance.now() + FOLD_MOTION + 80;
    const tick = (): void => {
      update();
      if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    scroller.addEventListener("scroll", schedule, { passive: true });
    // Late drawings and images grow the sides; the pane and header resize with the window.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const element of [scroller, side, header.current]) if (element != null) observer?.observe(element);
    // Folding inside a JSON comparison moves its marks even when the block keeps its height.
    side.addEventListener("ub-json-compare-render", schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      side.removeEventListener("ub-json-compare-render", schedule);
      observer?.disconnect();
    };
  }, [pane, header, side, update]);
  const scrollTo = (viewTop: number): void => {
    const scroller = pane.current;
    const current = scale.current;
    if (scroller === null || current === null || current.scale <= 0) return;
    scroller.scrollTop = current.base + viewTop / current.scale - current.headerBottom;
  };
  const pointer = (event: PointerEvent<HTMLDivElement>): number => event.clientY - (track.current?.getBoundingClientRect().top ?? 0);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || layout === null) return;
    event.preventDefault();
    const y = pointer(event);
    const inside = y >= layout.view.top && y <= layout.view.top + layout.view.height;
    // Pressing outside the box centres that place; the box then follows the pointer.
    const offset = inside ? y - layout.view.top : layout.view.height / 2;
    drag.current = { offset };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrollTo(y - offset);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null) scrollTo(pointer(event) - drag.current.offset);
  };
  const end = (): void => { drag.current = null; };
  if (layout === null) return null;
  return <div ref={track} className="ub-revision-ruler" aria-hidden="true" data-testid="revision-ruler"
    style={{ top: layout.top, height: layout.height }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}>
    {layout.marks.map((mark) => mark.height <= 0 ? null
      : <span key={mark.key} className="ub-revision-ruler-mark" data-mark={mark.kind}
        style={{ top: mark.top, height: Math.max(MARK_MIN[mark.kind], mark.height - 1.5) }} />)}
    <span className="ub-revision-ruler-view" style={{ top: layout.view.top, height: layout.view.height }} />
  </div>;
}

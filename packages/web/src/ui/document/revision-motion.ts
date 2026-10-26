/**
 * Motion runs over the final document layout. Only the removed ghost copies
 * fill; cancelling or skipping motion leaves exactly the instant state.
 */

export const REVISION_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

export function reducedMotion(): boolean {
  return typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function animate(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  return typeof element.animate === "function" ? element.animate(keyframes, options) : null;
}

interface Box { top: number; left: number; height: number }

/** Where the live header stood the moment history was entered. */
export interface LiveHeader {
  at: number;
  title: (Box & { text: string; fontSize: number }) | null;
  status: Box | null;
  body: Box | null;
}

let remembered: LiveHeader | null = null;
/** Older than this, the click that entered history is not what the person sees arrive. */
const LIVE_HEADER_LIFETIME = 1500;

function box(element: Element | null | undefined): Box | null {
  if (element == null) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, height: rect.height };
}

/** Called by the control that enters history, before the live pane hides. */
export function rememberLiveHeader(control: Element): void {
  const pane = control.closest(".ub-document-pane");
  const title = pane?.querySelector<HTMLTextAreaElement>(".ub-column > .ub-title") ?? null;
  const status = control.closest(".ub-status");
  const titleBox = box(title);
  remembered = {
    at: performance.now(),
    title: title === null || titleBox === null ? null
      : { ...titleBox, text: title.value, fontSize: Number.parseFloat(getComputedStyle(title).fontSize) || 0 },
    status: box(status),
    body: box(status?.nextElementSibling),
  };
}

/** The live header remembered by the click that entered history, once. */
export function takeLiveHeader(): LiveHeader | null {
  const live = remembered;
  remembered = null;
  return live !== null && performance.now() - live.at <= LIVE_HEADER_LIFETIME ? live : null;
}

const MORPH = 450;

interface RevisionHeader {
  title: (Box & { fontSize: number }) | null;
  status: Box | null;
  body: Box | null;
}

const returning = new WeakMap<Element, RevisionHeader>();

/** Read the visible revision before returning hides it, including an interrupted arrival. */
export function rememberRevisionHeader(control: Element | null): void {
  const pane = control?.closest(".ub-document-pane");
  if (pane == null) return;
  returning.delete(pane);
  const revision = pane.parentElement?.querySelector(".ub-revision-pane");
  const header = revision?.querySelector(".ub-revision-header");
  if (header == null) return;
  const title = header.querySelector<HTMLElement>(".ub-revision-title");
  const titleBox = box(title);
  returning.set(pane, {
    title: title === null || titleBox === null ? null : {
      ...titleBox,
      fontSize: Number.parseFloat(getComputedStyle(title).fontSize) * titleBox.height / (title.offsetHeight || 1),
    },
    status: box(header.querySelector(".ub-history-controls")),
    body: box(header.nextElementSibling),
  });
}

/** The live layout and focus return immediately; only their appearance moves from history. */
export function morphToLive(control: Element): () => void {
  const pane = control.closest(".ub-document-pane");
  if (pane === null) return () => {};
  const previous = returning.get(pane);
  returning.delete(pane);
  if (previous === undefined || reducedMotion()) return () => {};
  const animations: (Animation | null)[] = [];
  const run = (element: Element | null, keyframes: Keyframe[]): void => {
    if (element !== null) animations.push(animate(element, keyframes, { duration: MORPH, easing: REVISION_EASE }));
  };
  const title = pane.querySelector(".ub-column > .ub-title");
  if (title !== null && previous.title !== null) {
    const target = title.getBoundingClientRect();
    const size = Number.parseFloat(getComputedStyle(title).fontSize) || 1;
    const scale = previous.title.fontSize / size;
    run(title, [
      { transformOrigin: "0 0", transform: `translate(${previous.title.left - target.left}px, ${previous.title.top - target.top}px) scale(${scale})` },
      { transformOrigin: "0 0", transform: "none" },
    ]);
  }
  const status = control.closest(".ub-status");
  for (const [element, start] of [[status, previous.status], [status?.nextElementSibling ?? null, previous.body]] as const) {
    if (element === null || start === null) continue;
    run(element, [{ transform: `translateY(${start.top - element.getBoundingClientRect().top}px)`, opacity: 0.2 }, { transform: "none", opacity: 1 }]);
  }
  run(pane.querySelector(".ub-column > .ub-doc-meta"), [{ transform: "translateY(-6px)", opacity: 0 }, { transform: "none", opacity: 1 }]);
  return () => { for (const animation of animations) animation?.cancel(); };
}

/** A header morph in progress; parts that arrive with the first revision join it. */
export interface HeaderMorph {
  /** Moves the status row, the comparison and the change controls that are new since the last call. */
  follow: () => void;
  /** Cancels every part at once, so leaving history is never delayed. */
  stop: () => void;
}

const STILL: HeaderMorph = { follow: () => {}, stop: () => {} };

/**
 * Moves the revision header from where the live header stood into place: the
 * title shrinks from the live title's measured position and size, the status
 * row and content follow, and Restore fades in. Parts that mount later, once
 * the first revision has loaded, join at the morph's current time.
 */
export function morphFromLive(live: LiveHeader | null, header: HTMLElement, pane: HTMLElement): HeaderMorph {
  if (live === null || reducedMotion()) return STILL;
  const started = performance.now();
  const animations: (Animation | null)[] = [];
  const moved = new WeakSet<Element>();
  const paneTop = pane.getBoundingClientRect().top;
  // A live part scrolled out of view starts just above the pane instead.
  const from = (start: Box, element: Element): number => Math.max(start.top, paneTop - start.height) - element.getBoundingClientRect().top;
  const run = (element: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions = {}): void => {
    if (element === null || moved.has(element)) return;
    const elapsed = performance.now() - started;
    if (elapsed >= MORPH) return;
    moved.add(element);
    const animation = animate(element, keyframes, { duration: MORPH, easing: REVISION_EASE, ...options });
    if (animation !== null) animation.currentTime = elapsed;
    animations.push(animation);
  };
  const title = header.querySelector<HTMLElement>(".ub-revision-title");
  if (title !== null && live.title !== null) {
    const size = Number.parseFloat(getComputedStyle(title).fontSize) || 1;
    const scale = live.title.fontSize > 0 ? live.title.fontSize / size : 1;
    const dx = live.title.left - title.getBoundingClientRect().left;
    run(title, [{ transform: `translate(${dx}px, ${from(live.title, title)}px) scale(${scale})` }, { transform: "none" }]);
  }
  // Ending without an opacity lands on the control's own, dimmed while restore is unavailable.
  run(header.querySelector(".ub-revision-restore"), [{ transform: "translateY(-6px)", opacity: 0 }, { opacity: 0, offset: 0.25 }, { transform: "none" }]);
  const follow = (): void => {
    const status = header.querySelector(".ub-history-controls");
    if (status !== null && live.status !== null) {
      run(status, [{ transform: `translateY(${from(live.status, status)}px)`, opacity: 0.2 }, { transform: "none", opacity: 1 }]);
    }
    for (const control of header.querySelectorAll(".ub-change-nav, .ub-revision-ruler")) {
      run(control, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }]);
    }
    for (const element of [...(header.parentElement?.children ?? [])].filter((child) => child !== header)) {
      if (live.body === null) run(element, [{ opacity: 0 }, { opacity: 1 }]);
      else run(element, [{ transform: `translateY(${from(live.body, element)}px)`, opacity: 0 }, { transform: "none", opacity: 1 }]);
    }
  };
  follow();
  return { follow, stop: () => { for (const animation of animations) animation?.cancel(); } };
}

const STEP_MOTION = 360;
const STEP_OFFSET = 40;

/**
 * Stepping to another revision slides its content in from the side it lies
 * on, as the title does: an older revision from the left, a newer one from
 * the right. A comparison that is neither, such as changes since a name,
 * only fades in.
 */
export function revealRevision(element: Element, direction: "older" | "newer" | null): void {
  if (reducedMotion()) return;
  const offset = direction === null ? 0 : direction === "older" ? -STEP_OFFSET : STEP_OFFSET;
  animate(element, [{ transform: `translateX(${offset}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
    { duration: STEP_MOTION, easing: REVISION_EASE });
}

/** A row on screen before folding changes, with a copy to fade out if it folds away. */
interface RowGhost { key: string; top: number; bottom: number; copy: Node[] }

/** Each row's top on screen, by its key, and copies of the rows in or near view, per side. */
export interface RowSnapshot {
  positions: ReadonlyMap<string, number>;
  ghosts: RowGhost[][];
}

function rowStarts(side: Element): HTMLElement[] {
  return [...side.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start[data-key]")];
}

/** A row's start widget, its block and its end spacer move together. */
function rowElements(start: HTMLElement): Element[] {
  const elements: Element[] = [start];
  for (let next = start.nextElementSibling; next !== null && !next.classList.contains("ub-revision-row-start"); next = next.nextElementSibling) {
    elements.push(next);
  }
  return elements;
}

/** A new switch starts from its snapshot, including any interrupted row motion. */
export function cancelRowMotion(sides: readonly Element[]): void {
  for (const side of sides) for (const start of rowStarts(side)) {
    for (const element of rowElements(start)) for (const animation of element.getAnimations()) animation.cancel();
  }
}

function nearView(viewport: Element): (top: number, bottom?: number) => boolean {
  const view = viewport.getBoundingClientRect();
  return (top, bottom = top) => bottom > view.top - view.height && top < view.bottom + view.height;
}

function clearGhosts(side: Element): void {
  for (const ghost of side.parentElement?.querySelectorAll(":scope > .ub-revision-ghost") ?? []) ghost.remove();
}

/** Read before folding changes; the sides are aligned, so the last side's tops serve both. */
export function snapshotRows(sides: readonly Element[], viewport: Element): RowSnapshot {
  const near = nearView(viewport);
  const positions = new Map<string, number>();
  const ghosts = sides.map((side) => {
    clearGhosts(side);
    return rowStarts(side).flatMap((start) => {
      const key = start.dataset.key ?? "";
      const elements = rowElements(start);
      const top = start.getBoundingClientRect().top;
      const bottom = elements.at(-1)?.getBoundingClientRect().bottom ?? top;
      positions.set(key, top);
      return key.startsWith("row-") && near(top, bottom) ? [{ key, top, bottom, copy: elements.map((element) => element.cloneNode(true)) }] : [];
    });
  });
  return { positions, ghosts };
}

export const FOLD_MOTION = 380;

/** Consecutive rows that folded away together. */
function ghostRuns(ghosts: readonly RowGhost[]): RowGhost[][] {
  const runs: RowGhost[][] = [];
  for (const ghost of ghosts) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run !== undefined && last !== undefined && Math.abs(ghost.top - last.bottom) <= 1) run.push(ghost);
    else runs.push([ghost]);
  }
  return runs;
}

/**
 * Rows that folded away shrink into their fold bar: a copy of them, clipped,
 * closes from their old height to the bar's while it fades, and the rows
 * below slide up in step. The copy is inert and removed when it ends or the
 * sides rebuild again.
 */
function foldAway(side: Element, ghosts: readonly RowGhost[]): void {
  const host = side.parentElement;
  if (host === null) return;
  const present = new Set(rowStarts(side).map((start) => start.dataset.key));
  const origin = host.getBoundingClientRect().top;
  for (const run of ghostRuns(ghosts.filter((ghost) => !present.has(ghost.key)))) {
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) continue;
    const bar = side.querySelector<HTMLElement>(`:scope > .ub-revision-row-start[data-key="fold-${first.key.slice("row-".length)}"]`);
    const barElements = bar === null ? [] : rowElements(bar);
    const target = bar === null ? 0 : (barElements.at(-1)?.getBoundingClientRect().bottom ?? 0) - bar.getBoundingClientRect().top;
    const ghost = window.document.createElement("div");
    ghost.className = "ub-revision-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.top = `${first.top - origin}px`;
    ghost.style.height = `${last.bottom - first.top}px`;
    ghost.append(...run.flatMap((entry) => entry.copy));
    host.append(ghost);
    const animation = animate(ghost, [{ height: `${last.bottom - first.top}px`, opacity: 1 }, { opacity: 0, offset: 0.4 }, { height: `${Math.max(0, target)}px`, opacity: 0 }],
      { duration: FOLD_MOTION, easing: REVISION_EASE, fill: "forwards" });
    if (animation === null) ghost.remove();
    else animation.onfinish = () => ghost.remove();
  }
}

/**
 * After folding or unfolding changes the rows, slides each row from where it
 * was to where it is now; rows shown again and fold bars fade in where they
 * stand, and rows that folded away close into their bar. Both sides move by
 * the same amount, so rows stay paired.
 */
export function animateRows(sides: readonly Element[], previous: RowSnapshot, viewport: Element): void {
  if (reducedMotion() || previous.positions.size === 0) return;
  const near = nearView(viewport);
  sides.forEach((side, index) => {
    let shift = 0;
    for (const start of rowStarts(side)) {
      const now = start.getBoundingClientRect().top;
      const was = previous.positions.get(start.dataset.key ?? "");
      if (was !== undefined) shift = was - now;
      const fresh = was === undefined;
      if (!near(now) && !near(now + shift)) continue;
      if (!fresh && Math.abs(shift) < 1) continue;
      // Rows shown again appear once the rows below have mostly made room.
      const keyframes: Keyframe[] = fresh
        ? [{ transform: `translateY(${shift}px)`, opacity: 0 }, { opacity: 0, offset: 0.35 }, { transform: "none", opacity: 1 }]
        : [{ transform: `translateY(${shift}px)` }, { transform: "none" }];
      for (const element of rowElements(start)) animate(element, keyframes, { duration: FOLD_MOTION, easing: REVISION_EASE });
    }
    foldAway(side, previous.ghosts[index] ?? []);
  });
}

interface Viewer {
  near: boolean;
  live: boolean;
  pinned: () => boolean;
  load: () => void;
  unload: () => void;
}

/** One budget for the whole page, including documents in separate panes. */
class ViewerBudget {
  readonly viewers = new Set<Viewer>();
  refresh(): void {
    for (const viewer of this.viewers) {
      if (viewer.live && !viewer.near && !viewer.pinned()) {
        viewer.live = false;
        viewer.unload();
      }
    }
    let count = [...this.viewers].filter((viewer) => viewer.live).length;
    if (!navigator.onLine) return;
    for (const viewer of this.viewers) {
      if (count === 3) break;
      if (!viewer.live && viewer.near) {
        viewer.live = true;
        viewer.load();
        count += 1;
      }
    }
  }
}
const budgets = new WeakMap<Document, ViewerBudget>();

export function observeFigma({ dom, scroller, load, unload, pinned }: {
  dom: HTMLElement; scroller: Element | null; load: () => void; unload: () => void; pinned: () => boolean;
}): { refresh: () => void; reset: () => void; destroy: () => void } {
  const owner = dom.ownerDocument;
  let budget = budgets.get(owner);
  if (budget === undefined) { budget = new ViewerBudget(); budgets.set(owner, budget); }
  const currentBudget = budget;
  const viewer: Viewer = { near: false, live: false, pinned, load, unload };
  currentBudget.viewers.add(viewer);
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    // The fullscreen top layer is outside the document scroller. Keep the last
    // document intersection until it returns, including the browser's exit.
    for (const entry of entries) if (entry.target === dom && !pinned()) viewer.near = entry.isIntersecting;
    currentBudget.refresh();
  }, { root: scroller, rootMargin: "600px 0px" });
  observer?.observe(dom);
  const refresh = (): void => currentBudget.refresh();
  owner.defaultView?.addEventListener("online", refresh);
  owner.addEventListener("fullscreenchange", refresh);
  return {
    refresh,
    reset() {
      if (viewer.live) { viewer.live = false; unload(); }
      currentBudget.refresh();
    },
    destroy() {
      observer?.disconnect();
      owner.defaultView?.removeEventListener("online", refresh);
      owner.removeEventListener("fullscreenchange", refresh);
      currentBudget.viewers.delete(viewer);
      if (viewer.live) unload();
      currentBudget.refresh();
    },
  };
}

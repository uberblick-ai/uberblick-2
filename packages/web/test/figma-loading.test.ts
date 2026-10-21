import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeFigma } from "../src/editor/figma-loading.js";

const intersections = new Map<Element, IntersectionObserverCallback>();
const viewers: ReturnType<typeof observeFigma>[] = [];

function near(dom: HTMLElement, visible: boolean): void {
  const rect = dom.getBoundingClientRect();
  intersections.get(dom)!([{
    target: dom, isIntersecting: visible, boundingClientRect: rect,
    intersectionRatio: visible ? 1 : 0, intersectionRect: rect, rootBounds: null, time: 0,
  }], null as unknown as IntersectionObserver);
}

function viewer(initialReady: boolean) {
  const dom = document.createElement("div");
  let isReady = initialReady;
  let isPinned = false;
  const ready = vi.fn(() => isReady);
  const load = vi.fn();
  const unload = vi.fn();
  const observation = observeFigma({ dom, scroller: null, ready, load, unload, pinned: () => isPinned });
  viewers.push(observation);
  return { dom, ready, load, unload, observation,
    setReady(value: boolean) { isReady = value; }, setPinned(value: boolean) { isPinned = value; } };
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void { intersections.set(target, this.callback); }
    disconnect(): void {}
  });
});

afterEach(() => {
  for (const observation of viewers.splice(0)) observation.destroy();
  intersections.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Figma lookup eligibility and viewer budget", () => {
  it("waits for both proximity and a connection before preparing a viewer", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const block = viewer(false);
    block.observation.refresh();
    expect(block.ready).not.toHaveBeenCalled();
    near(block.dom, true);
    expect(block.ready).not.toHaveBeenCalled();
    expect(block.load).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    expect(block.ready).toHaveBeenCalledOnce();
    expect(block.load).not.toHaveBeenCalled();
    block.setReady(true);
    block.observation.refresh();
    expect(block.load).toHaveBeenCalledOnce();
  });

  it("prepares every nearby block without giving pending or private blocks a viewer slot", () => {
    const blocked = viewer(false);
    const first = viewer(true);
    const second = viewer(true);
    const third = viewer(true);
    const fourth = viewer(true);
    near(blocked.dom, true);
    near(first.dom, true);
    near(second.dom, true);
    near(third.dom, true);
    near(fourth.dom, true);
    expect(blocked.load).not.toHaveBeenCalled();
    expect(first.load).toHaveBeenCalledOnce();
    expect(second.load).toHaveBeenCalledOnce();
    expect(third.load).toHaveBeenCalledOnce();
    expect(fourth.ready).toHaveBeenCalled();
    expect(fourth.load).not.toHaveBeenCalled();

    blocked.setReady(true);
    blocked.observation.refresh();
    expect(blocked.load).not.toHaveBeenCalled();
    near(first.dom, false);
    expect(first.unload).toHaveBeenCalledOnce();
    expect(blocked.load).toHaveBeenCalledOnce();
    expect(fourth.load).not.toHaveBeenCalled();
  });

  it("does not load an answer that finishes after its block leaves the nearby area", () => {
    const block = viewer(false);
    near(block.dom, true);
    near(block.dom, false);
    block.setReady(true);
    block.observation.refresh();
    expect(block.load).not.toHaveBeenCalled();
    near(block.dom, true);
    expect(block.load).toHaveBeenCalledOnce();
  });

  it("keeps a fullscreen viewer and its document intersection while counting its live slot", () => {
    const fullscreen = viewer(true);
    near(fullscreen.dom, true);
    fullscreen.setPinned(true);
    near(fullscreen.dom, false);
    const second = viewer(true);
    const third = viewer(true);
    const fourth = viewer(true);
    near(second.dom, true);
    near(third.dom, true);
    near(fourth.dom, true);
    expect(fullscreen.load).toHaveBeenCalledOnce();
    expect(fullscreen.unload).not.toHaveBeenCalled();
    expect(second.load).toHaveBeenCalledOnce();
    expect(third.load).toHaveBeenCalledOnce();
    expect(fourth.load).not.toHaveBeenCalled();
    fullscreen.setPinned(false);
    fullscreen.observation.refresh();
    expect(fullscreen.unload).not.toHaveBeenCalled();
    near(fullscreen.dom, false);
    expect(fullscreen.unload).toHaveBeenCalledOnce();
    expect(fourth.load).toHaveBeenCalledOnce();
  });
});

import Panzoom from "@panzoom/panzoom";
import type { CurrentValues, PanzoomObject } from "@panzoom/panzoom";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Button } from "../ui/shadcn/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/shadcn/dialog.js";
import { writeToClipboard } from "./source-chrome.js";
import "../ui/figure-viewer.css";

interface AblaufViewerOptions {
  drawing: HTMLElement;
  width: number;
  height: number;
  source: () => string;
  editable: boolean;
  openSource: () => void;
  returnFocus: HTMLElement;
}

export interface AblaufViewerHandle {
  close: () => void;
  setEditable: (editable: boolean) => void;
}

const HISTORY_KEY = "ubDiagramViewer";
let nextViewer = 0;

/** Mount derived drawing chrome without making it part of ProseMirror's tree. */
export function openAblaufViewer(options: AblaufViewerOptions): AblaufViewerHandle {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry = ++nextViewer;
  const state: unknown = window.history.state;
  window.history.pushState({ ...(state !== null && typeof state === "object" ? state : {}), [HISTORY_KEY]: entry }, "");
  let disposed = false;
  let closing = false;
  let showSource = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("popstate", popped);
    root.unmount();
    container.remove();
  };
  const popped = (): void => { dispose(); };
  const close = (source = false): void => {
    if (disposed || closing) return;
    closing = true;
    showSource = source;
    // Consume our same-address entry, preserving the document's route state.
    // As with any pushState, opening has already discarded forward entries.
    if (window.history.state?.[HISTORY_KEY] === entry) window.history.back();
    else dispose();
  };
  const render = (): void => { root.render(<AblaufViewer options={options} close={close} restoreFocus={() => {
    if (!options.returnFocus.isConnected) return;
    options.returnFocus.focus({ preventScroll: true });
    if (showSource) options.openSource();
  }} />); };
  window.addEventListener("popstate", popped);
  render();
  return {
    close: () => { close(); },
    setEditable: (editable) => {
      if (disposed || options.editable === editable) return;
      options.editable = editable;
      render();
    },
  };
}

function AblaufViewer({ options, close, restoreFocus }: {
  options: AblaufViewerOptions;
  close: (source?: boolean) => void;
  restoreFocus: () => void;
}): ReactElement {
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const panzoom = useRef<PanzoomObject | null>(null);
  const fit = useRef<() => void>(() => {});
  const manualZoom = useRef<() => void>(() => {});
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = drawing.current;
    if (canvas === null || element === null) return;
    element.append(options.drawing);
    const center = (): void => {
      element.style.marginLeft = `${(canvas.clientWidth - options.width) / 2}px`;
      element.style.marginTop = `${(canvas.clientHeight - options.height) / 2}px`;
    };
    center();
    let fitFloor = 0.25;
    let fitted = true;
    let active = true;
    const instance = Panzoom(element, {
      canvas: true, minScale: 0.25, maxScale: 4, animate: false,
      // A sub-25% Fit is an overview, not a second manual zoom range. Let the
      // library clamp shrinking gestures at Fit; the first growing gesture
      // enters the ordinary range before painting its transform.
      setTransform: (target: HTMLElement | SVGElement, values: CurrentValues) => {
        if (!active || values.scale !== instance.getScale()) return;
        if (values.scale > fitFloor && values.scale < 0.25) {
          instance.setOptions({ minScale: 0.25 });
          instance.zoom(0.25, { animate: false });
          return;
        }
        if (values.scale >= 0.25) instance.setOptions({ minScale: 0.25 });
        target.style.transform = `scale(${values.scale}) translate(${values.x}px, ${values.y}px)`;
        setScale(values.scale);
      },
    });
    panzoom.current = instance;
    fit.current = () => {
      fitted = true;
      center();
      const fittedScale = Math.min(1, Math.max(1, canvas.clientWidth - 32) / options.width,
        Math.max(1, canvas.clientHeight - 32) / options.height);
      fitFloor = Math.min(0.25, fittedScale);
      instance.setOptions({ minScale: fitFloor });
      instance.reset({ startScale: fittedScale, startX: 0, startY: 0, animate: false });
    };
    const manual = (): void => { fitted = false; };
    manualZoom.current = manual;
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY === 0 ? event.deltaX : event.deltaY;
      if (instance.getScale() < 0.25 && delta >= 0) return;
      fitted = false;
      instance.zoomWithWheel(event);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("panzoomstart", manual);
    const resize = new ResizeObserver(() => { center(); if (fitted) fit.current(); });
    resize.observe(canvas);
    fit.current();
    return () => {
      active = false;
      resize.disconnect();
      canvas.removeEventListener("wheel", wheel);
      element.removeEventListener("panzoomstart", manual);
      instance.destroy();
      panzoom.current = null;
      options.drawing.remove();
    };
  }, [options, canvas]);

  const zoom = (direction: 1 | -1): void => {
    const instance = panzoom.current;
    if (instance === null) return;
    const current = instance.getScale();
    if (direction < 0 && current <= 0.25) return;
    manualZoom.current();
    instance.zoom(Math.max(0.25, Math.min(4, current * (direction > 0 ? 1.25 : 0.8))));
  };
  const copy = (): void => {
    void writeToClipboard(options.source(), undefined, content.current ?? undefined).then((copied) => {
      toast[copied ? "success" : "error"](copied ? "Source copied" : "Couldn't copy the source. Select the source text and copy it instead.", { id: "clipboard" });
    });
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="ub-figure-viewer ub-ablauf-viewer" ref={content}
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
      <DialogTitle className="sr-only">Ablauf diagram</DialogTitle>
      <div className="ub-figure-viewer-bar">
        <Button variant="outline" size="sm" aria-label="Close diagram viewer" onClick={() => close()}>Close</Button>
        <output aria-label="Zoom level" className="ub-figure-viewer-zoom">{Math.round(scale * 100)}%</output>
        <Button variant="outline" size="sm" aria-label="Zoom out" onClick={() => zoom(-1)}>−</Button>
        <Button variant="outline" size="sm" aria-label="Zoom in" onClick={() => zoom(1)}>+</Button>
        <Button variant="outline" size="sm" onClick={() => fit.current()}>Fit</Button>
        <span className="ub-figure-viewer-spacer" />
        <Button variant="outline" size="sm" aria-label="Copy ablauf source" onClick={copy}>Copy</Button>
        {options.editable && <Button variant="outline" size="sm" aria-label="Open ablauf source" onClick={() => close(true)}>Source</Button>}
      </div>
      <div className="ub-ablauf-viewer-viewport" ref={setCanvas}>
        <div className="ub-ablauf-viewer-drawing" ref={drawing}
          style={{ width: options.width, height: options.height }} />
      </div>
    </DialogContent>
  </Dialog>;
}

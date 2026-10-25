import Panzoom from "@panzoom/panzoom";
import type { CurrentValues, PanzoomObject } from "@panzoom/panzoom";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Button } from "../ui/shadcn/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/shadcn/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/shadcn/tabs.js";
import { writeToClipboard } from "./source-chrome.js";
import { figureHistory } from "./figure-history.js";
import "../ui/figure-viewer.css";

export interface AblaufDrawing {
  drawing: HTMLElement;
  width: number;
  height: number;
}

export interface AblaufComparison {
  side: "before" | "after";
  other: AblaufDrawing & { source: () => string };
}

interface AblaufViewerOptions extends AblaufDrawing {
  source: () => string;
  editable: boolean;
  openSource: () => void;
  returnFocus: HTMLElement;
  comparison?: AblaufComparison;
}

export interface AblaufViewerHandle {
  close: () => void;
  setEditable: (editable: boolean) => void;
}

/** Mount derived drawing chrome without making it part of ProseMirror's tree. */
export function openAblaufViewer(options: AblaufViewerOptions): AblaufViewerHandle {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let disposed = false;
  let closing = false;
  let showSource = false;
  const history = figureHistory(() => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    container.remove();
  });
  const close = (source = false): void => {
    if (disposed || closing) return;
    closing = true;
    showSource = source;
    history.close();
  };
  const render = (): void => { root.render(<AblaufViewer options={options} close={close} restoreFocus={() => {
    if (!options.returnFocus.isConnected) return;
    options.returnFocus.focus({ preventScroll: true });
    if (showSource) options.openSource();
  }} />); };
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
  const [side, setSide] = useState(options.comparison?.side ?? "after");
  const shown = options.comparison !== undefined && side !== options.comparison.side ? options.comparison.other : options;
  const displayed = useRef(shown);
  displayed.current = shown;

  useLayoutEffect(() => {
    const element = drawing.current;
    if (canvas === null || element === null) return;
    shown.drawing.style.width = `${shown.width}px`;
    shown.drawing.style.height = `${shown.height}px`;
    element.append(shown.drawing);
    return () => { shown.drawing.remove(); };
  }, [shown, canvas]);

  useLayoutEffect(() => {
    const element = drawing.current;
    if (canvas === null || element === null) return;
    // Keep the opening drawing's frame and transform origin across switches.
    // Changing either would move the same diagram coordinates on screen.
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
      const current = displayed.current;
      const fittedScale = Math.min(1, Math.max(1, canvas.clientWidth) / current.width,
        Math.max(1, canvas.clientHeight) / current.height);
      fitFloor = Math.min(0.25, fittedScale);
      instance.setOptions({ minScale: fitFloor });
      instance.reset({ startScale: fittedScale, startX: (options.width - current.width) / 2,
        startY: (options.height - current.height) / 2, animate: false });
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
    void writeToClipboard(shown.source(), undefined, content.current ?? undefined).then((copied) => {
      toast[copied ? "success" : "error"](copied ? "Source copied" : "Couldn't copy the source. Select the source text and copy it instead.", { id: "clipboard" });
    });
  };
  const viewport = <div className="ub-ablauf-viewer-viewport" ref={setCanvas}>
    <div className="ub-ablauf-viewer-drawing" ref={drawing}
      style={{ width: options.width, height: options.height }} />
  </div>;
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <Tabs value={side} onValueChange={(value) => {
      if (value !== "before" && value !== "after") return;
      manualZoom.current();
      setSide(value);
    }}>
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
        {options.comparison !== undefined && <TabsList aria-label="Diagram version" className="ub-ablauf-viewer-switch">
            <TabsTrigger value="before">Before</TabsTrigger>
            <TabsTrigger value="after">After</TabsTrigger>
          </TabsList>}
        <span className="ub-figure-viewer-spacer" />
        <Button variant="outline" size="sm" aria-label="Copy ablauf source" onClick={copy}>Copy</Button>
        {options.editable && <Button variant="outline" size="sm" aria-label="Open ablauf source" onClick={() => close(true)}>Source</Button>}
      </div>
      {options.comparison === undefined ? viewport : <TabsContent value={side} asChild tabIndex={-1}>{viewport}</TabsContent>}
    </DialogContent>
    </Tabs>
  </Dialog>;
}

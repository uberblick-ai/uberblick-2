import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../ui/shadcn/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/shadcn/dialog.js";
import { Input } from "../ui/shadcn/input.js";
import { figureHistory } from "./figure-history.js";
import { jsonChangeStarts, jsonComparePanel, openFoldedChange } from "./json-compare-panel.js";
import type { JsonCompareMatch, JsonComparePanel } from "./json-compare-panel.js";
import "../ui/figure-viewer.css";

interface JsonCompareViewerOptions {
  /** The comparison's identity; the inline block shares what is open with this view. */
  key: string;
  before: string;
  after: string;
  /** Runs once the viewer has gone, to redraw and focus the block. */
  closed: () => void;
}

export interface JsonCompareViewerHandle {
  close: () => void;
}

/** A change this close below the top of the body is the current one. */
const CHANGE_SLACK = 8;

/** Mount the full-screen comparison outside ProseMirror's tree, closing on Back like the Ablauf viewer. */
export function openJsonCompareViewer(options: JsonCompareViewerOptions): JsonCompareViewerHandle {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let disposed = false;
  let closing = false;
  const history = figureHistory(() => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    container.remove();
  });
  const close = (): void => {
    if (disposed || closing) return;
    closing = true;
    history.close();
  };
  root.render(<JsonCompareViewer options={options} close={close} />);
  return { close };
}

/** Where each change starts, relative to the top of the scrolling body. */
function changeOffsets(body: HTMLElement): { top: number; element: HTMLElement }[] {
  const line = body.getBoundingClientRect().top + (body.querySelector<HTMLElement>(".ub-json-compare-heads")?.offsetHeight ?? 0);
  return jsonChangeStarts(body).map((element) => ({ top: element.getBoundingClientRect().top - line, element }));
}

function JsonCompareViewer({ options, close }: { options: JsonCompareViewerOptions; close: () => void }): ReactElement {
  // The dialog portal mounts after this component, so the body arrives through a state ref.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [changes, setChanges] = useState({ previous: false, next: false });
  const measure = useCallback((): void => {
    if (body === null) return;
    const list = changeOffsets(body);
    const end = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    setChanges({ previous: list.some((change) => change.top < -2), next: !end && list.some((change) => change.top > CHANGE_SLACK) });
  }, [body]);
  const measured = useRef(measure);
  measured.current = measure;
  const [panel] = useState<JsonComparePanel>(() => jsonComparePanel(options.key, () => { requestAnimationFrame(() => { measured.current(); }); }));
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<JsonCompareMatch[]>([]);
  const [index, setIndex] = useState(0);

  useLayoutEffect(() => {
    if (body === null) return;
    body.append(panel.grid);
    panel.show(options.before, options.after);
    return () => { panel.grid.remove(); };
  }, [panel, body, options]);
  useEffect(() => {
    if (body === null) return;
    measure();
    body.addEventListener("scroll", measure, { passive: true });
    return () => { body.removeEventListener("scroll", measure); };
  }, [body, measure]);
  useLayoutEffect(() => {
    const found = panel.search(query.trim().toLowerCase());
    setMatches(found);
    setIndex((previous) => Math.min(previous, Math.max(0, found.length - 1)));
  }, [panel, query]);
  useLayoutEffect(() => { panel.reveal(matches[index] ?? null); }, [panel, matches, index]);

  const step = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    setIndex((previous) => (previous + direction + matches.length) % matches.length);
  };
  const searchKeys = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };
  const go = (direction: -1 | 1): void => {
    if (body === null) return;
    const list = changeOffsets(body);
    const target = direction > 0 ? list.find((change) => change.top > CHANGE_SLACK) : list.findLast((change) => change.top < -2);
    if (target === undefined) return;
    openFoldedChange(target.element);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    body.scrollBy({ top: target.top, behavior: reduce ? "auto" : "smooth" });
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="ub-figure-viewer ub-json-tree-viewer ub-json-compare-viewer"
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => { event.preventDefault(); options.closed(); }}>
      <DialogTitle className="sr-only">JSON comparison</DialogTitle>
      <div className="ub-figure-viewer-bar">
        <Button variant="outline" size="sm" aria-label="Close JSON comparison" onClick={close}>Close</Button>
        <Input type="search" className="ub-json-tree-search" placeholder="Search keys and values" aria-label="Search keys and values"
          value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={searchKeys} />
        <output className="ub-json-tree-count" aria-live="polite">
          {query.trim() === "" ? "" : matches.length === 0 ? "No matches" : `${index + 1} of ${matches.length}`}
        </output>
        <Button variant="outline" size="sm" aria-label="Previous match" disabled={matches.length === 0} onClick={() => step(-1)}>↑</Button>
        <Button variant="outline" size="sm" aria-label="Next match" disabled={matches.length === 0} onClick={() => step(1)}>↓</Button>
        <span className="ub-figure-viewer-spacer" />
        <Button variant="outline" size="sm" disabled={!changes.previous} onClick={() => go(-1)}>Previous change</Button>
        <Button variant="outline" size="sm" disabled={!changes.next} onClick={() => go(1)}>Next change</Button>
        <span className="ub-json-compare-viewer-switch" ref={(element) => { element?.append(panel.collapse); }} />
      </div>
      <div className="ub-json-tree-viewer-body ub-json-compare-viewer-body" ref={setBody}>
        <div className="ub-json-compare-heads" aria-hidden="true"><span>Before</span><span>After</span></div>
      </div>
    </DialogContent>
  </Dialog>;
}

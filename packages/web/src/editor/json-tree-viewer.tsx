import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Button } from "../ui/shadcn/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/shadcn/dialog.js";
import { Input } from "../ui/shadcn/input.js";
import { writeToClipboard } from "./source-chrome.js";
import { figureHistory } from "./figure-history.js";
import { jsonTreePanel, jsonTreeViewState } from "./json-tree-panel.js";
import type { JsonTreeMatch, JsonTreePanel } from "./json-tree-panel.js";
import type { JsonTreeItem } from "./json-tree-rows.js";
import "../ui/figure-viewer.css";

interface JsonTreeViewerOptions {
  root: JsonTreeItem;
  source: () => string;
  editable: boolean;
  openEdit: () => void;
  /** Focus the block again; false when it has left the document. */
  returnFocus: () => boolean;
}

export interface JsonTreeViewerHandle {
  close: () => void;
  /** Follow the block: a new tree keeps the viewer's folds and search. */
  update: (root: JsonTreeItem, editable: boolean) => void;
}

/** Mount the viewer outside ProseMirror's tree, closing on Back like the Ablauf viewer. */
export function openJsonTreeViewer(options: JsonTreeViewerOptions): JsonTreeViewerHandle {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const panel = jsonTreePanel(jsonTreeViewState("all"));
  let disposed = false;
  let closing = false;
  let edit = false;
  const history = figureHistory(() => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    container.remove();
  });
  const close = (openEdit = false): void => {
    if (disposed || closing) return;
    closing = true;
    edit = openEdit;
    history.close();
  };
  const restoreFocus = (): void => {
    if (options.returnFocus() && edit) options.openEdit();
  };
  const render = (): void => {
    root.render(<JsonTreeViewer options={options} panel={panel} close={close} restoreFocus={restoreFocus} />);
  };
  render();
  return {
    close: () => { close(); },
    update: (next, editable) => {
      if (disposed) return;
      options.root = next;
      options.editable = editable;
      render();
    },
  };
}

function JsonTreeViewer({ options, panel, close, restoreFocus }: {
  options: JsonTreeViewerOptions;
  panel: JsonTreePanel;
  close: (openEdit?: boolean) => void;
  restoreFocus: () => void;
}): ReactElement {
  // The dialog portal mounts after this component, so the body arrives through a state ref.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<JsonTreeMatch[]>([]);
  const [index, setIndex] = useState(0);

  useLayoutEffect(() => {
    body?.append(panel.element);
    return () => { panel.element.remove(); };
  }, [panel, body]);
  // A new tree or query recomputes the matches and keeps the current position when it can.
  useLayoutEffect(() => {
    panel.show(options.root);
    const found = panel.search(query.trim());
    setMatches(found);
    setIndex((previous) => Math.min(previous, Math.max(0, found.length - 1)));
  }, [panel, options.root, query]);
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
  const copy = (): void => {
    void writeToClipboard(options.source(), undefined, content.current ?? undefined).then((copied) => {
      toast[copied ? "success" : "error"](copied ? "Source copied" : "Couldn't copy the source. Select the source text and copy it instead.", { id: "clipboard" });
    });
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="ub-figure-viewer ub-json-tree-viewer" ref={content}
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
      <DialogTitle className="sr-only">JSON tree</DialogTitle>
      <div className="ub-figure-viewer-bar">
        <Button variant="outline" size="sm" aria-label="Close JSON viewer" onClick={() => close()}>Close</Button>
        <Input type="search" className="ub-json-tree-search" placeholder="Search keys and values" aria-label="Search keys and values"
          value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={searchKeys} />
        <output className="ub-json-tree-count" aria-live="polite">
          {query.trim() === "" ? "" : matches.length === 0 ? "No matches" : `${index + 1} of ${matches.length}`}
        </output>
        <Button variant="outline" size="sm" aria-label="Previous match" disabled={matches.length === 0} onClick={() => step(-1)}>↑</Button>
        <Button variant="outline" size="sm" aria-label="Next match" disabled={matches.length === 0} onClick={() => step(1)}>↓</Button>
        <Button variant="outline" size="sm" onClick={() => { panel.openAll(false); }}>Collapse all</Button>
        <Button variant="outline" size="sm" onClick={() => { panel.openAll(true); }}>Expand all</Button>
        <span className="ub-figure-viewer-spacer" />
        <Button variant="outline" size="sm" aria-label="Copy JSON" onClick={copy}>Copy</Button>
        {options.editable && <Button variant="outline" size="sm" aria-label="Edit JSON" onClick={() => close(true)}>Edit</Button>}
      </div>
      <div className="ub-json-tree-viewer-body ub-code" ref={setBody} />
    </DialogContent>
  </Dialog>;
}

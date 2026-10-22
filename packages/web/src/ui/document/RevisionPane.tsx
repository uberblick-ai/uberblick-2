import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Editor } from "@tiptap/core";
import { compareRevisions, getMeta } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import type * as Y from "yjs";
import { createRevisionEditor } from "../../editor/revision-view.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { Button } from "../shadcn/button.js";
import { CardButtonControls } from "../editor-controls/CardButtonControls.js";
import type { DocumentHistory } from "./document-history.js";

export function revisionLabel(entry: RevisionEntry): string {
  const author = entry.author === null ? "Unknown author"
    : entry.author.surface.kind === "browser" ? `${entry.author.githubUsername} in the browser`
    : `${entry.author.githubUsername} via ${entry.author.surface.name || entry.author.surface.kind}`;
  const time = (value: number): string => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
  const start = entry.startedAt === null ? "unknown start" : time(entry.startedAt);
  return `${author}, ${entry.endedAt === null ? `from ${start}` : `${start} to ${time(entry.endedAt)}`}`;
}

export function HistoryControls({ history }: { history: DocumentHistory }): ReactElement | null {
  const { selection, entries, busy, error, entry } = history;
  const group = useRef<HTMLFieldSetElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  const forward = useRef<HTMLButtonElement | null>(null);
  const now = useRef<HTMLButtonElement | null>(null);
  const focus = useRef<"back" | "forward" | null>(selection === null ? null : "back");
  useLayoutEffect(() => {
    const fieldset = group.current;
    if (busy || focus.current === null || fieldset === null || fieldset.closest("[inert]")) return;
    const requested = selection !== null && focus.current === "forward" ? forward.current : back.current;
    focus.current = null;
    const active = fieldset.ownerDocument.activeElement;
    if (active !== fieldset.ownerDocument.body && !fieldset.contains(active)) return;
    // Native disabled buttons cannot retain focus at either history boundary.
    const fallback = back.current?.disabled ? forward.current?.disabled ? now.current : forward.current : back.current;
    (requested?.disabled ? fallback : requested)?.focus({ preventScroll: true });
  }, [busy, selection]);
  if (!history.available) return null;
  return <fieldset ref={group} aria-label="Document history" className="ub-history-controls ub-type-ui">
    <Button ref={back} variant="secondary" size="sm" onClick={() => { focus.current = "back"; history.back(); }}
      disabled={busy || entries === null || entries.length === 0 || (selection !== null && selection.index >= entries.length - 1)}>Back</Button>
    {selection !== null && <>
      <Button ref={forward} variant="secondary" size="sm" onClick={() => { focus.current = "forward"; history.forward(); }} disabled={busy || selection.index === 0}>Forward</Button>
      <Button ref={now} variant="secondary" size="sm" onClick={history.now}>Back to now</Button>
    </>}
    <span role="status">{error ?? (busy ? "Loading history…" : entry !== null ? revisionLabel(entry)
      : entries?.length === 0 ? "No revisions yet" : "Document history")}</span>
    {selection === null && !busy && <Button variant="secondary" size="sm" onClick={history.refresh}>Refresh history</Button>}
  </fieldset>;
}

export function RevisionPane({ history, docLinks, workspaceSettings }: {
  history: DocumentHistory; docLinks: DocLinkContext | null; workspaceSettings: Y.Doc | null;
}): ReactElement | null {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<DocumentHistory["selection"]>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const { selection } = history;
  const title = selection === null ? "" : getMeta(selection.after).title;
  const comparison = useMemo(() => selection?.before == null ? null : compareRevisions(selection.before, selection.after), [selection]);
  let titleOffset = 0;
  const titleSpans = comparison?.title?.spans.map((span) => {
    const offset = titleOffset;
    titleOffset += span.text.length;
    return span.kind === "unchanged" ? span.text : <span key={`${offset}:${span.kind}`} data-revision-change={span.kind}>{span.text}</span>;
  });
  useEffect(() => {
    if (host.current === null || selection === null) return;
    try {
      const editor = createRevisionEditor({ element: host.current, before: selection.before, after: selection.after, docLinks, workspaceSettings });
      editor.setOptions({ editorProps: { attributes: { "aria-label": "Document revision" } } });
      setEditor(editor);
      return () => { setEditor(null); editor.destroy(); };
    } catch { setFailed(selection); }
  }, [selection, docLinks, workspaceSettings]);
  if (selection === null) return null;
  return <section className="ub-pane ub-page-pane ub-document-pane ub-revision-pane">
    <div className="ub-column">
      <h1 className="ub-title">{titleSpans ?? title}</h1>
      <HistoryControls history={history} />
      {failed === selection && <p role="status">This client cannot display this revision. Update the client and try again.</p>}
      <div className="ub-editor-frame ub-revision-view">
        <div className="ub-editor" ref={host} />
        {editor !== null && <CardButtonControls editor={editor} canWrite={() => false} />}
      </div>
    </div>
  </section>;
}

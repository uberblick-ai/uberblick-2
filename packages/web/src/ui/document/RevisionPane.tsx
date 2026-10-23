import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { compareRevisions, getMeta } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import type * as Y from "yjs";
import { createRevisionEditor } from "../../editor/revision-view.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { toast } from "sonner";
import { writeToClipboard } from "../../editor/source-chrome.js";
import { Button } from "../shadcn/button.js";
import { CardButtonControls } from "../editor-controls/CardButtonControls.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import type { FormattedTimestamp } from "../timestamps.js";
import type { DocumentHistory } from "./document-history.js";
import { ClockIcon, NextIcon, PreviousIcon, TagIcon } from "./history-icons.js";
import { revisionAuthor, revisionTime } from "./revision-list.js";
import { RevisionNameControls } from "./RevisionNameControls.js";

export function revisionLabel(entry: RevisionEntry): string {
  const author = entry.author === null ? "Unknown author"
    : entry.author.surface.kind === "browser" ? `${entry.author.githubUsername} in the browser`
    : `${entry.author.githubUsername} via ${entry.author.surface.name || entry.author.surface.kind}`;
  const time = (value: number): string => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
  const start = entry.startedAt === null ? "unknown start" : time(entry.startedAt);
  const name = entry.name;
  const namer = name?.namer == null ? "Unknown person" : name.namer.surface.kind === "browser"
    ? `${name.namer.githubUsername} in the browser` : `${name.namer.githubUsername} via ${name.namer.surface.name || name.namer.surface.kind}`;
  return `${author}, ${entry.endedAt === null ? `from ${start}` : `${start} to ${time(entry.endedAt)}`}${name == null ? "" : ` · “${name.text}”, named by ${namer} at ${time(name.namedAt)}`}`;
}

/** Focus that leaving history dropped with the revision pane lands on this control. */
function useFocusOnReturn(target: { current: HTMLElement | null }, active: boolean): void {
  const was = useRef(active);
  useLayoutEffect(() => {
    const returned = was.current && !active;
    was.current = active;
    const element = target.current;
    if (!returned || element === null || element.closest("[inert]")) return;
    const focused = element.ownerDocument.activeElement;
    if (focused === null || focused === element.ownerDocument.body) element.focus({ preventScroll: true });
  }, [target, active]);
}

/** The live status line's way into history: name the current state, or step back. */
export function HistoryControls({ history, liveDocument = null, writable = false, returnFocus }: {
  history: DocumentHistory; liveDocument?: Y.Doc | null; writable?: boolean; returnFocus?: RefObject<HTMLButtonElement | null>;
}): ReactElement | null {
  const ownBack = useRef<HTMLButtonElement | null>(null);
  const back = returnFocus ?? ownBack;
  useFocusOnReturn(back, history.active);
  if (!history.available) return null;
  return <fieldset className="ub-history-nav" aria-label="Document history">
    <button ref={back} type="button" className="ub-history-icon" aria-label="Previous revision" title="Previous revision"
      disabled={history.busy && history.active} onClick={history.back}><PreviousIcon /></button>
    <button type="button" className="ub-history-icon" aria-label="Next revision" title="This is the current version" disabled><NextIcon /></button>
    {!history.active && <RevisionNameControls history={history} liveDocument={liveDocument} writable={writable} />}
  </fieldset>;
}

function attribution(entry: RevisionEntry, earliest: boolean, now: number): { label: string; time: FormattedTimestamp | null } {
  const author = revisionAuthor(entry, earliest);
  const time = revisionTime(entry);
  return { label: [author.name, author.surface].filter(Boolean).join(" "),
    time: entry.endedAt === null ? null : time === null ? null : formatTimestamp(time, now) };
}

/** One row under the revision title: who, when, where in the list, and which revision. */
function RevisionStatus({ history, writable }: { history: DocumentHistory; writable: boolean }): ReactElement | null {
  const { selection, entries, busy, error, entry } = history;
  const group = useRef<HTMLFieldSetElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  const forward = useRef<HTMLButtonElement | null>(null);
  const focus = useRef<"back" | "forward" | null>("back");
  const now = useTimestampClock();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus is placed again each time a navigation settles.
  useLayoutEffect(() => {
    const fieldset = group.current;
    if (busy || focus.current === null || fieldset === null || fieldset.closest("[inert]")) return;
    const requested = focus.current === "forward" ? forward.current : back.current;
    focus.current = null;
    const active = fieldset.ownerDocument.activeElement;
    // Entering history hides the live pane, which drops the focus it held.
    const dropped = active === null || active === fieldset.ownerDocument.body || active.closest("[inert]") !== null;
    if (!dropped && !fieldset.contains(active)) return;
    // Native disabled buttons cannot keep focus at the oldest revision.
    (requested?.disabled ? forward.current : requested)?.focus({ preventScroll: true });
  }, [busy, selection]);
  if (selection === null || entries === null || entry === null) return null;
  const total = entries.length;
  const oldest = selection.index >= total - 1;
  const { label, time } = attribution(entry, oldest, now);
  const compared = selection.comparedWith;
  return <fieldset ref={group} aria-label="Document history" className="ub-history-controls ub-type-small">
    <span className="ub-history-who" title={revisionLabel(entry)}>
      <ClockIcon />
      <span className="sr-only">{revisionLabel(entry)}</span>
      <span className="ub-history-author" aria-hidden="true">{label}</span>
      <span className="ub-history-when" aria-hidden="true">{selection.index === 0 && "· current version "}{time !== null && <>· <time dateTime={time.dateTime} title={time.title}>{time.label}</time></>}</span>
      {compared?.name != null && <span className="ub-history-compared">· compared with “{compared.name.text}”</span>}
    </span>
    <span role="status" className="ub-history-state">{error ?? (busy ? "Loading…" : "")}</span>
    <span className="ub-history-steps">
      <button ref={back} type="button" className="ub-history-icon" aria-label="Previous revision" title="Previous revision"
        disabled={busy || oldest} onClick={() => { focus.current = "back"; history.back(); }}><PreviousIcon /></button>
      <button ref={forward} type="button" className="ub-history-icon" aria-label="Next revision"
        title={selection.index === 0 ? "Back to the current version" : "Next revision"} disabled={busy && selection.index > 0}
        onClick={() => { if (selection.index === 0) history.now(); else { focus.current = "forward"; history.open(selection.index - 1); } }}><NextIcon /></button>
    </span>
    <span className="ub-history-position">{selection.index + 1} of {total} ·</span>
    {/* A named revision shows its name where the id would be; the tag renames it when its namer may. */}
    {entry.name != null && !(writable && entry.name.canManage) && <TagIcon />}
    <RevisionNameControls history={history} liveDocument={null} writable={writable} />
    <button type="button" className={`ub-history-rev${entry.name != null ? " ub-history-named" : ""}`} aria-label={`Copy revision ${entry.id}`}
      title={entry.name != null ? `${entry.name.text} · rev ${entry.id.slice(0, 8)}` : `Copy revision ${entry.id}`}
      onClick={() => { void writeToClipboard(entry.id).then((ok) => toast[ok ? "success" : "error"](ok ? "Revision copied" : "Couldn't copy the revision. Try again in a browser with clipboard access.", { id: "clipboard" })); }}>
      {entry.name != null ? <span>{entry.name.text}</span> : <>rev <span className="ub-doc-id">{entry.id.slice(0, 8)}</span></>}
    </button>
    <Button variant="secondary" size="sm" className="ub-history-now" onClick={history.now}>Back to now</Button>
  </fieldset>;
}

/** Shown while history is open without a revision: loading, unavailable, or empty. */
function HistoryState({ history }: { history: DocumentHistory }): ReactElement {
  const message = history.error ?? (history.busy ? "Loading history…" : history.entries?.length === 0 ? "No revisions yet" : "Document history");
  return <div className="ub-history-empty ub-type-ui">
    <p role="status" className="m-0">{message}</p>
    <div className="flex gap-2">
      {history.error !== null && <Button variant="secondary" size="sm" onClick={history.retry}>Try again</Button>}
      <Button variant="secondary" size="sm" onClick={history.now}>Back to now</Button>
    </div>
  </div>;
}

export function RevisionPane({ history, docLinks, workspaceSettings, writable = false }: {
  history: DocumentHistory; docLinks: DocLinkContext | null; workspaceSettings: Y.Doc | null; writable?: boolean;
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
  if (!history.active) return null;
  if (selection === null) return <section className="ub-pane ub-page-pane ub-document-pane ub-revision-pane">
    <div className="ub-column"><HistoryState history={history} /></div>
  </section>;
  return <section className="ub-pane ub-page-pane ub-document-pane ub-revision-pane">
    <div className="ub-column">
      <h1 className="ub-title">{titleSpans ?? title}</h1>
      <RevisionStatus history={history} writable={writable} />
      {failed === selection && <p role="status">This client cannot display this revision. Update the client and try again.</p>}
      <div className="ub-editor-frame ub-revision-view">
        <div className="ub-editor" ref={host} />
        {editor !== null && <CardButtonControls editor={editor} canWrite={() => false} />}
      </div>
    </div>
  </section>;
}

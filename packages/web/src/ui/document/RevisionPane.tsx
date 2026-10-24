import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { getMeta } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import type * as Y from "yjs";
import { jsonChangeStarts, openFoldedChange, spanningComparison } from "../../editor/json-compare-panel.js";
import { createRevisionEditor } from "../../editor/revision-view.js";
import { alignRevisionSides, createRevisionSplit } from "../../editor/revision-split.js";
import type { RevisionRow } from "../../editor/revision-split.js";
import { revealFoldedTarget } from "../../editor/toggle-headings.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { toast } from "sonner";
import { writeToClipboard } from "../../editor/source-chrome.js";
import { Button } from "../shadcn/button.js";
import { CardButtonControls } from "../editor-controls/CardButtonControls.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import type { FormattedTimestamp } from "../timestamps.js";
import type { DocumentHistory } from "./document-history.js";
import { renamedFrom } from "./document-history.js";
import { ClockIcon, DownIcon, NextIcon, PreviousIcon, TagIcon, UpIcon } from "./history-icons.js";
import { revisionAuthor, revisionTime } from "./revision-list.js";
import { RevisionNameControls } from "./RevisionNameControls.js";
import { RevisionRuler } from "./RevisionRuler.js";
import { animateRows, morphFromLive, morphToLive, reducedMotion, rememberLiveHeader, revealRevision, snapshotRows, takeLiveHeader } from "./revision-motion.js";
import type { HeaderMorph, RowSnapshot } from "./revision-motion.js";
import { handleDocLinkClick } from "./doc-link-click.js";

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
    const stop = morphToLive(element);
    const focused = element.ownerDocument.activeElement;
    if (focused === null || focused === element.ownerDocument.body) element.focus({ preventScroll: true });
    return stop;
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
      disabled={history.busy && history.active} onClick={(event) => { rememberLiveHeader(event.currentTarget); history.back(); }}><PreviousIcon /></button>
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
  const renamed = renamedFrom(entries, history.titles, selection.index);
  return <fieldset ref={group} aria-label="Document history" className="ub-history-controls ub-type-small">
    <span className="ub-history-who" title={revisionLabel(entry)}>
      <ClockIcon />
      <span className="sr-only">{revisionLabel(entry)}</span>
      <span className="ub-history-author" aria-hidden="true">{label}</span>
      <span className="ub-history-when" aria-hidden="true">{selection.index === 0 && "· current version "}{time !== null && <>· <time dateTime={time.dateTime} title={time.title}>{time.label}</time></>}</span>
      {renamed !== null && <span className="ub-history-renamed">· renamed from <s>{renamed || "Untitled"}</s></span>}
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

/** Below this much room beside the sidebar, two columns are too narrow to read. */
const SPLIT_MIN_WIDTH = 900;

/** The width the pane may take, which its own width cannot tell while it is narrow. */
function useAvailableWidth(target: { current: HTMLElement | null }, active: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const container = target.current?.parentElement;
    if (!active || container == null) return;
    const measure = (): void => setWidth(container.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [target, active]);
  return width;
}

/** A change lands this far below the sticky header. */
const CHANGE_OFFSET = 8;
/** A change within about two lines below its landing place, like the first one under the column labels, is the current one. */
const CHANGE_SLACK = 64;

function spanned(row: RevisionRow | undefined): boolean {
  return row?.after.spanned === true;
}

/** Each run of consecutive changed rows is one change to step to; a JSON comparison brings its own. */
function changeStarts(rows: readonly RevisionRow[]): number[] {
  return rows.flatMap((row, index) => row.changed && (!rows[index - 1]?.changed || spanned(row) || spanned(rows[index - 1])) ? [index] : []);
}

function nextChangeTarget<T extends { top: number }>(list: readonly T[]): T | undefined {
  const current = list.findIndex((entry) => entry.top >= -2 && entry.top <= CHANGE_SLACK);
  // Only one target is current, even when several JSON changes fit within the tolerance.
  return current < 0 ? list.find((entry) => entry.top > CHANGE_SLACK) : list[current + 1];
}

/**
 * Stacked previous and next change, level with the line under the title. They
 * scroll the pane so a change sits just below the sticky header.
 */
function ChangeNavigation({ pane, header, before, after, rows }: {
  pane: { current: HTMLElement | null }; header: { current: HTMLElement | null };
  before: Editor; after: Editor; rows: readonly RevisionRow[];
}): ReactElement {
  const side = after.view.dom;
  const starts = useMemo(() => changeStarts(rows), [rows]);
  const [state, setState] = useState({ previous: false, next: false });
  const targets = useCallback((): { row: number; top: number; element: HTMLElement }[] => {
    const line = header.current?.getBoundingClientRect().bottom ?? 0;
    return starts.flatMap((row) => {
      const element = side.querySelector<HTMLElement>(`:scope > .ub-revision-row-start[data-row="${row}"]`);
      if (element === null) return [];
      // A JSON comparison is stepped through change by change.
      const block = spanned(rows[row]) ? spanningComparison(element) : null;
      // A toggle can hide the block; its row marker still has a position to reveal.
      const inner = block === null || block.getClientRects().length === 0 ? [] : jsonChangeStarts(block);
      // Relative to where a change lands: 0 is the current change.
      return (inner.length > 0 ? inner : [element]).map((each) => ({ row, top: each.getBoundingClientRect().top - line - CHANGE_OFFSET, element: each }));
    });
  }, [header, side, starts, rows]);
  useEffect(() => {
    const scroller = pane.current;
    if (scroller === null) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const list = targets();
        const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        setState({ previous: list.some((target) => target.top < -2), next: !end && nextChangeTarget(list) !== undefined });
      });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(side);
    side.addEventListener("ub-json-compare-render", measure);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", measure);
      side.removeEventListener("ub-json-compare-render", measure);
      observer?.disconnect();
    };
  }, [pane, side, targets]);
  const go = (direction: -1 | 1): void => {
    const scroller = pane.current;
    if (scroller === null) return;
    const list = targets();
    const target = direction > 0 ? nextChangeTarget(list) : list.findLast((entry) => entry.top < -2);
    if (target === undefined) return;
    // A change can span several rows under different nested toggle headings.
    for (let row = target.row; rows[row]?.changed; row += 1) {
      for (const editor of [before, after]) {
        const start = editor.view.dom.querySelector<HTMLElement>(`:scope > .ub-revision-row-start[data-row="${row}"]`);
        if (start !== null) revealFoldedTarget(start);
      }
    }
    alignRevisionSides(before.view, after.view);
    // Revealing moves the change, and can redraw its row.
    const visible = targets();
    const revealed = visible.find((entry) => entry.element === target.element)
      ?? (direction > 0 ? visible.find((entry) => entry.row === target.row) : visible.findLast((entry) => entry.row === target.row));
    if (revealed === undefined) return;
    // A change folded inside a JSON comparison opens when navigation reaches it.
    openFoldedChange(revealed.element);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    scroller.scrollBy({ top: revealed.top, behavior: reduce ? "auto" : "smooth" });
  };
  return <fieldset className="ub-change-nav" aria-label="Changes">
    <button type="button" className="ub-history-icon" aria-label="Previous change" title="Previous change" disabled={!state.previous} onClick={() => go(-1)}><UpIcon /></button>
    <button type="button" className="ub-history-icon" aria-label="Next change" title="Next change" disabled={!state.next} onClick={() => go(1)}><DownIcon /></button>
  </fieldset>;
}

const TITLE_MOTION = 450;

/**
 * The title as it was at this revision. Another title slides in from the side
 * the person moved from while the old one blurs out the other way.
 */
function RevisionTitle({ title, index }: { title: string; index: number }): ReactElement {
  const [shown, setShown] = useState<{ title: string; index: number; turn: number; leaving: { title: string; older: boolean } | null }>(
    { title, index, turn: 0, leaving: null });
  if (shown.title !== title) {
    setShown({ title, index, turn: shown.turn + 1, leaving: reducedMotion() ? null : { title: shown.title, older: index > shown.index } });
  } else if (shown.index !== index) setShown({ ...shown, index });
  const { leaving, turn } = shown;
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setShown((current) => current.turn === turn ? { ...current, leaving: null } : current), TITLE_MOTION);
    return () => clearTimeout(timer);
  }, [leaving, turn]);
  return <h1 className="ub-revision-title" data-direction={leaving === null ? undefined : leaving.older ? "older" : "newer"}>
    <span key={turn} className="ub-revision-title-text" data-entering={leaving === null ? undefined : ""}>{title || "Untitled"}</span>
    {leaving !== null && <span key={`leaving-${turn}`} className="ub-revision-title-text" data-leaving="" aria-hidden="true">{leaving.title || "Untitled"}</span>}
  </h1>;
}

function authorName(entry: RevisionEntry | undefined, earliest: boolean): string {
  return entry === undefined ? "Unknown author" : revisionAuthor(entry, earliest).name;
}

export function RevisionPane({ history, docLinks, workspaceSettings, writable = false, archived = false }: {
  history: DocumentHistory; docLinks: DocLinkContext | null; workspaceSettings: Y.Doc | null; writable?: boolean; archived?: boolean;
}): ReactElement | null {
  const { selection, entries, collapseUnchanged } = history;
  const pane = useRef<HTMLElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const beforeHost = useRef<HTMLDivElement | null>(null);
  const afterHost = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<DocumentHistory["selection"]>(null);
  const [editors, setEditors] = useState<{ side: string; editor: Editor }[]>([]);
  const [rows, setRows] = useState<readonly RevisionRow[]>([]);
  const header = useRef<HTMLElement | null>(null);
  // The live header this pane replaced, when a click just entered history.
  const [live] = useState(takeLiveHeader);
  const morph = useRef<HeaderMorph | null>(null);
  const folded = useRef<{ selection: DocumentHistory["selection"]; rows: RowSnapshot } | null>(null);
  // The revision on screen before this one; the first arrives with the header morph instead.
  const stepped = useRef<DocumentHistory["selection"]>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const restoreReason = useId();
  const title = selection === null ? "" : getMeta(selection.after).title;
  const available = useAvailableWidth(pane, history.active);
  // The earliest revision has nothing to compare; narrow panes keep one column.
  const split = selection?.before != null && available !== null && available >= SPLIT_MIN_WIDTH;
  // Starts before the first paint, so the outgoing content never shows under the new header.
  useLayoutEffect(() => {
    if (selection === null) return;
    const from = stepped.current;
    stepped.current = selection;
    if (from === null || body.current === null) return;
    revealRevision(body.current, selection.index > from.index ? "older" : selection.index < from.index ? "newer" : null);
  }, [selection]);
  useEffect(() => {
    if (selection === null) return;
    try {
      if (split && selection.before !== null && beforeHost.current !== null && afterHost.current !== null) {
        const view = createRevisionSplit({ beforeElement: beforeHost.current, afterElement: afterHost.current,
          before: selection.before, after: selection.after, docLinks, workspaceSettings,
          folding: { collapse: collapseUnchanged, expanded: new Set() },
          onExpand: (run) => {
            const previous = pane.current === null ? null : snapshotRows(sides, pane.current);
            view.expand(run);
            setRows(view.model.rows);
            if (previous !== null && pane.current !== null) animateRows(sides, previous, pane.current);
          } });
        const sides = [view.before.view.dom, view.after.view.dom];
        const activate = (event: MouseEvent): void => { handleDocLinkClick(event, docLinks); };
        for (const side of sides) side.addEventListener("click", activate);
        setEditors([{ side: "before", editor: view.before }, { side: "after", editor: view.after }]);
        setRows(view.model.rows);
        // The Collapse unchanged switch rebuilds both sides; rows slide from where they stood.
        const previous = folded.current;
        folded.current = null;
        if (previous?.selection === selection && pane.current !== null) animateRows([view.before.view.dom, view.after.view.dom], previous.rows, pane.current);
        return () => {
          folded.current = pane.current === null ? null : { selection, rows: snapshotRows([view.before.view.dom, view.after.view.dom], pane.current) };
          for (const side of sides) side.removeEventListener("click", activate);
          setEditors([]);
          setRows([]);
          view.destroy();
        };
      }
      if (host.current === null) return;
      const editor = createRevisionEditor({ element: host.current, before: selection.before, after: selection.after, docLinks, workspaceSettings });
      editor.setOptions({ editorProps: { attributes: { "aria-label": "Document revision" } } });
      setEditors([{ side: "single", editor }]);
      return () => { setEditors([]); editor.destroy(); };
    } catch { setFailed(selection); }
  }, [selection, split, docLinks, workspaceSettings, collapseUnchanged]);
  // The header arrives from where the live header stood; leaving cancels it at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The morph runs once, when history opens.
  useLayoutEffect(() => {
    if (header.current === null || pane.current === null) return;
    const started = morphFromLive(live, header.current, pane.current);
    morph.current = started;
    return () => { morph.current = null; started.stop(); };
  }, []);
  // The status row, comparison and change controls arrive with the first revision.
  useLayoutEffect(() => { morph.current?.follow(); });
  if (!history.active) return null;
  // While the first revision loads after a click, the header holds the live title.
  const arriving = selection === null && live !== null && history.busy && history.error === null;
  if (selection === null && !arriving) return <section ref={pane} className="ub-pane ub-page-pane ub-document-pane ub-revision-pane">
    <div className="ub-column"><HistoryState history={history} /></div>
  </section>;
  const entry = selection === null ? undefined : entries?.[selection.index];
  const predecessor = selection === null ? undefined : selection.comparedWith ?? entries?.[selection.index + 1];
  const total = entries?.length ?? 0;
  const before = editors.find((entry) => entry.side === "before")?.editor;
  const after = editors.find((entry) => entry.side === "after")?.editor;
  const restoreUnavailable = archived ? "This document is archived. Restore the document first, then restore a revision."
    : !writable ? "Read-only access. Write access is required to restore a revision."
    : history.busy ? "Wait for history to load." : entry === undefined ? "Choose a revision to restore." : null;
  const restore = async (): Promise<void> => {
    if (restoreUnavailable !== null || entry === undefined) return;
    try {
      const applied = await history.restore(entry.id);
      toast.success(applied ? "Document restored to this version" : "The document already has this version. Nothing changed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't restore this version. Refresh history and try again.");
    }
  };
  return <section ref={pane} className={`ub-pane ub-page-pane ub-document-pane ub-revision-pane${split ? " ub-revision-split-pane" : ""}`}>
    <div className="ub-column">
      {/* Stays in view while the comparison scrolls; revisions keep no tags. */}
      <header ref={header} className="ub-revision-header">
        <div className="ub-revision-heading">
          <RevisionTitle title={selection === null ? live?.title?.text ?? "" : title} index={selection?.index ?? -1} />
          <Button variant="secondary" size="sm" disabled={restoreUnavailable !== null} aria-describedby={restoreUnavailable === null ? undefined : restoreReason}
            title={restoreUnavailable ?? undefined} className="ub-revision-restore" onClick={() => { void restore(); }}>
            Restore this version
          </Button>
        </div>
        {restoreUnavailable !== null && <p id={restoreReason} className={archived || !writable ? "m-0 ub-type-small text-(--muted-foreground)" : "sr-only"}>{restoreUnavailable}</p>}
        {selection === null ? <p role="status" className="ub-history-controls ub-type-small">Loading history…</p>
          : <RevisionStatus history={history} writable={writable} />}
        {split && before !== undefined && after !== undefined && rows.length > 0 && <>
          <ChangeNavigation pane={pane} header={header} before={before} after={after} rows={rows} />
          <RevisionRuler pane={pane} header={header} side={after.view.dom} rows={rows} />
        </>}
      </header>
      {selection !== null && failed === selection && <p role="status">This client cannot display this revision. Update the client and try again.</p>}
      {selection === null ? null : split ? <div ref={body} className="ub-revision-split">
        <div className="ub-revision-side ub-revision-side-before">
          <p className="ub-revision-side-label">Before · {authorName(predecessor, selection.index + 2 >= total)}</p>
          <div className="ub-editor-frame ub-revision-view"><div className="ub-editor" ref={beforeHost} /></div>
        </div>
        <div className="ub-revision-side ub-revision-side-after">
          <p className="ub-revision-side-label">After · {authorName(entry, selection.index + 1 >= total)}</p>
          <div className="ub-editor-frame ub-revision-view"><div className="ub-editor" ref={afterHost} /></div>
        </div>
      </div> : <div ref={body} className="ub-editor-frame ub-revision-view"><div className="ub-editor" ref={host} /></div>}
      {editors.map(({ side, editor }) => <CardButtonControls key={side} editor={editor} canWrite={() => false} />)}
    </div>
  </section>;
}

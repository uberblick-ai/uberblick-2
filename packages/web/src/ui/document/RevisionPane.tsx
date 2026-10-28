import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { getMeta } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import type * as Y from "yjs";
import { revisionSurface } from "../../revision-attribution.js";
import { jsonChangeStarts, openFoldedChange, spanningComparison } from "../../editor/json-compare-panel.js";
import { createRevisionEditor, createRevisionInline } from "../../editor/revision-view.js";
import { setEditorMembers } from "../../editor/person-mentions.js";
import { useWorkspaceMembers } from "../workspace-members.js";
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
import { historyCacheMessage, newestHistoryLabel } from "./history-presentation.js";
import { ClockIcon, DownIcon, NextIcon, PreviousIcon, TagIcon, UpIcon } from "./history-icons.js";
import { revisionAuthor, revisionAuthors, revisionSpan, revisionTime } from "./revision-list.js";
import { RevisionNameControls } from "./RevisionNameControls.js";
import { RevisionRuler } from "./RevisionRuler.js";
import { animateRows, cancelRowMotion, morphFromLive, morphToLive, reducedMotion, rememberLiveHeader, revealRevision, snapshotRows, takeLiveHeader } from "./revision-motion.js";
import type { HeaderMorph } from "./revision-motion.js";
import { handleDocLinkClick } from "./doc-link-click.js";
import { holdRevisionRow, REVISION_READING_INSET } from "./revision-anchor.js";
import type { RevisionComparisonView, RevisionRowHold } from "./revision-anchor.js";

function exactTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function revisionNameLabel(entry: RevisionEntry): string {
  const name = entry.name;
  const namer = name?.namer == null ? "Unknown person"
    : `${name.namer.githubUsername} ${revisionSurface(name.namer.surface, "namer")}`;
  return name == null ? "" : ` · “${name.text}”, named by ${namer} at ${exactTime(name.namedAt)}`;
}

export function revisionLabel(entry: RevisionEntry): string {
  const author = entry.author === null ? "Unknown author"
    : `${entry.author.githubUsername} ${revisionSurface(entry.author.surface, "author")}`;
  const start = entry.startedAt === null ? "unknown start" : exactTime(entry.startedAt);
  return `${author}, ${entry.endedAt === null ? `from ${start}` : `${start} to ${exactTime(entry.endedAt)}`}${revisionNameLabel(entry)}`;
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
    <Button variant="history" size="custom" ref={back} type="button" aria-label="Previous revision" title="Previous revision"
      disabled={history.busy && history.active} onClick={(event) => { rememberLiveHeader(event.currentTarget); history.back(); }}><PreviousIcon /></Button>
    <Button variant="history" size="custom" type="button" aria-label="Next revision" title="This is the current version" disabled><NextIcon /></Button>
    {!history.active && <RevisionNameControls history={history} liveDocument={liveDocument} writable={writable} />}
  </fieldset>;
}

function attribution(entry: RevisionEntry, earliest: boolean, now: number): { label: string; time: FormattedTimestamp | null } {
  const author = revisionAuthor(entry, earliest);
  const time = revisionTime(entry);
  return { label: [author.name, author.surface].filter(Boolean).join(" "),
    time: entry.endedAt === null ? null : time === null ? null : formatTimestamp(time, now) };
}

function comparisonAttribution(history: DocumentHistory, now: number): { label: string; span: { label: string; title: string } } | null {
  const { selection } = history;
  if (selection?.comparedWith === undefined) return null;
  const entries = selection.entries;
  const selected = entries.findIndex(entry => entry.id === selection.entry.id);
  const baseline = entries.findIndex((entry) => entry.id === selection.comparedWith?.id);
  if (baseline <= selected + 1) return null;
  const revisions = entries.slice(selected, baseline);
  return {
    label: revisionAuthors(revisions).map((author) => [author.name, author.surface].filter(Boolean).join(" ")).join(", "),
    span: revisionSpan(revisions, now),
  };
}

/** One row under the revision title: who, when, where in the list, and which revision. */
function RevisionStatus({ history, writable, now }: { history: DocumentHistory; writable: boolean; now: number }): ReactElement | null {
  const { selection, busy, error, entry } = history;
  const group = useRef<HTMLFieldSetElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  const forward = useRef<HTMLButtonElement | null>(null);
  const copyRevision = useRef<HTMLButtonElement | null>(null);
  const focus = useRef<"back" | "forward" | null>("back");
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
    // Named history can have no revision in either direction.
    [requested, back.current, forward.current, copyRevision.current].find((button) => button !== null && !button.disabled)?.focus({ preventScroll: true });
  }, [busy, selection]);
  if (selection === null || entry === null) return null;
  const entries = selection.entries;
  const selected = entries.findIndex(item => item.id === entry.id);
  const total = entries.length;
  const oldest = selected >= total - 1;
  const { label, time } = attribution(entry, oldest, now);
  const comparison = comparisonAttribution(history, now);
  const fullLabel = comparison === null ? revisionLabel(entry) : `${comparison.label}, ${comparison.span.title}${revisionNameLabel(entry)}`;
  const compared = selection.comparedWith;
  const renamed = renamedFrom(entries, Object.fromEntries(entries.flatMap(item => item.title === undefined ? [] : [[item.id, item.title]])), selected);
  const cacheMessage = historyCacheMessage(history);
  return <fieldset ref={group} aria-label="Document history" className="ub-history-controls ub-type-small">
    <span className={`ub-history-who${comparison === null ? "" : " ub-history-span"}`} title={fullLabel}>
      <ClockIcon />
      <span className="sr-only">{fullLabel}</span>
      <span className="ub-history-author" aria-hidden="true">{comparison?.label ?? label}</span>
      <span className="ub-history-when" aria-hidden="true">{selection.index === 0 && `· ${newestHistoryLabel(history).toLowerCase()} `}{comparison !== null ? <>· <span title={comparison.span.title}>{comparison.span.label}</span></> : time !== null && <>· <time dateTime={time.dateTime} title={time.title}>{time.label}</time></>}</span>
      {renamed !== null && <span className="ub-history-renamed">· renamed from <s>{renamed || "Untitled"}</s></span>}
      {compared !== undefined && (compared.name != null || entry.name != null) && <span className="ub-history-compared">· compared with {compared.name != null && <>“{compared.name.text}” · </>}{authorName(compared, compared.id === entries[total - 1]?.id)}</span>}
    </span>
    <span role="status" className="ub-history-state">{[cacheMessage, error ?? (busy ? "Loading…" : null)].filter(Boolean).join(" ")}</span>
    <span className="ub-history-steps">
      <Button variant="history" size="custom" ref={back} type="button" aria-label="Previous revision" title="Previous revision"
        disabled={busy || !history.canBack} onClick={() => { focus.current = "back"; history.back(); }}><PreviousIcon /></Button>
      <Button variant="history" size="custom" ref={forward} type="button" aria-label="Next revision"
        title={history.filter === "all" && selection.index === 0 ? "Back to the current version" : "Next revision"} disabled={!history.canForward || (busy && selection.index > 0)}
        onClick={() => { focus.current = "forward"; history.forward(); }}><NextIcon /></Button>
    </span>
    <span className="ub-history-position">{selected + 1} of {total} ·</span>
    {/* A named revision shows its name where the id would be; writers can rename it with the tag. */}
    {entry.name != null && !(history.connected && writable && entry.name.canManage) && <TagIcon />}
    <RevisionNameControls history={history} liveDocument={null} writable={writable} />
    <Button variant="plain" size="custom" type="button" className={`shrink-0 min-w-0 rounded-(--radius-sm) border-0 bg-transparent px-0 py-1 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ub-history-rev${entry.name != null ? " inline-flex max-w-44 -ml-[0.35rem] text-foreground font-medium [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis ub-history-named" : " text-inherit"}`} aria-label={`Copy revision ${entry.id}`}
      ref={copyRevision} title={entry.name != null ? `${entry.name.text} · rev ${entry.id.slice(0, 8)}` : `Copy revision ${entry.id}`}
      onClick={() => { void writeToClipboard(entry.id).then((ok) => toast[ok ? "success" : "error"](ok ? "Revision copied" : "Couldn't copy the revision. Try again in a browser with clipboard access.", { id: "clipboard" })); }}>
      {entry.name != null ? <span>{entry.name.text}</span> : <>rev <span className="ub-doc-id">{entry.id.slice(0, 8)}</span></>}
    </Button>
    <Button variant="secondary" size="sm" className="ub-history-now" onClick={history.now}>Back to now</Button>
  </fieldset>;
}

/** Shown while history is open without a revision: loading, unavailable, or empty. */
function HistoryState({ history }: { history: DocumentHistory }): ReactElement {
  const cacheMessage = historyCacheMessage(history);
  const message = history.error ?? (history.busy ? "Loading history…" : history.entries?.length === 0 && history.history?.complete !== false ? "No revisions yet" : cacheMessage ?? "Document history");
  return <div className="ub-history-empty ub-type-ui">
    <p role="status" className="m-0">{message}</p>
    {cacheMessage !== null && cacheMessage !== message && <p role="status" className="m-0">{cacheMessage}</p>}
    <div className="flex gap-2">
      {history.error !== null && <Button variant="secondary" size="sm" onClick={history.retry}>Try again</Button>}
      {history.history?.refreshFailed === true && <Button variant="secondary" size="sm" onClick={history.refresh}>Refresh history</Button>}
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

/** A change within about two lines below its landing place, like the first one under the column labels, is the current one. */
const CHANGE_SLACK = 64;

function spanned(row: RevisionRow | undefined): boolean {
  return row?.after.spanned === true;
}

/** Consecutive prose changes share a stop; whole visuals and JSON comparisons have their own. */
function changeStarts(rows: readonly RevisionRow[]): number[] {
  return rows.flatMap((row, index) => row.changed && (!rows[index - 1]?.changed || row.separateChange || rows[index - 1]?.separateChange
    || spanned(row) || spanned(rows[index - 1])) ? [index] : []);
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
function ChangeNavigation({ pane, header, before, after, rows, onNavigate }: {
  pane: { current: HTMLElement | null }; header: { current: HTMLElement | null };
  before: Editor | undefined; after: Editor; rows: readonly RevisionRow[];
  onNavigate: () => void;
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
      return (inner.length > 0 ? inner : [element]).map((each) => ({ row, top: each.getBoundingClientRect().top - line - REVISION_READING_INSET, element: each }));
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
    onNavigate();
    const scroller = pane.current;
    if (scroller === null) return;
    const list = targets();
    const target = direction > 0 ? nextChangeTarget(list) : list.findLast((entry) => entry.top < -2);
    if (target === undefined) return;
    // A change can span several rows under different nested toggle headings.
    for (let row = target.row; rows[row]?.changed; row += 1) {
      for (const editor of [before, after]) {
        if (editor === undefined) continue;
        const start = editor.view.dom.querySelector<HTMLElement>(`:scope > .ub-revision-row-start[data-row="${row}"]`);
        if (start !== null) revealFoldedTarget(start);
      }
    }
    if (before !== undefined) alignRevisionSides(before.view, after.view);
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
    <Button variant="history" size="custom" type="button" aria-label="Previous change" title="Previous change" disabled={!state.previous} onClick={() => go(-1)}><UpIcon /></Button>
    <Button variant="history" size="custom" type="button" aria-label="Next change" title="Next change" disabled={!state.next} onClick={() => go(1)}><DownIcon /></Button>
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

function RevisionAfterLabel({ entry, earliest, comparison, showName }: {
  entry: RevisionEntry | undefined; earliest: boolean; comparison: ReturnType<typeof comparisonAttribution>; showName: boolean;
}): ReactElement {
  const title = comparison === null ? undefined : `${comparison.label}, ${comparison.span.title}${entry === undefined ? "" : revisionNameLabel(entry)}`;
  return <span className={comparison === null ? undefined : "ub-history-span"} title={title}>After · {comparison?.label ?? authorName(entry, earliest)}
    {comparison !== null && <> · <span title={comparison.span.title}>{comparison.span.label}</span></>}
    {showName && entry?.name != null && <> · “{entry.name.text}”</>}
  </span>;
}

function restoreUnavailableReason(history: DocumentHistory, writable: boolean, archived: boolean): string | null {
  return archived ? "This document is archived. Restore the document first, then restore a revision."
    : !writable ? "Read-only access. Write access is required to restore a revision."
    : history.busy ? "Wait for history to load." : history.entry === null ? "Choose a revision to restore."
    : history.selection?.comparedWith?.name == null && history.selection?.index === 0 ? "This is the current version." : null;
}

function RevisionRestoreButton({ label, unavailable, reasonId, restore }: {
  label: string; unavailable: string | null; reasonId: string; restore: () => Promise<void>;
}): ReactElement {
  return <Button variant="secondary" size="sm" disabled={unavailable !== null} aria-describedby={unavailable === null ? undefined : reasonId}
    title={unavailable ?? undefined} className="ub-revision-restore" onClick={() => { void restore(); }}>
    <span>{label}</span>
  </Button>;
}

export function RevisionPane({ history, docLinks, workspaceSettings, writable = false, archived = false }: {
  history: DocumentHistory; docLinks: DocLinkContext | null; workspaceSettings: Y.Doc | null; writable?: boolean; archived?: boolean;
}): ReactElement | null {
  const { selection, collapseUnchanged } = history;
  const now = useTimestampClock();
  const pane = useRef<HTMLElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const beforeHost = useRef<HTMLDivElement | null>(null);
  const afterHost = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<Y.Doc | null>(null);
  const [editors, setEditors] = useState<{ side: string; editor: Editor }[]>([]);
  const members = useWorkspaceMembers();
  useEffect(() => {
    for (const { editor } of editors) if (!editor.isDestroyed) setEditorMembers(editor, members);
  }, [editors, members]);
  const [rows, setRows] = useState<readonly RevisionRow[]>([]);
  const header = useRef<HTMLElement | null>(null);
  // The live header this pane replaced, when a click just entered history.
  const [live] = useState(takeLiveHeader);
  const morph = useRef<HeaderMorph | null>(null);
  const comparison = useRef<RevisionComparisonView | null>(null);
  const heldRow = useRef<RevisionRowHold | null>(null);
  const stopHolding = useCallback((): void => { heldRow.current?.stop(); heldRow.current = null; }, []);
  const readCollapse = useEffectEvent(() => collapseUnchanged);
  // The revision on screen before this one; the first arrives with the header morph instead.
  const stepped = useRef<DocumentHistory["selection"]>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const restoreReason = useId();
  const title = selection === null ? "" : getMeta(selection.after).title;
  const beforeDocument = selection?.before ?? null;
  const afterDocument = selection?.after ?? null;
  const available = useAvailableWidth(pane, history.active);
  // The earliest revision has nothing to compare; narrow panes keep one column.
  const split = selection?.before != null && history.comparisonView !== "inline" && available !== null && available >= SPLIT_MIN_WIDTH;
  // Starts before the first paint, so the outgoing content never shows under the new header.
  useLayoutEffect(() => {
    if (selection === null) return;
    const from = stepped.current;
    stepped.current = selection;
    if (from === null || body.current === null) return;
    if (from.before === selection.before && from.after === selection.after) return;
    revealRevision(body.current, selection.index > from.index ? "older" : selection.index < from.index ? "newer" : null);
  }, [selection]);
  useEffect(() => {
    if (afterDocument === null) return;
    try {
      const onExpand = (run: number): void => {
        const view = comparison.current;
        if (view === null) return;
        stopHolding();
        const sides = view.before === undefined ? [view.after.view.dom] : [view.before.view.dom, view.after.view.dom];
        const previous = pane.current === null ? null : snapshotRows(sides, pane.current);
        view.expand(run);
        setRows(view.model.rows);
        if (previous !== null && pane.current !== null) animateRows(sides, previous, pane.current);
      };
      let view: RevisionComparisonView;
      let destroy: () => void;
      if (split && beforeDocument !== null && beforeHost.current !== null && afterHost.current !== null) {
        const rendered = createRevisionSplit({ beforeElement: beforeHost.current, afterElement: afterHost.current,
          before: beforeDocument, after: afterDocument, docLinks, workspaceSettings,
          folding: { collapse: readCollapse(), expanded: new Set() },
          onExpand });
        view = rendered;
        destroy = rendered.destroy;
        setEditors([{ side: "before", editor: rendered.before }, { side: "after", editor: rendered.after }]);
      } else {
        if (host.current === null) return;
        if (beforeDocument === null) {
          const editor = createRevisionEditor({ element: host.current, before: null, after: afterDocument, docLinks, workspaceSettings,
            ariaLabel: "Document revision" });
          const activate = (event: MouseEvent): void => { handleDocLinkClick(event, docLinks); };
          editor.view.dom.addEventListener("click", activate);
          setEditors([{ side: "single", editor }]);
          return () => { editor.view.dom.removeEventListener("click", activate); setEditors([]); editor.destroy(); };
        }
        const rendered = createRevisionInline({ element: host.current, before: beforeDocument, after: afterDocument, docLinks, workspaceSettings,
          ariaLabel: "Document revision",
          folding: { collapse: readCollapse(), expanded: new Set() }, onExpand });
        view = { get model() { return rendered.model; }, after: rendered.editor, expand: rendered.expand, setCollapse: rendered.setCollapse };
        destroy = rendered.destroy;
        setEditors([{ side: "single", editor: rendered.editor }]);
      }
      const sides = view.before === undefined ? [view.after.view.dom] : [view.before.view.dom, view.after.view.dom];
      comparison.current = view;
      const activate = (event: MouseEvent): void => { handleDocLinkClick(event, docLinks); };
      for (const side of sides) side.addEventListener("click", activate);
      setRows(view.model.rows);
      return () => {
        stopHolding();
        comparison.current = null;
        for (const side of sides) side.removeEventListener("click", activate);
        setEditors([]);
        setRows([]);
        destroy();
      };
    } catch { setFailed(afterDocument); }
  }, [beforeDocument, afterDocument, split, docLinks, workspaceSettings, stopHolding]);
  useLayoutEffect(() => {
    const view = comparison.current;
    if (view === null || pane.current === null) return;
    stopHolding();
    const sides = view.before === undefined ? [view.after.view.dom] : [view.before.view.dom, view.after.view.dom];
    const previous = snapshotRows(sides, pane.current);
    const hold = header.current === null ? null : holdRevisionRow(pane.current, header.current, view);
    heldRow.current = hold;
    cancelRowMotion(sides);
    view.setCollapse(collapseUnchanged);
    setRows(view.model.rows);
    const anchor = hold?.align();
    const positions = new Map(previous.positions);
    if (anchor != null) positions.set(anchor.key, anchor.top);
    animateRows(sides, { ...previous, positions }, pane.current);
    hold?.follow();
    return stopHolding;
  }, [collapseUnchanged, stopHolding]);
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
  const entry = selection?.entry;
  const entries = selection?.entries;
  const selected = entries?.findIndex(item => item.id === entry?.id) ?? -1;
  const comparedWith = selection?.comparedWith;
  const comparedAttribution = comparisonAttribution(history, now);
  const restoreBefore = comparedWith?.name != null;
  const restoreTarget = restoreBefore ? comparedWith : entry;
  const restoreLabel = comparedWith?.name == null ? "Restore this version" : `Restore “${comparedWith.name.text}”`;
  const predecessor = selection === null ? undefined : selection.comparedWith ?? entries?.[selected + 1];
  const total = entries?.length ?? 0;
  const before = editors.find((entry) => entry.side === "before")?.editor;
  const after = editors.find((entry) => entry.side === (split ? "after" : "single"))?.editor;
  const restoreUnavailable = restoreUnavailableReason(history, writable, archived);
  const restore = async (): Promise<void> => {
    if (restoreUnavailable !== null || restoreTarget === undefined) return;
    try {
      const applied = await history.restore(restoreTarget.id);
      toast.success(applied ? "Document restored to this version" : "The document already has this version. Nothing changed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't restore this version. Refresh history and try again.");
    }
  };
  const restoreButton = <RevisionRestoreButton label={restoreLabel} unavailable={restoreUnavailable} reasonId={restoreReason} restore={restore} />;
  return <section ref={pane} className={`ub-pane ub-page-pane ub-document-pane ub-revision-pane${selection?.before != null ? " ub-revision-comparison-pane" : ""}${split ? " ub-revision-split-pane" : ""}`}>
    <div className="ub-column">
      {/* Stays in view while the comparison scrolls; revisions keep no tags. */}
      <header ref={header} className="ub-revision-header">
        <div className="ub-revision-heading">
          <RevisionTitle title={selection === null ? live?.title?.text ?? "" : title} index={selection?.index ?? -1} />
          {!split && restoreButton}
        </div>
        {restoreUnavailable !== null && <p id={restoreReason} className={archived || !writable ? "m-0 ub-type-small text-(--muted-foreground)" : "sr-only"}>{restoreUnavailable}</p>}
        {selection === null ? <p role="status" className="ub-history-controls ub-type-small">Loading history…</p>
          : <RevisionStatus history={history} writable={writable && !archived} now={now} />}
        {selection?.before != null && after !== undefined && rows.length > 0 && <>
          <ChangeNavigation pane={pane} header={header} before={before} after={after} rows={rows} onNavigate={stopHolding} />
          <RevisionRuler pane={pane} header={header} side={after.view.dom} rows={rows} />
        </>}
      </header>
      {selection !== null && failed === selection.after && <p role="status">This client cannot display this revision. Update the client and try again.</p>}
      {selection === null ? null : split ? <div ref={body} className="ub-revision-split ub-revision-comparison">
        <div className="ub-revision-side-label">
          <span>Before · {authorName(predecessor, predecessor !== undefined && predecessor.id === entries?.[total - 1]?.id)}{comparedWith !== undefined && predecessor?.name != null && <> · “{predecessor.name.text}”</>}</span>
          {restoreBefore && restoreButton}
        </div>
        <div className="ub-revision-side-label">
          <RevisionAfterLabel entry={entry} earliest={selected + 1 >= total} comparison={comparedAttribution} showName={comparedWith !== undefined} />
          {!restoreBefore && restoreButton}
        </div>
        <div className="ub-revision-side ub-revision-side-before">
          <div className="ub-editor-frame ub-revision-view"><div className="ub-editor" ref={beforeHost} /></div>
        </div>
        <div className="ub-revision-side ub-revision-side-after">
          <div className="ub-editor-frame ub-revision-view"><div className="ub-editor" ref={afterHost} /></div>
        </div>
      </div> : <div ref={body} className={`ub-editor-frame ub-revision-view${selection.before !== null ? " ub-revision-inline ub-revision-comparison" : ""}`}><div className="ub-editor" ref={host} /></div>}
      {editors.map(({ side, editor }) => <CardButtonControls key={side} editor={editor} canWrite={() => false} />)}
    </div>
  </section>;
}

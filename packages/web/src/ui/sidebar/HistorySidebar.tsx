/**
 * The sidebar pane that replaces the document list while history is open:
 * newest-first sessions and individual revisions, grouped by day.
 */

import { useState, type ReactElement } from "react";
import { renamedFrom } from "../document/document-history.js";
import type { DocumentHistory } from "../document/document-history.js";
import { historyCacheMessage, newestHistoryLabel } from "../document/history-presentation.js";
import { revisionAuthor, revisionAuthors, revisionGroups, revisionSpan, revisionTime, type RevisionAuthor, type RevisionItem } from "../document/revision-list.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { SidebarContent as SidebarScrollContent, SidebarHeader } from "../shadcn/sidebar.js";
import { Button } from "../shadcn/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../shadcn/collapsible.js";
import { PreviousIcon, TagIcon } from "../document/history-icons.js";

const ROW_CLASSES = "ub-history-entry flex w-full min-w-0 items-center gap-2.5 px-4 py-2 text-left text-(--sidebar-row-foreground) min-h-11 enabled:hover:bg-(--sidebar-accent) aria-[current=true]:bg-(--sidebar-accent) aria-[current=true]:text-sidebar-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring";

function Avatars({ authors }: { authors: (RevisionAuthor & { key: string })[] }): ReactElement {
  return <span className="ub-history-avatars flex shrink-0 flex-col -space-y-3" aria-hidden="true">
    {authors.map(author => <span key={author.key} className={`ub-history-avatar bg-sidebar${author.agent ? " ub-history-avatar-agent" : ""}`}>{author.initial}</span>)}
  </span>;
}

function RevisionRow({ item: { entry, index }, history, selected, now }: {
  item: RevisionItem; history: DocumentHistory; selected: number | null; now: number;
}): ReactElement {
  const entries = history.entries ?? [];
  const author = revisionAuthor(entry, index === entries.length - 1);
  const time = revisionTime(entry);
  const latest = index === 0;
  const when = entry.endedAt === null || time === null ? null : formatTimestamp(time, now);
  const name = entry.name?.text;
  const renamed = renamedFrom(entries, history.titles, index) !== null;
  return <li>
    <Button variant="plain" size="custom" type="button" className={ROW_CLASSES} aria-current={index === selected ? "true" : undefined}
      onClick={() => history.open(index)}>
      <Avatars authors={[{ ...author, key: entry.id }]} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {name !== undefined && <span className="ub-history-name flex min-w-0 items-center gap-1.5 ub-type-ui font-semibold text-sidebar-foreground" title={name}>
          <TagIcon /><span className="min-w-0 truncate">{name}</span>
        </span>}
        <span className={`min-w-0 truncate ${name === undefined ? "ub-type-ui font-medium text-sidebar-foreground" : "ub-type-caption text-(--sidebar-muted-foreground)"}`}>
          {author.name}{author.surface !== "" && <span className="font-normal text-(--sidebar-muted-foreground)"> {author.surface}</span>}
        </span>
        {(latest || when !== null || renamed) && <span className="ub-type-caption text-(--sidebar-muted-foreground)">
          {latest && newestHistoryLabel(history)}{latest && when !== null && " · "}
          {when !== null && <time dateTime={when.dateTime} title={when.title}>{when.label}</time>}
          {renamed && <span className="ub-history-renamed-tag">{latest || when !== null ? " · renamed" : "renamed"}</span>}
        </span>}
      </span>
    </Button>
    {name !== undefined && index > 0 && <Button variant="plain" size="custom" type="button" className="ub-history-since mb-1 ml-[3.25rem] p-0 ub-type-caption text-(--sidebar-muted-foreground) underline-offset-2 hover:underline aria-[current=true]:text-sidebar-foreground"
      aria-current={history.selection?.index === 0 && history.selection.comparedWith?.id === entry.id ? "true" : undefined}
      onClick={() => history.sinceNamed(entry.id)}>Changes since this name</Button>}
  </li>;
}

function SessionRow({ item, history, selected, revealIndex, now }: {
  item: RevisionItem; history: DocumentHistory; selected: number | null; revealIndex: number | null; now: number;
}): ReactElement {
  const revisions = item.revisions ?? [];
  const revealed = revisions.find(revision => revision.index === revealIndex);
  const reveal = revealed?.entry.id ?? null;
  const [expansion, setExpansion] = useState({ open: reveal !== null, reveal });
  if (expansion.reveal !== reveal) setExpansion({ open: reveal !== null || expansion.open, reveal });
  const open = expansion.open || (reveal !== expansion.reveal && reveal !== null);
  const authors = revisionAuthors(revisions.map(revision => revision.entry));
  const span = revisionSpan(revisions.map(revision => revision.entry), now);
  const current = history.selection?.index === item.index && history.selection.comparedWith?.id === item.before?.id;
  return <Collapsible asChild open={open} onOpenChange={open => setExpansion({ open, reveal })}>
    <li className="ub-history-session">
      <div className="flex min-w-0 items-start">
        <Button variant="plain" size="custom" type="button" className={`${ROW_CLASSES} ub-history-session-entry flex-1 pr-1`}
          aria-current={current ? "true" : undefined} onClick={() => { if (item.before !== undefined) history.openSession(item.index, item.before.id); }}>
          <Avatars authors={authors} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {revisions.flatMap(({ entry }) => entry.name == null ? [] : [<span key={entry.id} className="ub-history-name flex min-w-0 items-start gap-1.5 ub-type-ui font-semibold text-sidebar-foreground">
              <TagIcon /><span className="min-w-0 wrap-anywhere">{entry.name.text}</span>
            </span>])}
            <span className="ub-type-ui font-medium text-sidebar-foreground wrap-anywhere">{authors.map(author => `${author.name}${author.surface === "" ? "" : ` ${author.surface}`}`).join(", ")}</span>
            <span className="ub-type-caption text-(--sidebar-muted-foreground)" title={span.title}>{item.index === 0 && `${newestHistoryLabel(history)} · `}{span.label}</span>
          </span>
        </Button>
        <CollapsibleTrigger asChild>
          <Button variant="plain" size="custom" type="button" aria-label={open ? "Collapse session" : "Expand session"}
            className="grid min-h-11 w-8.5 shrink-0 place-items-center text-(--sidebar-muted-foreground) hover:bg-(--sidebar-accent) [@media(any-pointer:coarse)]:w-11">
            <span className={`[&_svg]:size-4 ${open ? "-rotate-90" : "rotate-180"}`}><PreviousIcon /></span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent><ul className="m-0 list-none p-0 pl-4">
        {revisions.map(revision => <RevisionRow key={revision.entry.id} item={revision} history={history} selected={selected} now={now} />)}
      </ul></CollapsibleContent>
      {/* Collapsing hides the other revisions without changing or hiding the selected view. */}
      {!open && revealed !== undefined && <ul className="m-0 list-none p-0 pl-4"><RevisionRow item={revealed} history={history} selected={selected} now={now} /></ul>}
    </li>
  </Collapsible>;
}

export function HistorySidebar({ history, title, onNow = history.now }: {
  history: DocumentHistory;
  title: string;
  onNow?: () => void;
}): ReactElement {
  const { filter, setFilter } = history;
  const now = useTimestampClock();
  const entries = history.entries ?? [];
  const groups = revisionGroups(entries, now, filter === "named");
  const selected = filter === "named" || history.selection?.comparedWith === undefined ? history.selection?.index ?? null : null;
  const revealIndex = selected ?? (history.selection?.index === 0 && history.selection.comparedWith?.name != null
    ? entries.findIndex(entry => entry.id === history.selection?.comparedWith?.id) : null);
  const count = entries.length === 1 ? "1 revision" : `${entries.length} revisions`;
  const cacheMessage = historyCacheMessage(history);
  return (
    <>
      <SidebarHeader className="pr-12 [@media(any-pointer:coarse)]:pr-15 pb-1">
        <Button variant="plain" size="custom"
          type="button"
          className="ub-history-back flex min-h-8.5 w-full items-center gap-2 rounded-(--radius-sm) border border-transparent px-2 py-1.5 text-left ub-type-ui text-(--sidebar-row-foreground) hover:bg-(--sidebar-accent) hover:text-sidebar-foreground"
          onClick={onNow}
        >
          <span className="grid size-7 shrink-0 place-items-center [&_svg]:size-4" aria-hidden="true"><PreviousIcon /></span>
          Back to now
        </Button>
      </SidebarHeader>
      {/* Below the sidebar's own close control, so these use its full width. */}
      <div className="flex min-w-0 shrink-0 flex-col gap-1 px-2 pb-2">
        <div className="min-w-0 px-2">
          <h2 className="m-0 ub-type-ui font-semibold text-sidebar-foreground">History</h2>
          <p className="m-0 ub-type-caption text-(--sidebar-muted-foreground) truncate">
            {title || "Untitled"}{history.entries === null ? "" : ` · ${count}`}
          </p>
        </div>
        <fieldset className="ub-history-filter mx-2 mt-1 mb-0 flex min-w-0 rounded-(--radius-sm) border-0 bg-(--sidebar-accent) p-0.5" aria-label="Show revisions">
          {(["all", "named"] as const).map((value) => (
            <Button variant="plain" size="custom" key={value} type="button" aria-pressed={filter === value}
              className="flex-1 rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1 ub-type-caption font-medium text-(--sidebar-muted-foreground) aria-pressed:bg-background aria-pressed:text-sidebar-foreground"
              onClick={() => setFilter(value)}>
              {value === "all" ? "All" : "Named"}
            </Button>
          ))}
        </fieldset>
        <fieldset className="ub-history-comparison-view mx-2 mb-0 flex min-w-0 rounded-(--radius-sm) border-0 bg-(--sidebar-accent) p-0.5" aria-label="Comparison view">
          {(["split", "inline"] as const).map((value) => (
            <Button variant="plain" size="custom" key={value} type="button" aria-pressed={history.comparisonView === value}
              className="flex-1 rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1 ub-type-caption font-medium text-(--sidebar-muted-foreground) aria-pressed:bg-background aria-pressed:text-sidebar-foreground"
              onClick={() => history.setComparisonView(value)}>
              {value === "split" ? "Split" : "Inline"}
            </Button>
          ))}
        </fieldset>
        <label className="ub-history-collapse flex min-h-8.5 [@media(any-pointer:coarse)]:min-h-11 cursor-pointer items-center justify-between gap-2 px-2 ub-type-caption text-(--sidebar-muted-foreground)">
          Collapse unchanged
          <input type="checkbox" role="switch" className="ub-history-switch" checked={history.collapseUnchanged} aria-checked={history.collapseUnchanged}
            onChange={(event) => history.setCollapseUnchanged(event.currentTarget.checked)} />
        </label>
      </div>
      <SidebarScrollContent className="pb-2 [&>*]:shrink-0">
        {cacheMessage !== null && <div className="px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">
          <p className="m-0">{cacheMessage}</p>
          {history.history?.refreshFailed === true && <Button variant="plain" size="custom" type="button" className="mt-1.5 p-0 ub-type-caption font-medium text-sidebar-foreground underline" onClick={history.refresh}>Refresh history</Button>}
        </div>}
        {history.error !== null && (
          <div className="px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">
            <p className="m-0">{history.error}</p>
            <Button variant="plain" size="custom" type="button" className="mt-1.5 p-0 ub-type-caption font-medium text-sidebar-foreground underline" onClick={history.retry}>Try again</Button>
          </div>
        )}
        {history.error === null && history.entries === null && history.busy && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">Loading history…</p>
        )}
        {history.entries !== null && entries.length === 0 && history.error === null && history.history?.complete !== false && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">No revisions yet</p>
        )}
        {filter === "named" && entries.length > 0 && groups.length === 0 && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)">No named revisions yet</p>
        )}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="m-0 px-4 pt-3.5 pb-1.5 ub-type-caption font-medium text-(--sidebar-muted-foreground)">{group.label}</h3>
            <ul className="m-0 list-none p-0">
              {group.items.map(item => item.revisions === undefined
                ? <RevisionRow key={item.entry.id} item={item} history={history} selected={selected} now={now} />
                : <SessionRow key={item.entry.id} item={item} history={history} selected={selected} revealIndex={revealIndex} now={now} />)}
            </ul>
          </section>
        ))}
      </SidebarScrollContent>
    </>
  );
}

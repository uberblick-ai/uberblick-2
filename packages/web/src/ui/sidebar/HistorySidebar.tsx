/**
 * The sidebar pane that replaces the document list while history is open:
 * every revision newest first, grouped by day, each opening that revision.
 */

import type { ReactElement } from "react";
import { renamedFrom } from "../document/document-history.js";
import type { DocumentHistory } from "../document/document-history.js";
import { revisionAuthor, revisionGroups, revisionTime } from "../document/revision-list.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { SidebarContent as SidebarScrollContent, SidebarHeader } from "../shadcn/sidebar.js";
import { Button } from "../shadcn/button.js";
import { PreviousIcon, TagIcon } from "../document/history-icons.js";

const ROW_CLASSES = "ub-history-entry flex w-full min-w-0 items-center gap-2.5 px-4 py-2 text-left text-(--sidebar-row-foreground) min-h-11 enabled:hover:bg-(--sidebar-accent) aria-[current=true]:bg-(--sidebar-accent) aria-[current=true]:text-sidebar-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring";

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
  const count = entries.length === 1 ? "1 revision" : `${entries.length} revisions`;
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
            <Button variant="plain" size="custom" key={value} type="button" aria-pressed={filter === value} disabled={history.busy}
              className="flex-1 rounded-[calc(var(--radius-sm)-2px)] px-2.5 py-1 ub-type-caption font-medium text-(--sidebar-muted-foreground) aria-pressed:bg-background aria-pressed:text-sidebar-foreground"
              onClick={() => setFilter(value)}>
              {value === "all" ? "All" : "Named"}
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
        {history.error !== null && (
          <div className="px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">
            <p className="m-0">{history.error}</p>
            <Button variant="plain" size="custom" type="button" className="mt-1.5 p-0 ub-type-caption font-medium text-sidebar-foreground underline" onClick={history.retry}>Try again</Button>
          </div>
        )}
        {history.error === null && history.entries === null && history.busy && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">Loading history…</p>
        )}
        {history.entries !== null && entries.length === 0 && history.error === null && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)" role="status">No revisions yet</p>
        )}
        {filter === "named" && entries.length > 0 && groups.length === 0 && (
          <p className="m-0 px-4 py-2 ub-type-caption text-(--sidebar-muted-foreground)">No named revisions yet</p>
        )}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="m-0 px-4 pt-3.5 pb-1.5 ub-type-caption font-medium text-(--sidebar-muted-foreground)">{group.label}</h3>
            <ul className="m-0 list-none p-0">
              {group.items.map(({ entry, index }) => {
                const author = revisionAuthor(entry, index === entries.length - 1);
                const time = revisionTime(entry);
                // The newest entry is what the live document shows, even while its revision is still open.
                const latest = index === 0;
                const when = entry.endedAt === null || time === null ? null : formatTimestamp(time, now);
                const name = entry.name?.text;
                const current = index === selected;
                const renamed = renamedFrom(entries, history.titles, index) !== null;
                return (
                  <li key={entry.id}>
                    <Button variant="plain" size="custom" type="button" className={ROW_CLASSES} aria-current={current ? "true" : undefined}
                      onClick={() => history.open(index)}>
                      <span className={`ub-history-avatar${author.agent ? " ub-history-avatar-agent" : ""}`} aria-hidden="true">{author.initial}</span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {name !== undefined && (
                          <span className="ub-history-name flex min-w-0 items-center gap-1.5 ub-type-ui font-semibold text-sidebar-foreground" title={name}>
                            <TagIcon />
                            <span className="min-w-0 truncate">{name}</span>
                          </span>
                        )}
                        <span className={`min-w-0 truncate ${name === undefined ? "ub-type-ui font-medium text-sidebar-foreground" : "ub-type-caption text-(--sidebar-muted-foreground)"}`}>
                          {author.name}{author.surface !== "" && <span className="font-normal text-(--sidebar-muted-foreground)"> {author.surface}</span>}
                        </span>
                        {(latest || when !== null || renamed) && (
                          <span className="ub-type-caption text-(--sidebar-muted-foreground)">
                            {latest && "Current version"}{latest && when !== null && " · "}
                            {when !== null && <time dateTime={when.dateTime} title={when.title}>{when.label}</time>}
                            {renamed && <span className="ub-history-renamed-tag">{latest || when !== null ? " · renamed" : "renamed"}</span>}
                          </span>
                        )}
                      </span>
                    </Button>
                    {name !== undefined && index > 0 && (
                      <Button variant="plain" size="custom" type="button" className="ub-history-since mb-1 ml-[3.25rem] p-0 ub-type-caption text-(--sidebar-muted-foreground) underline-offset-2 hover:underline aria-[current=true]:text-sidebar-foreground"
                        aria-current={history.selection?.index === 0 && history.selection.comparedWith?.id === entry.id ? "true" : undefined}
                        onClick={() => history.sinceNamed(entry.id)}>
                        Changes since this name
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </SidebarScrollContent>
    </>
  );
}

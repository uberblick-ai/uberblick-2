/** Directory stubs supply rows; search supplies record UUIDs without opening rooms. */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { decisionCurrentRecord, readDirectoryTags, resolveDecisionTopics } from "@uberblick/schema";
import type { DecisionTopicState, DirectoryEntry, SidebarGroup, TagAssignment, TagCatalogEntry } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";
import { LifecycleBadge } from "../ui/document/LifecycleBadge.js";
import { TOPIC_STATES } from "../ui/document/decision-state.js";
import { formatTimestamp, useTimestampClock } from "../ui/timestamps.js";
import { PickerList } from "../ui/PickerList.js";
import { useTagCatalog } from "../ui/tags.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/shadcn/popover.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/shadcn/tabs.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/shadcn/tooltip.js";
import { documentSearchRows, rankDocumentSearchRows, usableDocumentStamp, useDocumentSearch } from "./document-search-results.js";
import type { DocumentSearchSource } from "./document-search-results.js";

/** Use code-unit title/UUID order so the list and list_docs agree across replicas. */
function byTitle(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

/** The two sortable columns, in their visual order. */
const ORDERS = ["title", "changed"] as const;

type Order = (typeof ORDERS)[number];
type Direction = "ascending" | "descending";

const ORDER_LABELS: Record<Order, string> = {
  changed: "Changed",
  title: "Title",
};

const INITIAL_DIRECTION: Record<Order, Direction> = {
  changed: "descending",
  title: "ascending",
};

const MODES = ["working", "decision"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABELS: Record<Mode, string> = {
  working: "Documents",
  decision: "Decisions",
};

const MODE_EMPTY_LABELS: Record<Mode, string> = {
  working: "documents",
  decision: "decisions",
};

const STATE_FILTERS = ["all", "not-yet-decided", "under-review", "agent-stance", "conflict", "changed-after-approval"] as const;
type StateFilter = (typeof STATE_FILTERS)[number];
const STATE_LABELS: Record<StateFilter, string> = {
  all: "All",
  "not-yet-decided": TOPIC_STATES["not-yet-decided"],
  "under-review": TOPIC_STATES["under-review"],
  "agent-stance": TOPIC_STATES["agent-stance"],
  conflict: TOPIC_STATES.conflict,
  "changed-after-approval": "Changed after approval",
};

export interface DocumentListState {
  query: string;
  mode: Mode;
  stateFilter: StateFilter;
  selectedTags: string[];
  relevance: boolean;
  sort: { order: Order; direction: Direction };
}

export const INITIAL_DOCUMENT_LIST_STATE: DocumentListState = {
  query: "",
  mode: "working",
  stateFilter: "all",
  selectedTags: [],
  relevance: false,
  sort: { order: "changed", direction: INITIAL_DIRECTION.changed },
};

/** The list shows only a topic's latest stage; the topic page carries the detail. */
type Stage = "in-effect" | "under-discussion";

const STAGE_LABELS: Record<Stage, string> = {
  "in-effect": "In effect",
  "under-discussion": "Under discussion",
};

/** An answer in force with nothing pending is in effect; anything still open is under discussion. */
function topicStage(state: DecisionTopicState): Stage {
  return state === "in-force" || state === "agent-stance" ? "in-effect" : "under-discussion";
}

function inMode(entry: DirectoryEntry, mode: Mode): boolean {
  return mode === "working" ? entry.kind === undefined : entry.kind === mode;
}

/**
 * Total orders avoid row shifts: title then UUID breaks equal stamps too.
 * Missing/unusable stamps sort last only in changed order; title order still
 * sorts them by title. Absence must not masquerade as an ancient timestamp.
 */
export function sortDirectory<T extends DirectoryEntry>(
  entries: readonly T[],
  order: Order,
  direction: Direction,
): T[] {
  if (order === "title") {
    return [...entries].sort((a, b) =>
      direction === "ascending" ? byTitle(a, b) : byTitle(b, a),
    );
  }
  return [...entries].sort((a, b) => {
    const left = usableDocumentStamp(a.updatedAt);
    const right = usableDocumentStamp(b.updatedAt);
    if (left === undefined || right === undefined) {
      if (left === right) return byTitle(a, b);
      return left === undefined ? 1 : -1;
    }
    if (left === right) return byTitle(a, b);
    return direction === "ascending" ? left - right : right - left;
  });
}

/** Name each pin's document so identical row buttons remain distinguishable. */
function pinLabel(entry: DirectoryEntry, pinned: boolean): string {
  const named = entry.title === "" ? "Untitled" : entry.title;
  return pinned ? `Unpin ${named} from the sidebar` : `Pin ${named} to the sidebar`;
}

/** Keep exact dateTime; expose exact time on hover while the age label is relative. */
function ChangedStamp({
  at,
  now,
}: {
  at: number | undefined;
  now: number;
}): ReactElement {
  const formatted = at === undefined ? null : formatTimestamp(at, now);
  if (formatted === null) {
    return <span className="ub-docs-age ub-muted">—</span>;
  }
  return (
    <time
      className="ub-docs-age"
      dateTime={formatted.dateTime}
      title={formatted.title}
    >
      {formatted.label}
    </time>
  );
}

function PinIcon({ active }: { active: boolean }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ub-docs-pin-icon block size-4">
      <path
        d="M9 3h6l-1 6 3 3v2h-4v7l-2-2v-5H7v-2l3-3-1-6Z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function namedTag(tag: TagAssignment): tag is TagCatalogEntry {
  return tag.name !== null;
}

function tagLabel(tag: TagCatalogEntry): string {
  return tag.state === "retired" ? `${tag.name} (retired)` : tag.name;
}

function FilterChevron(): ReactElement {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="ub-docs-filter-chevron"><path d="m6 9 6 6 6-6" /></svg>;
}

function TagFilter({
  options,
  selected,
  labels,
  onChange,
}: {
  options: readonly TagCatalogEntry[];
  selected: readonly string[];
  labels: readonly string[];
  onChange: (tags: string[]) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const showSearch = options.length >= 10;
  const needle = showSearch ? query.trim().toLowerCase() : "";
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button type="button" className="ub-docs-tag-filter ub-docs-filter-control" aria-label="Filter by tags" aria-haspopup="listbox" aria-controls={open ? listId : undefined}>
          Tag <span className="ub-docs-filter-value">{labels.length === 0 ? "Any" : labels.join(", ")}</span><FilterChevron />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="ub-docs-tag-picker p-0">
        {showSearch && <label className="block border-b border-border p-2">
          <span className="ub-sr-only">Find tags</span>
          <input type="search" className="w-full rounded-(--radius-sm) border border-border bg-transparent px-2 py-1 [font:inherit]" placeholder="Find tags" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>}
        <PickerList id={listId} label="Tags" multiple options={options.filter((tag) => needle === "" || tag.name.toLowerCase().includes(needle)).map((tag) => ({ id: tag.id, label: tag.name, selected: selected.includes(tag.id) }))} onPick={(id) => onChange(selected.includes(id) ? selected.filter((tag) => tag !== id) : [...selected, id])} empty={needle === "" ? "No active tags." : "No tags match."} />
        <button type="button" className="ub-docs-clear-tags" disabled={selected.length === 0} onClick={() => onChange([])}>Clear tags</button>
      </PopoverContent>
    </Popover>
  );
}

/** Layout measures the stored-order prefix; Radix owns overflow interaction. */
function RowTags({ tags, title, onPick }: { tags: readonly TagCatalogEntry[]; title: string; onPick: (id: string) => void }): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const measure = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(tags.length);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const wrapper = container.current;
    const probe = measure.current;
    if (wrapper === null || probe === null) return;
    const measurePrefix = (): void => {
      const width = wrapper.getBoundingClientRect().width;
      if (width === 0) return;
      const chips = Array.from(probe.children, (chip) => chip.getBoundingClientRect().width);
      const moreWidth = chips.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(wrapper).columnGap) || 0;
      let used = 0;
      let count = 0;
      for (const chip of chips) {
        const next = used + (count === 0 ? 0 : gap) + chip;
        const rest = count + 1 < tags.length ? gap + moreWidth : 0;
        if (next + rest > width) break;
        used = next;
        count += 1;
      }
      setVisible(count);
    };
    measurePrefix();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measurePrefix);
    observer.observe(wrapper);
    for (const chip of probe.children) observer.observe(chip);
    return () => observer.disconnect();
  }, [tags]);
  const shown = Math.min(visible, tags.length);
  return (
    <div ref={container} className="ub-docs-tags">
      <div ref={measure} aria-hidden="true" className="ub-docs-tag-measure">
        {tags.map((tag) => <span key={tag.id} className="ub-docs-tag-chip">{tagLabel(tag)}</span>)}
        <span className="ub-docs-tag-chip">+{tags.length}</span>
      </div>
      {tags.slice(0, shown).map((tag) => <button key={tag.id} type="button" className="ub-docs-tag-chip" onClick={() => onPick(tag.id)}>{tagLabel(tag)}</button>)}
      {shown < tags.length && <Popover open={open} onOpenChange={setOpen}>
        <TooltipProvider><Tooltip>
          <TooltipTrigger asChild><PopoverTrigger asChild>
            <button type="button" className="ub-docs-tag-chip" aria-label={`Show all tags for ${title === "" ? "Untitled" : title}`}>+{tags.length - shown}</button>
          </PopoverTrigger></TooltipTrigger>
          {!open && <TooltipContent>{tags.map(tagLabel).join(", ")}</TooltipContent>}
        </Tooltip></TooltipProvider>
        <PopoverContent align="start" className="flex flex-wrap gap-1" aria-label={`All tags for ${title === "" ? "Untitled" : title}`}>
          {tags.map((tag) => <button key={tag.id} type="button" className="ub-docs-tag-chip" onClick={() => { onPick(tag.id); setOpen(false); }}>{tagLabel(tag)}</button>)}
        </PopoverContent>
      </Popover>}
    </div>
  );
}

function noMatchesMessage({ mode, stateFilter, selectedLabels, query, synced, hasFilters, hasDocuments }: { mode: Mode; stateFilter: StateFilter; selectedLabels: readonly string[]; query: string; synced: boolean; hasFilters: boolean; hasDocuments: boolean }): string {
  if (hasFilters) return `No ${MODE_EMPTY_LABELS[mode]}${synced ? "" : " synced so far"}${mode === "decision" && stateFilter !== "all" ? ` with state "${STATE_LABELS[stateFilter]}"` : ""}${selectedLabels.length === 0 ? "" : ` tagged ${selectedLabels.map((label) => `"${label}"`).join(" or ")}`}${query.trim() === "" ? "." : ` match "${query}".`}`;
  if (hasDocuments) return synced ? "No documents in this workspace." : "No documents among the documents synced so far.";
  return synced ? "No documents in this workspace yet." : "Nothing here yet — the directory has not synced on this client.";
}

/** Each tab counts its whole type, so filtering never moves the numbers. */
function DocumentTypeTabs({ entries, received }: { entries: readonly DirectoryEntry[]; received: boolean }): ReactElement {
  const counts: Record<Mode, number> = useMemo(() => ({
    working: entries.filter((entry) => !entry.deleted && inMode(entry, "working")).length,
    decision: resolveDecisionTopics(entries).filter((topic) => !topic.archived && decisionCurrentRecord(topic) !== null).length,
  }), [entries]);
  return <TabsList aria-label="Document type" className="ub-docs-tabs">
    {MODES.map((option) => (
      <TabsTrigger
        key={option}
        value={option}
        className="ub-docs-tab"
      >
        {MODE_LABELS[option]}
        {received && <span className="ub-docs-tab-count">{counts[option]}</span>}
      </TabsTrigger>
    ))}
  </TabsList>;
}

export function DocumentList({
  connection,
  entries,
  groups,
  catalog: catalogConnection = null,
  searchClient = null,
  onSelect,
  onTogglePin,
  state,
  onStateChange,
}: {
  /** Directory sync distinguishes an empty corpus from a not-yet-arrived listing. */
  connection: RoomConnection | null;
  /** Include tombstones: only the first record's tombstone archives its topic. */
  entries: readonly DirectoryEntry[];
  /** The sidebar as it stands: which group, if any, a row is pinned in. */
  groups: readonly SidebarGroup[];
  catalog?: RoomConnection | null;
  searchClient?: DocumentSearchSource;
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null until the sidebar is writable and synced. */
  onTogglePin: ((uuid: string) => void) | null;
  state?: DocumentListState;
  onStateChange?: (state: DocumentListState) => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const pinUnavailableId = useId();
  const [localState, setLocalState] = useState(INITIAL_DOCUMENT_LIST_STATE);
  const listState = state ?? localState;
  const { query, stateFilter, sort } = listState;
  const selectedTags = listState.selectedTags ?? [];
  const relevance = listState.relevance ?? query.trim() !== "";
  const catalog = useTagCatalog(catalogConnection);
  const selectedAssignments = catalog === null
    ? selectedTags.map((id) => ({ id, name: null, state: "unresolved" as const }))
    : readDirectoryTags({ tags: selectedTags }, catalog.connection.ydoc);
  const selectedIds = selectedAssignments.map((tag) => tag.id);
  const selectedLabels = selectedAssignments.map((tag) => tag.name ?? "Unknown tag");
  const searchText = query.trim();
  const { hits, unavailable: searchUnavailable, pending: searchPending } = useDocumentSearch(searchText, searchClient, entries);
  // Browser history may contain a type removed by a newer client.
  const mode: Mode = listState.mode === "decision" ? "decision" : "working";
  const updateState = (patch: Partial<DocumentListState>): void => {
    const next = { ...listState, mode, selectedTags, relevance, ...patch };
    setLocalState(next);
    onStateChange?.(next);
  };
  const now = useTimestampClock();
  const modeRows = useMemo(() => documentSearchRows(entries, groups).filter((entry) => inMode(entry, mode)), [entries, groups, mode]);
  const rowTags = useMemo(() => new Map(modeRows.map((entry) => [entry.uuid, catalog === null ? [] : readDirectoryTags(entry, catalog.connection.ydoc)])), [modeRows, catalog]);
  const rows = useMemo(
    () => {
      const filtered = modeRows.filter((entry) => (selectedIds.length === 0 || (rowTags.get(entry.uuid) ?? []).some((tag) => selectedIds.includes(tag.id))) && (mode !== "decision" || stateFilter === "all"
        || (stateFilter === "changed-after-approval" ? entry.approvalChanged : entry.topicState === stateFilter)));
      if (searchText === "") return sortDirectory(filtered, sort.order, sort.direction);
      if (searchUnavailable || searchPending) return [];
      const ranked = rankDocumentSearchRows(filtered, hits);
      return relevance ? ranked : sortDirectory(ranked, sort.order, sort.direction);
    },
    [modeRows, mode, searchText, searchUnavailable, searchPending, hits, selectedIds, rowTags, stateFilter, sort, relevance],
  );
  const hasFilters = searchText !== "" || mode === "decision" || selectedTags.length > 0 || stateFilter !== "all";
  const emptyMessage = noMatchesMessage({ mode, stateFilter, selectedLabels, query, synced: status.synced, hasFilters, hasDocuments: entries.some((entry) => !entry.deleted) });

  return (
    <section className="ub-pane ub-page-pane">
      <Tabs className="ub-column ub-docs" value={mode} onValueChange={(value) => {
        const option = MODES.find((candidate) => candidate === value);
        if (option !== undefined) updateState({ mode: option });
      }}>
        <header className="ub-page-header">
          <h1 className="ub-title ub-docs-heading">All documents</h1>
          <DocumentTypeTabs entries={entries} received={status.hasReceivedServerState} />
        </header>
        <TabsContent value={mode} tabIndex={-1} className="ub-docs-panel">
        <div className="ub-docs-filters">
          <label className="ub-docs-search-label">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="ub-docs-search-icon"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <span className="ub-sr-only">Search</span>
            <input
              type="search"
              className="ub-docs-search"
              placeholder={`Search ${MODE_EMPTY_LABELS[mode]}`}
              value={query}
              onChange={(event) => updateState({ query: event.currentTarget.value, relevance: true })}
            />
          </label>
          <div className="ub-docs-filter-group">
            <TagFilter options={(catalog?.entries ?? []).filter((tag) => tag.state === "active")} selected={selectedIds} labels={selectedLabels} onChange={(tags) => updateState({ selectedTags: tags })} />
            {mode === "decision" && <label className="ub-docs-state-filter ub-docs-filter-control">
              <span aria-hidden="true">State</span>
              <span aria-hidden="true" className="ub-docs-filter-value">{STATE_LABELS[stateFilter]}</span>
              <select
                aria-label="Decision state"
                className="ub-docs-state-select"
                value={stateFilter}
                onChange={(event) => {
                  const value = STATE_FILTERS.find((option) => option === event.currentTarget.value);
                  if (value !== undefined) updateState({ stateFilter: value });
                }}
              >
                {STATE_FILTERS.map((option) => <option key={option} value={option}>{STATE_LABELS[option]}</option>)}
              </select>
              <FilterChevron />
            </label>}
          </div>
        </div>
        {searchClient === null && searchText === "" && <p className="ub-docs-search-status ub-muted">Search is unavailable. Open this workspace with ub open to use local search.</p>}
        {onTogglePin === null && rows.length > 0 && (
          <p id={pinUnavailableId} className="ub-docs-pin-unavailable mb-2 mt-0 ub-type-small text-(--muted-foreground)">
            Pin changes unavailable while the sidebar is not ready to write.
          </p>
        )}
        <table className="ub-docs-table">
          <colgroup>
            <col />
            <col className={mode === "decision" ? "ub-docs-stage-column" : "ub-docs-group-column"} />
            <col className="ub-docs-tags-column" />
            <col className="ub-docs-age-column" />
            <col className="ub-docs-pin-column" />
          </colgroup>
          <thead>
            <tr>
              {(["title", "group", "tags", "changed"] as const).map((option) => option === "group" || option === "tags" ? (
                <th key={option} scope="col" className={`ub-docs-heading-cell ub-docs-heading-cell--${option}`}>{option === "tags" ? "Tags" : mode === "decision" ? "Stage" : "Group"}</th>
              ) : (
                <th
                  key={option}
                  scope="col"
                  className={`ub-docs-heading-cell ub-docs-heading-cell--${option}`}
                  aria-sort={!(searchText !== "" && relevance) && option === sort.order ? sort.direction : undefined}
                >
                  <button
                    type="button"
                    className={`ub-docs-sort flex min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 w-full cursor-pointer items-center gap-[0.3rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.4rem] py-1 [font:inherit] text-inherit hover:bg-(--accent) hover:text-(--accent-foreground) ${option === "changed" ? "justify-end" : ""}`}
                    onClick={() =>
                      updateState({ relevance: false, sort:
                        sort.order === option && !(searchText !== "" && relevance)
                          ? {
                              order: option,
                              direction:
                                sort.direction === "ascending"
                                  ? "descending"
                                  : "ascending",
                            }
                          : { order: option, direction: INITIAL_DIRECTION[option] },
                      })
                    }
                  >
                    {ORDER_LABELS[option]}
                    {!(searchText !== "" && relevance) && option === sort.order && (
                      <span className="ub-docs-sort-arrow" aria-hidden="true">
                        {sort.direction === "ascending" ? "↑" : "↓"}
                      </span>
                    )}
                  </button>
                </th>
              ))}
              <th scope="col" className="ub-docs-heading-cell">
                <span className="ub-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="ub-docs-empty-cell">
                  <p className="ub-muted ub-docs-empty" role={searchUnavailable || searchPending ? "status" : undefined}>
                    {searchUnavailable ? `Search is unavailable.${status.synced ? "" : " The directory covers only documents synced so far."}` : searchPending ? "Searching…" : emptyMessage}
                  </p>
                  {hasFilters && !searchPending && <button type="button" className="ub-docs-clear-filters" onClick={() => updateState({ query: "", selectedTags: [], mode: "working", stateFilter: "all", relevance: false })}>Clear filters</button>}
                </td>
              </tr>
            ) : (
              rows.map((entry) => (
                <tr
                  key={entry.uuid}
                  className="ub-docs-row hover:bg-(--accent) hover:text-(--accent-foreground)"
                >
                  <th scope="row" className="ub-docs-title-cell">
                    <button
                      type="button"
                      className={`ub-docs-open min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11`}
                      onClick={() => onSelect(entry.uuid)}
                      title={entry.uuid}
                    >
                      <span className="ub-docs-title">
                        {entry.title === "" ? <em>Untitled</em> : entry.title}
                      </span>
                      {/* Topic rows stay one line like every other row: the
                          answer, detailed state and comments live on the topic
                          page, and the state filter above narrows by state. */}
                      {entry.topicState === undefined && <LifecycleBadge kind={entry.kind} />}
                    </button>
                  </th>
                  {/* Decision records never sit in sidebar groups, so topics
                      use this column for their latest stage instead. */}
                  <td className="ub-docs-group-cell">
                    {entry.topicState === undefined
                      ? <span className="ub-docs-group">{entry.groupName}</span>
                      : <span className="ub-docs-stage" data-stage={topicStage(entry.topicState)}>{STAGE_LABELS[topicStage(entry.topicState)]}</span>}
                  </td>
                  <td className="ub-docs-tags-cell"><RowTags tags={(rowTags.get(entry.uuid) ?? []).filter(namedTag)} title={entry.title} onPick={(id) => updateState({ selectedTags: [id] })} /></td>
                  <td className="ub-docs-age-cell">
                    <ChangedStamp at={entry.updatedAt} now={now} />
                  </td>
                  {/* Curation from the one screen that shows every document —
                      the sidebar lists what is already pinned, so this is where
                      the long tail gets pinned from. The mark carries the state
                      and the row never changes width. */}
                  <td className="ub-docs-pin-cell">
                    <button
                      type="button"
                      className="ub-docs-pin min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 cursor-pointer rounded-(--radius-sm) border-0 bg-transparent p-1 font-[inherit] text-(--muted-foreground) opacity-0 [@media(hover:none)]:opacity-100 [@media(hover:hover)]:[.ub-docs-row:hover_&]:opacity-100 [.ub-docs-row:focus-within_&]:opacity-100 aria-pressed:opacity-100 hover:text-(--foreground)"
                      disabled={onTogglePin === null}
                      aria-describedby={onTogglePin === null ? pinUnavailableId : undefined}
                      aria-pressed={entry.pinned}
                      aria-label={
                        onTogglePin === null
                          ? `${pinLabel(entry, entry.pinned)} unavailable while sidebar is not ready to write`
                          : pinLabel(entry, entry.pinned)
                      }
                      title={
                        onTogglePin === null
                          ? "Pin unavailable while the sidebar is not ready to write"
                          : pinLabel(entry, entry.pinned)
                      }
                      onClick={() => onTogglePin?.(entry.uuid)}
                    >
                      <PinIcon active={entry.pinned} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </TabsContent>
      </Tabs>
    </section>
  );
}

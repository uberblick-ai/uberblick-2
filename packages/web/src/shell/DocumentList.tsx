/** Directory stubs supply rows; search supplies record UUIDs without opening rooms. */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { decisionCurrentRecord, decisionTopicState, readDirectoryTags, resolveDecisionTopics } from "@uberblick/schema";
import type { DecisionTopicState, DirectoryEntry, SidebarGroup, TagAssignment, TagCatalogEntry } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";
import { LifecycleBadge } from "../ui/document/LifecycleBadge.js";
import { TOPIC_STATES } from "../ui/document/decision-state.js";
import { formatTimestamp, useTimestampClock } from "../ui/timestamps.js";
import { PickerList } from "../ui/PickerList.js";
import { useTagCatalog } from "../ui/tags.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/shadcn/popover.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/shadcn/tooltip.js";
import type { DocumentSearchClient } from "./document-search.js";

/** Invalid Date ranges read as absent: a dash, last by changed, ordinary title order. */
function usableStamp(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  return Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

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

type ListRow = DirectoryEntry & { topicState?: DecisionTopicState; pinned: boolean; groupName: string | undefined; recordIds: readonly string[] };

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
    const left = usableStamp(a.updatedAt);
    const right = usableStamp(b.updatedAt);
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

type ListSearchClient = Pick<DocumentSearchClient, "search"> | null;

function useListSearch(query: string, client: ListSearchClient, entries: readonly DirectoryEntry[]): { hits: readonly string[]; unavailable: boolean; pending: boolean } {
  const [result, setResult] = useState<{ query: string; client: ListSearchClient; entries: readonly DirectoryEntry[]; hits: string[]; unavailable: boolean } | null>(null);
  useEffect(() => {
    if (query === "" || client === null) return;
    const request = new AbortController();
    void client.search(query, request.signal).then(
      (hits) => { if (!request.signal.aborted) setResult({ query, client, entries, hits, unavailable: false }); },
      () => { if (!request.signal.aborted) setResult({ query, client, entries, hits: [], unavailable: true }); },
    );
    return () => request.abort();
  }, [query, client, entries]);
  const current = result?.query === query && result.client === client ? result : null;
  const unavailable = query !== "" && (client === null || current?.unavailable === true);
  return { hits: current?.hits ?? [], unavailable, pending: query !== "" && !unavailable && current === null };
}

function noMatchesMessage({ mode, stateFilter, selectedLabels, query, synced, hasFilters, hasDocuments }: { mode: Mode; stateFilter: StateFilter; selectedLabels: readonly string[]; query: string; synced: boolean; hasFilters: boolean; hasDocuments: boolean }): string {
  if (hasFilters) return `No ${MODE_EMPTY_LABELS[mode]}${synced ? "" : " synced so far"}${mode === "decision" && stateFilter !== "all" ? ` with state "${STATE_LABELS[stateFilter]}"` : ""}${selectedLabels.length === 0 ? "" : ` tagged ${selectedLabels.map((label) => `"${label}"`).join(" or ")}`}${query.trim() === "" ? "." : ` match "${query}".`}`;
  if (hasDocuments) return synced ? "No documents in this workspace." : "No documents among the documents synced so far.";
  return synced ? "No documents in this workspace yet." : "Nothing here yet — the directory has not synced on this client.";
}

/** Each tab counts its whole type, so filtering never moves the numbers. */
function DocumentTypeTabs({ entries, received, mode, idPrefix, onSelect }: { entries: readonly DirectoryEntry[]; received: boolean; mode: Mode; idPrefix: string; onSelect: (mode: Mode) => void }): ReactElement {
  const tabs = useRef<HTMLDivElement | null>(null);
  const counts: Record<Mode, number> = useMemo(() => ({
    working: entries.filter((entry) => !entry.deleted && inMode(entry, "working")).length,
    decision: resolveDecisionTopics(entries).filter((topic) => !topic.archived && decisionCurrentRecord(topic) !== null).length,
  }), [entries]);
  const move = (from: Mode, step: number): void => {
    const next = MODES[(MODES.indexOf(from) + step + MODES.length) % MODES.length] ?? from;
    onSelect(next);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };
  return <div ref={tabs} role="tablist" aria-label="Document type" className="ub-docs-tabs">
    {MODES.map((option) => (
      <button
        key={option}
        id={`${idPrefix}-${option}`}
        type="button"
        role="tab"
        data-mode={option}
        className="ub-docs-tab"
        aria-selected={option === mode}
        aria-controls={`${idPrefix}-panel`}
        tabIndex={option === mode ? 0 : -1}
        onClick={() => onSelect(option)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(option, event.key === "ArrowRight" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            move(event.key === "Home" ? MODES[0] : MODES[MODES.length - 1] ?? option, 0);
          }
        }}
      >
        {MODE_LABELS[option]}
        {received && <span className="ub-docs-tab-count">{counts[option]}</span>}
      </button>
    ))}
  </div>;
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
  searchClient?: ListSearchClient;
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null until the sidebar is writable and synced. */
  onTogglePin: ((uuid: string) => void) | null;
  state?: DocumentListState;
  onStateChange?: (state: DocumentListState) => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const pinUnavailableId = useId();
  const tabsId = useId();
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
  const { hits, unavailable: searchUnavailable, pending: searchPending } = useListSearch(searchText, searchClient, entries);
  // Browser history may contain a type removed by a newer client.
  const mode: Mode = listState.mode === "decision" ? "decision" : "working";
  const updateState = (patch: Partial<DocumentListState>): void => {
    const next = { ...listState, mode, selectedTags, relevance, ...patch };
    setLocalState(next);
    onStateChange?.(next);
  };
  const now = useTimestampClock();
  /** Read actual sidebar groups; first group wins if a UUID appears twice. */
  const groupOf = useMemo(() => {
    const named = new Map<string, string>();
    for (const group of groups) {
      for (const uuid of group.docs) if (!named.has(uuid)) named.set(uuid, group.name);
    }
    return named;
  }, [groups]);
  const modeRows = useMemo<ListRow[]>(() => {
    if (mode !== "decision") return entries.filter((entry) => !entry.deleted && inMode(entry, mode))
      .map((entry) => ({ ...entry, pinned: groupOf.has(entry.uuid), groupName: groupOf.get(entry.uuid), recordIds: [entry.uuid] }));
    return resolveDecisionTopics(entries).filter((topic) => !topic.archived).flatMap((topic) => {
      const current = decisionCurrentRecord(topic);
      if (current === null) return [];
      const stamps = topic.records.flatMap((record) => {
        const stamp = usableStamp(record.updatedAt);
        return stamp === undefined ? [] : [stamp];
      });
      const pinnedRecord = topic.records.find((record) => groupOf.has(record.uuid));
      return [{
        uuid: topic.topic,
        title: current.title,
        tags: current.tags,
        kind: "decision" as const,
        topicState: decisionTopicState(topic),
        ...(topic.inForce?.answerPreview == null ? {} : { answerPreview: topic.inForce.answerPreview }),
        approvalChanged: [topic.inForce, ...topic.conflicts].some((record) => record?.approvalChanged === true),
        ...(topic.records.every((record) => record.commentCount !== undefined)
          ? { commentCount: topic.records.reduce((total, record) => total + (record.commentCount ?? 0), 0) } : {}),
        ...(stamps.length === 0 ? {} : { updatedAt: Math.max(...stamps) }),
        pinned: pinnedRecord !== undefined,
        groupName: pinnedRecord === undefined ? undefined : groupOf.get(pinnedRecord.uuid),
        recordIds: topic.records.map((record) => record.uuid),
      }];
    });
  }, [entries, mode, groupOf]);
  const rowTags = useMemo(() => new Map(modeRows.map((entry) => [entry.uuid, catalog === null ? [] : readDirectoryTags(entry, catalog.connection.ydoc)])), [modeRows, catalog]);
  const ranks = useMemo(() => new Map(hits.map((uuid, rank) => [uuid, rank])), [hits]);
  const rows = useMemo(
    () => {
      const filtered = modeRows.filter((entry) => (selectedIds.length === 0 || (rowTags.get(entry.uuid) ?? []).some((tag) => selectedIds.includes(tag.id))) && (mode !== "decision" || stateFilter === "all"
        || (stateFilter === "changed-after-approval" ? entry.approvalChanged : entry.topicState === stateFilter)));
      if (searchText === "") return sortDirectory(filtered, sort.order, sort.direction);
      if (searchUnavailable || searchPending) return [];
      const ranked = filtered.flatMap((entry) => {
        const recordRanks = entry.recordIds.flatMap((uuid) => { const rank = ranks.get(uuid); return rank === undefined ? [] : [rank]; });
        return recordRanks.length === 0 ? [] : [{ entry, rank: Math.min(...recordRanks) }];
      }).sort((left, right) => left.rank - right.rank).map(({ entry }) => entry);
      return relevance ? ranked : sortDirectory(ranked, sort.order, sort.direction);
    },
    [modeRows, mode, searchText, searchUnavailable, searchPending, ranks, selectedIds, rowTags, stateFilter, sort, relevance],
  );
  const hasFilters = searchText !== "" || mode === "decision" || selectedTags.length > 0 || stateFilter !== "all";
  const emptyMessage = noMatchesMessage({ mode, stateFilter, selectedLabels, query, synced: status.synced, hasFilters, hasDocuments: entries.some((entry) => !entry.deleted) });

  return (
    <section className="ub-pane ub-page-pane">
      <div className="ub-column ub-docs">
        <h1 className="ub-title ub-docs-heading">All documents</h1>
        <DocumentTypeTabs entries={entries} received={status.hasReceivedServerState} mode={mode} idPrefix={tabsId} onSelect={(option) => updateState({ mode: option })} />
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${mode}`} className="ub-docs-panel">
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
          <TagFilter options={(catalog?.entries ?? []).filter((tag) => tag.state === "active")} selected={selectedIds} labels={selectedLabels} onChange={(tags) => updateState({ selectedTags: tags })} />
          {mode === "decision" && <label className="ub-docs-state-filter ub-docs-filter-control">
            State
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
        {searchClient === null && searchText === "" && <p className="ub-docs-search-status ub-muted">Search is unavailable. Open this workspace with ub open to use local search.</p>}
        {onTogglePin === null && rows.length > 0 && (
          <p id={pinUnavailableId} className="ub-docs-pin-unavailable mb-2 mt-0 ub-type-small text-(--muted-foreground)">
            Pin changes unavailable while the sidebar is not ready to write.
          </p>
        )}
        <table className="ub-docs-table">
          <colgroup>
            <col />
            <col className="ub-docs-group-column" />
            <col className="ub-docs-tags-column" />
            <col className="ub-docs-age-column" />
            <col className="ub-docs-pin-column" />
          </colgroup>
          <thead>
            <tr>
              {(["title", "group", "tags", "changed"] as const).map((option) => option === "group" || option === "tags" ? (
                <th key={option} scope="col" className={`ub-docs-heading-cell ub-docs-heading-cell--${option}`}>{option === "group" ? "Group" : "Tags"}</th>
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
                      className={`ub-docs-open ${entry.topicState === undefined ? "" : "ub-docs-open--topic"} min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11`}
                      onClick={() => onSelect(entry.uuid)}
                      title={entry.uuid}
                    >
                      <span className="ub-docs-title">
                        {entry.title === "" ? <em>Untitled</em> : entry.title}
                      </span>
                      {entry.topicState === undefined
                        ? <LifecycleBadge kind={entry.kind} />
                        : <span className="ub-type-ui text-(--muted-foreground)">{TOPIC_STATES[entry.topicState]}</span>}
                      {entry.topicState !== undefined && entry.approvalChanged && (
                        <span className="ub-type-ui text-(--muted-foreground)">Changed after approval</span>
                      )}
                    </button>
                    {entry.topicState !== undefined && <div className="ub-docs-topic-detail">
                      {entry.topicState === "conflict" ? <span>Nothing is in force.</span>
                        : entry.answerPreview != null && <span>{entry.answerPreview}</span>}
                      {entry.commentCount !== undefined && <span>{entry.commentCount} {entry.commentCount === 1 ? "comment" : "comments"}</span>}
                    </div>}
                  </th>
                  <td className="ub-docs-group-cell"><span className="ub-docs-group">{entry.groupName}</span></td>
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
        </div>
      </div>
    </section>
  );
}

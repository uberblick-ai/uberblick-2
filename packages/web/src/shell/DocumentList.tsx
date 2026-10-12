/**
 * Workspace and /all routes list directory stubs without opening document rooms;
 * sidebar groups supply pin labels. Kind modes and title filtering use cached
 * data only, equally for local and direct serving. Working includes unknown kinds.
 * Before directory sync, empty/filter messages describe only what has arrived.
 * Sort starts last-changed first; shell state preserves filters and sorting
 * through topic visits, but not reload or workspace switches.
 * Stamps are greatest-authored cache hints, not history;
 * a future-skewed clock can pin one. Missing stamps sort last only by changed.
 * Ages turn absolute at 30 days and refresh at most a minute late. dateTime
 * stays exact; relative ages expose exact time on hover.
 */

import { useId, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { decisionCurrentRecord, decisionTopicState, resolveDecisionTopics } from "@uberblick/schema";
import type { DecisionTopicState, DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";
import { LifecycleBadge } from "../ui/LifecycleBadge.js";
import { TOPIC_STATES } from "../ui/decision-state.js";
import { formatTimestamp, useTimestampClock } from "../ui/timestamps.js";
import { foldForTitleMatch } from "../title-fold.js";

/** Accessible name and disappearing hint must both promise title-only filtering. */
const FILTER_LABEL = "Filter this list by title";
const FILTER_HINT = "Filter by title";

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
  changed: "Last changed",
  title: "Title",
};

const INITIAL_DIRECTION: Record<Order, Direction> = {
  changed: "descending",
  title: "ascending",
};

const MODES = ["working", "requirement", "decision"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABELS: Record<Mode, string> = {
  working: "Working",
  requirement: "Product",
  decision: "Decisions",
};

const MODE_EMPTY_LABELS: Record<Mode, string> = {
  working: "working documents",
  requirement: "product documents",
  decision: "decision topics",
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
  sort: { order: Order; direction: Direction };
}

export const INITIAL_DOCUMENT_LIST_STATE: DocumentListState = {
  query: "",
  mode: "working",
  stateFilter: "all",
  sort: { order: "changed", direction: INITIAL_DIRECTION.changed },
};

type ListRow = DirectoryEntry & { topicState?: DecisionTopicState; pinned: boolean; groupName: string | undefined };

function inMode(entry: DirectoryEntry, mode: Mode): boolean {
  return mode === "working" ? entry.kind === undefined : entry.kind === mode;
}

/**
 * Match only cached titles, using the same fold as mentions on query and title.
 * Never match the display fallback Untitled for an empty title. Empty query
 * matches all. This fold is neither locale collation nor tag-name lowercase.
 */
function titleMatches(entry: DirectoryEntry, needle: string): boolean {
  return foldForTitleMatch(entry.title).includes(needle);
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

export function DocumentList({
  connection,
  entries,
  groups,
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
  const { query, mode, stateFilter, sort } = listState;
  const updateState = (patch: Partial<DocumentListState>): void => {
    const next = { ...listState, ...patch };
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
      .map((entry) => ({ ...entry, pinned: groupOf.has(entry.uuid), groupName: groupOf.get(entry.uuid) }));
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
      }];
    });
  }, [entries, mode, groupOf]);
  const needle = foldForTitleMatch(query.trim());
  const rows = useMemo(
    () =>
      sortDirectory(
        modeRows.filter((entry) => titleMatches(entry, needle) && (mode !== "decision" || stateFilter === "all"
          || (stateFilter === "changed-after-approval" ? entry.approvalChanged : entry.topicState === stateFilter))),
        sort.order,
        sort.direction,
      ),
    [modeRows, mode, needle, stateFilter, sort],
  );

  return (
    <section className="ub-pane">
      <div className="ub-column ub-docs">
        <h1 className="ub-docs-heading">Documents</h1>
        <div className="flex flex-wrap items-center gap-2">
        <fieldset className="ub-docs-mode-fieldset">
          <legend className="ub-sr-only">Document type</legend>
          <div className="ub-docs-modes">
            {MODES.map((option) => (
              <button
                key={option}
                type="button"
                className="ub-docs-mode cursor-pointer border border-r-0 border-(--border) bg-transparent px-[0.55rem] py-[0.3rem] [font:inherit] text-(--muted-foreground) first:rounded-[var(--radius-sm)_0_0_var(--radius-sm)] last:rounded-[0_var(--radius-sm)_var(--radius-sm)_0] last:border-r hover:bg-(--accent) hover:text-(--accent-foreground) aria-pressed:bg-(--brand-subtle) aria-pressed:text-(--brand-ink)"
                aria-pressed={option === mode}
                onClick={() => updateState({ mode: option })}
              >
                {MODE_LABELS[option]}
              </button>
            ))}
          </div>
        </fieldset>
        {mode === "decision" && <label className="flex items-center gap-2 text-sm text-(--muted-foreground)">
          State
          <select
            aria-label="Decision state"
            className="min-h-8 [@media(any-pointer:coarse)]:min-h-11 rounded-(--radius-sm) border border-(--border) bg-(--background) px-2 py-1 [font:inherit] text-(--foreground)"
            value={stateFilter}
            onChange={(event) => {
              const value = STATE_FILTERS.find((option) => option === event.currentTarget.value);
              if (value !== undefined) updateState({ stateFilter: value });
            }}
          >
            {STATE_FILTERS.map((option) => <option key={option} value={option}>{STATE_LABELS[option]}</option>)}
          </select>
        </label>}
        </div>
        {/* Enabled from first paint, whatever this page is connected to: the
            rows it narrows are already here, so there is nothing to wait for
            and no state in which it is unavailable. */}
        <label className="ub-docs-search-label">
          <span className="ub-sr-only">{FILTER_LABEL}</span>
          <input
            type="search"
            className="ub-docs-search"
            placeholder={FILTER_HINT}
            value={query}
            onChange={(event) => updateState({ query: event.currentTarget.value })}
          />
        </label>
        {onTogglePin === null && rows.length > 0 && (
          <p id={pinUnavailableId} className="ub-docs-pin-unavailable mb-2 mt-0 text-xs text-(--muted-foreground)">
            Pin changes unavailable while the sidebar is not ready to write.
          </p>
        )}
        <table className="ub-docs-table">
          <colgroup>
            <col />
            <col className="ub-docs-age-column" />
            <col className="ub-docs-pin-column" />
          </colgroup>
          <thead>
            <tr>
              {ORDERS.map((option) => (
                <th
                  key={option}
                  scope="col"
                  className={`ub-docs-heading-cell ub-docs-heading-cell--${option}`}
                  aria-sort={option === sort.order ? sort.direction : undefined}
                >
                  <button
                    type="button"
                    className={`ub-docs-sort flex min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 w-full cursor-pointer items-center gap-[0.3rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.4rem] py-1 [font:inherit] text-inherit hover:bg-(--accent) hover:text-(--accent-foreground) ${option === "changed" ? "justify-end" : ""}`}
                    onClick={() =>
                      updateState({ sort:
                        sort.order === option
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
                    {option === sort.order && (
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
                <td colSpan={3} className="ub-docs-empty-cell">
                  <p className="ub-muted ub-docs-empty">
                    {mode === "decision" && stateFilter !== "all"
                      ? `No decision topics${status.synced ? "" : " synced so far"} match state “${STATE_LABELS[stateFilter]}”${needle === "" ? "." : " and the title filter."}`
                      : needle !== ""
                      ? status.synced
                        ? `No ${MODE_EMPTY_LABELS[mode]} have a matching title.`
                        : `No ${MODE_EMPTY_LABELS[mode]} synced so far have a matching title.`
                      : entries.length !== 0
                        ? status.synced
                          ? `No ${MODE_EMPTY_LABELS[mode]} in this workspace.`
                          : `No ${MODE_EMPTY_LABELS[mode]} among the documents synced so far.`
                      : status.synced
                        ? "No documents in this workspace yet."
                        : "Nothing here yet — the directory has not synced on this client."}
                  </p>
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
                        ? <LifecycleBadge kind={entry.kind} status={entry.status} />
                        : <span className="text-sm text-(--muted-foreground)">{TOPIC_STATES[entry.topicState]}</span>}
                      {entry.topicState !== undefined && entry.approvalChanged && (
                        <span className="text-sm text-(--muted-foreground)">Changed after approval</span>
                      )}
                      {/* Where the sidebar carries this document, when it does.
                          Blank is the honest answer for the long tail. */}
                      {entry.groupName !== undefined && (
                        <span className="ub-docs-group">{entry.groupName}</span>
                      )}
                    </button>
                    {entry.topicState !== undefined && <div className="ub-docs-topic-detail">
                      {entry.topicState === "conflict" ? <span>Nothing is in force.</span>
                        : entry.answerPreview != null && <span>{entry.answerPreview}</span>}
                      {entry.commentCount !== undefined && <span>{entry.commentCount} {entry.commentCount === 1 ? "comment" : "comments"}</span>}
                    </div>}
                  </th>
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
    </section>
  );
}

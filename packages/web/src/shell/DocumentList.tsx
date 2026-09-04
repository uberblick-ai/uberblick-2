/**
 * The document list: the first screen of a working session (#406).
 *
 * One journey — *find the document I want* — and one surface for it. It is the
 * corpus half of the shell (#405), mounted at both addresses that name the
 * workspace rather than a document (`/<workspace>` and `/<workspace>/all`), and
 * it replaces `AllDocsPane`. The sidebar beside it is curation — groups, pins,
 * the switcher, `+ new doc` — and stays exactly as it was.
 *
 * **Fed by the directory stubs and nothing else.** Discovery is a synced doc,
 * so the rows are an observer over the same `_directory` room `list_docs`
 * reads: a document created, renamed or described in another browser or by an
 * agent appears here without anything being told about it, and rendering the
 * whole corpus opens no document room. The one other room it reads is
 * `_sidebar`, for the group a row is pinned in — the shell already holds both.
 *
 * **Both filters are that same derivation, narrowed.** The mode reads the
 * lifecycle shape already cached on each stub: ordinary or unreadable kinds
 * are Working, requirements are Product and decisions are Decisions. It opens
 * on Working and classifies no row by opening its document room.
 *
 * Served by `ub open`, the query goes to the store's full-text index through
 * `/api/search`: titles, descriptions and block text under the same matching
 * rules as the MCP `search` tool. The endpoint returns identities only; rows,
 * modes, ordering, pins and navigation remain this list's derivation over the
 * directory and sidebar. Against a remote hub there is no honest index to ask,
 * so the field says it is unavailable and filters nothing.
 *
 * **An empty listing is never a claim this client cannot make.** Nothing heard
 * yet is not "no documents", and nothing matched among what has arrived is not
 * "nothing matches" — until the directory has synced, both say what they
 * actually know.
 *
 * **Two orders, and the reader picks.** Last changed first is what a working
 * session opens on; title order is the other scan a corpus is read with — *what
 * is in here*, which filtering by a name you already know cannot answer (owner
 * feedback, 2026-08-30). The choice is the mounted pane's own state, so
 * filtering and a directory update leave it alone and nothing is remembered
 * across a reload.
 *
 * The stamps are the stubs' own `updatedAt` — cache-quality freshness hints
 * resolved to the greatest candidate an author wrote, never history — and
 * optional by construction. A future-skewed writer can therefore pin one until
 * a later candidate exceeds it. {@link sortDirectory} sorts the unstamped last
 * in last-changed order rather than treating absence as epoch zero: a document
 * nobody has stamped is not the oldest document, it is the one with no answer.
 * In title order they sort by title like every other row — grouping them at the
 * bottom there would not be title order — and the row's own dash carries "no
 * answer" in both. A recent stamp is shown as an age ("3 days ago" is what a
 * scan of a listing is asking), while one at least 30 days old becomes an
 * absolute date. The pane keeps its own clock so a relative label goes stale by
 * at most a minute even when nothing else re-renders. Its exact date and time
 * stay one hover away, and the machine value in `dateTime`.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";
import { LifecycleBadge } from "../ui/LifecycleBadge.js";
import { formatTimestamp, useTimestampClock } from "../ui/timestamps.js";
import type { DocumentSearchClient, DocumentSearchResult } from "./document-search.js";

/**
 * The field's label, which is also the whole answer to *what does typing here
 * do?* — both halves of it, so nobody has to guess at the half that is missing.
 * Short, because a label is also the accessible name a screen reader repeats
 * every time the field is reached and in every listing of the form's controls.
 */
const SEARCH_LABEL = "Search document text";

/** Recheck only while a search answer may still lag the hub. */
export const SEARCH_STATUS_POLL_MS = 1_000;

type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | ({ kind: "ready"; query: string; caughtUp: boolean } & DocumentSearchResult)
  | { kind: "failed"; query: string };

/**
 * The stamp, if a `Date` can actually hold it.
 *
 * The stubs are cache-quality and written by whichever replica had the clock,
 * so a finite-but-absurd number is a state that can reach here — the schema
 * only checks `Number.isFinite`, and `new Date(1e308).toISOString()` throws.
 * An uncaught throw in a cell would blank the whole listing over one bad stub,
 * so an unusable stamp is treated exactly like a missing one: a dash in the
 * row, and last in *last-changed* order. Title order never asks — a row with no
 * answer about its age still has a title, and sorts by it.
 */
function usableStamp(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  return Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

/**
 * The replica-stable code-unit order of `listDirectory`: title, then uuid.
 *
 * Deliberately `<` / `>`, not locale collation: the web pane and `list_docs`
 * must produce the same sequence on every replica.
 */
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
  decision: "decision records",
};

function inMode(entry: DirectoryEntry, mode: Mode): boolean {
  return mode === "working" ? entry.kind === undefined : entry.kind === mode;
}

/**
 * The entries as the list shows them, in the order the reader chose.
 *
 * Both orders are total, because neither may let two rows swap places between
 * renders — that is exactly the layout shift the calm-UI rules forbid. Title
 * order is {@link byTitle}, whose uuid tiebreak is unique by construction; last
 * changed breaks its ties the same way, since two documents can share a coarse
 * millisecond.
 *
 * In last-changed order, entries with no usable stamp go last, and that is a
 * decision rather than a fallback: the stamps are optional, so a listing that
 * read "absent" as "very old" would still be sorting them — into a wall at the
 * bottom that hides nothing, instead of pretending they are ancient. It is a
 * rule about *this* order only; in title order an unstamped document is sorted
 * by its title like every other row.
 */
export function sortDirectory(
  entries: readonly DirectoryEntry[],
  order: Order,
  direction: Direction,
): DirectoryEntry[] {
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

/**
 * What a row's pin does, named after the document it does it to.
 *
 * Every pin in the list looks alike, so "Pin to the sidebar" on all of them
 * leaves a reader hearing the buttons with no way to tell which row they are on.
 */
function pinLabel(entry: DirectoryEntry, pinned: boolean): string {
  const named = entry.title === "" ? "Untitled" : entry.title;
  return pinned ? `Unpin ${named} from the sidebar` : `Pin ${named} to the sidebar`;
}

/**
 * The changing stamp, under the web UI's shared timestamp rule.
 *
 * A relative label answers *is this fresh?* at a glance; once it no longer
 * does, an absolute date is easier to place. The exact recent date and time
 * stay one hover away, and the machine value in `dateTime`.
 */
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
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ub-docs-pin-icon">
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
  searchClient,
  onSelect,
  onTogglePin,
}: {
  /**
   * The directory room, for its sync state alone — the same reading the
   * sidebar's head prints. An empty listing means two different things
   * depending on it, and only one of them is "there are no documents".
   */
  connection: RoomConnection | null;
  /** The directory's non-deleted stubs, live — `useDirectory` in the shell. */
  entries: readonly DirectoryEntry[];
  /** The sidebar as it stands: which group, if any, a row is pinned in. */
  groups: readonly SidebarGroup[];
  /** Undefined while configuration loads; null when this page talks to a hub directly. */
  searchClient?: DocumentSearchClient | null | undefined;
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null when there is no sidebar room to write to. */
  onTogglePin: ((uuid: string) => void) | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>("working");
  /**
   * The chosen order, held beside the query rather than derived from it: the
   * two are independent, so switching one leaves the other exactly as it was.
   * Mounted-pane state and nothing more — no storage, no preference mechanism.
   */
  const [sort, setSort] = useState<{ order: Order; direction: Direction }>({
    order: "changed",
    direction: INITIAL_DIRECTION.changed,
  });
  const now = useTimestampClock();
  /**
   * Which group each pinned document sits in — the `_sidebar` document as it
   * stands, not a breadcrumb derived from tags. First group wins, so a uuid
   * that somehow reached two of them still names one.
   */
  const groupOf = useMemo(() => {
    const named = new Map<string, string>();
    for (const group of groups) {
      for (const uuid of group.docs) if (!named.has(uuid)) named.set(uuid, group.name);
    }
    return named;
  }, [groups]);
  const needle = query.trim();
  useEffect(() => {
    if (needle === "" || searchClient === null || searchClient === undefined) {
      setSearch({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSearch({ kind: "loading", query: needle });
    void Promise.all([
      searchClient.search(needle, controller.signal),
      searchClient.status(controller.signal),
    ]).then(
      ([result, next]) => {
        if (active) setSearch({ kind: "ready", query: needle, ...result, ...next });
      },
      () => {
        if (active) setSearch({ kind: "failed", query: needle });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [needle, searchClient]);

  const ready = search.kind === "ready" && search.query === needle ? search : null;
  useEffect(() => {
    if (ready === null || ready.caughtUp || searchClient == null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await searchClient.status(controller.signal);
        if (controller.signal.aborted) return;
        if (next.caughtUp) {
          setSearch((current) =>
            current.kind === "ready" && current.query === needle
              ? { ...current, caughtUp: true }
              : current,
          );
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(() => void poll(), SEARCH_STATUS_POLL_MS);
    };
    timer = setTimeout(() => void poll(), SEARCH_STATUS_POLL_MS);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    };
  }, [needle, ready, searchClient]);

  const hitIds = useMemo(() => new Set(ready?.hits ?? []), [ready]);
  const rows = useMemo(
    () =>
      sortDirectory(
        entries.filter(
          (entry) =>
            inMode(entry, mode) && (needle === "" || hitIds.has(entry.uuid)),
        ),
        sort.order,
        sort.direction,
      ),
    [entries, hitIds, mode, needle, sort],
  );

  return (
    <section className="ub-pane">
      <div className="ub-column ub-docs">
        <h1 className="ub-docs-heading">Documents</h1>
        <fieldset className="ub-docs-mode-fieldset">
          <legend className="ub-sr-only">Document type</legend>
          <div className="ub-docs-modes">
            {MODES.map((option) => (
              <button
                key={option}
                type="button"
                className="ub-docs-mode"
                aria-pressed={option === mode}
                onClick={() => setMode(option)}
              >
                {MODE_LABELS[option]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="ub-docs-search-label">
          <span>
            {searchClient === null ? "Search unavailable without ub open" : SEARCH_LABEL}
          </span>
          <input
            type="search"
            className="ub-docs-search"
            value={query}
            disabled={searchClient === null || searchClient === undefined}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        {searchClient === null && (
          <p className="ub-muted ub-docs-search-state">
            This page is connected directly to a remote hub, which has no browser search.
          </p>
        )}
        {searchClient === undefined && (
          <p className="ub-muted ub-docs-search-state">Loading search…</p>
        )}
        {ready !== null && (!ready.caughtUp || ready.capped) && (
          <p className="ub-muted ub-docs-search-state" role="status">
            {!ready.caughtUp && "Results are from this machine and may lag the hub."}
            {!ready.caughtUp && ready.capped && " "}
            {ready.capped && `Showing the first ${ready.limit} matches.`}
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
                    className="ub-docs-sort"
                    onClick={() =>
                      setSort((current) =>
                        current.order === option
                          ? {
                              order: option,
                              direction:
                                current.direction === "ascending"
                                  ? "descending"
                                  : "ascending",
                            }
                          : { order: option, direction: INITIAL_DIRECTION[option] },
                      )
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
                    {needle !== "" && searchClient !== null
                      ? search.kind === "failed" && search.query === needle
                        ? "Search failed. Try again."
                        : ready === null
                          ? "Searching document text…"
                          : ready.hits.length === 0
                            ? "No documents match your search."
                            : status.synced
                              ? `The matching documents are outside the ${MODE_LABELS[mode]} view.`
                              : "Matching documents are still arriving."
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
                <tr key={entry.uuid} className="ub-docs-row">
                  <th scope="row" className="ub-docs-title-cell">
                    <button
                      type="button"
                      className="ub-docs-open"
                      onClick={() => onSelect(entry.uuid)}
                      title={entry.uuid}
                    >
                      <span className="ub-docs-title">
                        {entry.title === "" ? <em>Untitled</em> : entry.title}
                      </span>
                      <LifecycleBadge kind={entry.kind} status={entry.status} />
                      {/* Where the sidebar carries this document, when it does.
                          Blank is the honest answer for the long tail. */}
                      {groupOf.has(entry.uuid) && (
                        <span className="ub-docs-group">{groupOf.get(entry.uuid)}</span>
                      )}
                    </button>
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
                      className="ub-docs-pin"
                      disabled={onTogglePin === null}
                      aria-pressed={groupOf.has(entry.uuid)}
                      aria-label={
                        onTogglePin === null
                          ? `${pinLabel(entry, groupOf.has(entry.uuid))} unavailable while sidebar is read-only`
                          : pinLabel(entry, groupOf.has(entry.uuid))
                      }
                      title={
                        onTogglePin === null
                          ? "Pin unavailable while the sidebar is read-only"
                          : pinLabel(entry, groupOf.has(entry.uuid))
                      }
                      onClick={() => onTogglePin?.(entry.uuid)}
                    >
                      <PinIcon active={groupOf.has(entry.uuid)} />
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

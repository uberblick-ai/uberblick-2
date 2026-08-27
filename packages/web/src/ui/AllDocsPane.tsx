/**
 * "All docs" (#118): the workspace's whole corpus, listed and sortable.
 *
 * The counterweight to a curated sidebar. Once the sidebar is pins (#115), the
 * long tail needs one place that lists *everything* — so this is the listing
 * the sidebar deliberately stopped being, at an address of its own
 * (`/<workspace>/all`, see route.ts).
 *
 * Fed by the directory stubs and nothing else. Discovery is a synced doc, so
 * the rows are an observer over the same `_directory` room `list_docs` reads:
 * a document created or renamed in another browser or by an agent appears here
 * without anything being told about it, and no document room is opened to
 * render a listing.
 *
 * The timestamps are the stubs' own `createdAt`/`updatedAt` — cache-quality
 * freshness hints written by whichever replica last stamped them, never
 * history. They are optional by construction (a stub written before the fields
 * existed carries none), which is why {@link sortDirectory} sorts the missing
 * ones last rather than treating absence as epoch zero: a document nobody has
 * stamped is not the oldest document, it is the one with no answer.
 *
 * Last changed is shown as an age rather than a date — "3 days ago" is what a
 * scan of the listing is actually asking — and the pane keeps its own clock so
 * a label goes stale by at most a minute even when nothing else re-renders.
 * The absolute date is still there, in `title` and in the ISO `dateTime`.
 *
 * The search filters those same stubs and nothing else: no document room is
 * opened to answer a query, so the corpus is searchable by title (and by the
 * stub description, which the rows do not show) the moment the directory has
 * synced, offline included. Full-text search over document bodies is the MCP
 * server's, over its own index — not this.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { relativeAge } from "../editor/github-hovercard.js";
import { useRoomStatus } from "./hooks.js";

/** How the listing is ordered. */
export type DocSort = "title" | "changed" | "created";

/** The sort, persisted per browser like the sidebar's own preferences. */
const SORT_KEY = "uberblick.alldocs.sort";

/** The column heads, in the order they are drawn — label doubles as sort control. */
const COLUMNS: ReadonlyArray<{ sort: DocSort; label: string }> = [
  { sort: "title", label: "Title" },
  { sort: "changed", label: "Last changed" },
  { sort: "created", label: "Created" },
];

/** Absolute and in the reader's locale, like a comment byline — never "3d ago". */
const STAMP_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The stamp, if a `Date` can actually hold it.
 *
 * The stubs are cache-quality and written by whichever replica had the clock,
 * so a finite-but-absurd number is a state that can reach here — the schema
 * only checks `Number.isFinite`, and `new Date(1e308).toISOString()` throws.
 * An uncaught throw in a cell would blank the whole listing over one bad stub,
 * so an unusable stamp is treated exactly like a missing one: a dash in the
 * row, and last under the time sorts.
 */
function usableStamp(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  return Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

function isSort(value: unknown): value is DocSort {
  return value === "title" || value === "changed" || value === "created";
}

/** The stored order of every replica's `listDirectory`: title, then uuid. */
function byTitle(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

/**
 * The entries in the order `sort` asks for — newest first for the two time
 * sorts, A–Z for the title sort.
 *
 * Entries with no stamp for the chosen sort go last, in title order, and that
 * is a decision rather than a fallback: the stamps are optional, so a listing
 * that read "absent" as "very old" would open on a wall of documents that are
 * merely unstamped and bury the ones the reader is looking for. Ties break by
 * title so the order is total — two documents stamped in the same coarse
 * millisecond must not swap places between renders (a listing that shuffles
 * under a re-render is exactly the layout shift the calm-UI rules forbid).
 */
export function sortDirectory(
  entries: readonly DirectoryEntry[],
  sort: DocSort,
): DirectoryEntry[] {
  const out = [...entries];
  if (sort === "title") return out.sort(byTitle);
  const stamp = (entry: DirectoryEntry): number | undefined =>
    usableStamp(sort === "created" ? entry.createdAt : entry.updatedAt);
  return out.sort((a, b) => {
    const left = stamp(a);
    const right = stamp(b);
    if (left === undefined || right === undefined) {
      if (left === right) return byTitle(a, b);
      return left === undefined ? 1 : -1;
    }
    return left === right ? byTitle(a, b) : right - left;
  });
}

/**
 * The sort, remembered across reloads.
 *
 * Storage can be unavailable (private windows, blocked third-party contexts)
 * and a view preference is never worth an exception, so both directions fall
 * back to the in-memory value — the listing renders, it just forgets.
 */
function useStoredSort(): [DocSort, (next: DocSort) => void] {
  const [sort, setSort] = useState<DocSort>(() => {
    try {
      const stored = localStorage.getItem(SORT_KEY);
      return isSort(stored) ? stored : "title";
    } catch {
      return "title";
    }
  });
  const choose = useCallback((next: DocSort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Preference stays for this tab only.
    }
  }, []);
  return [sort, choose];
}

/** One stamp cell: the reader's date, and the machine value beside it. */
function Stamp({ at }: { at: number | undefined }): ReactElement {
  const stamp = usableStamp(at);
  if (stamp === undefined) return <span className="ub-all-stamp ub-muted">—</span>;
  return (
    <time className="ub-all-stamp" dateTime={new Date(stamp).toISOString()}>
      {STAMP_FORMAT.format(stamp)}
    </time>
  );
}

/**
 * The changing stamp uses the same coarse clock language as GitHub cards.
 *
 * "3 days ago" answers *is this fresh?* at a glance, which is the question a
 * listing is scanned for — but it is the only question it answers. The exact
 * date stays one hover away in `title`, and the machine value in `dateTime`,
 * so nothing that was readable before became unreadable.
 */
function ChangedStamp({
  at,
  now,
}: {
  at: number | undefined;
  now: number;
}): ReactElement {
  const stamp = usableStamp(at);
  if (stamp === undefined) return <span className="ub-all-stamp ub-muted">—</span>;
  const iso = new Date(stamp).toISOString();
  return (
    <time
      className="ub-all-stamp"
      dateTime={iso}
      title={STAMP_FORMAT.format(stamp)}
    >
      {relativeAge(iso, now)}
    </time>
  );
}

function PinIcon({ active }: { active: boolean }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ub-all-pin-icon">
      <path
        d="M9 3h6l-1 6 3 3v2h-4v7l-2-2v-5H7v-2l3-3-1-6Z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AllDocsPane({
  connection,
  entries,
  groups,
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
  /** The sidebar as it stands, for which rows read as pinned. */
  groups: readonly SidebarGroup[];
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null when there is no sidebar room to write to. */
  onTogglePin: ((uuid: string) => void) | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const [sort, choose] = useStoredSort();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const pinned = useMemo(
    () => new Set(groups.flatMap((group) => group.docs)),
    [groups],
  );
  const rows = useMemo(() => {
    // `toLowerCase`, not `toLocaleLowerCase`: the needle and the haystack must
    // fold the same way. A locale-aware fold does not — under a Turkish or
    // Azeri locale "I" folds to a dotless i, so a document would stop matching
    // its own title depending on who is looking at it.
    const needle = query.trim().toLowerCase();
    const matches =
      needle === ""
        ? entries
        : entries.filter(
            (entry) =>
              entry.title.toLowerCase().includes(needle) ||
              (entry.description ?? "").toLowerCase().includes(needle),
          );
    return sortDirectory(matches, sort);
  }, [entries, query, sort]);

  return (
    <section className="ub-pane">
      <div className="ub-column ub-all">
        <h1 className="ub-all-heading">All docs</h1>
        <label className="ub-all-search-label">
          <span>Search documents</span>
          <input
            type="search"
            className="ub-all-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        {/* The column heads *are* the sort controls: one row of labels, and
            clicking one is asking for that order. The grid is declared once
            (see styles.css) and shared with every row, so changing the sort
            moves nothing but the rows themselves. */}
        <div className="ub-all-head">
          {COLUMNS.map((column) => (
            <button
              key={column.sort}
              type="button"
              className="ub-all-sort"
              aria-pressed={sort === column.sort}
              title={`Sort by ${column.label.toLowerCase()}`}
              onClick={() => choose(column.sort)}
            >
              {column.label}
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          /* Nothing listed is only an answer once the directory has synced.
             Before that this client has simply not heard yet — and a workspace
             full of documents would be told it has none. */
          <p className="ub-muted ub-empty">
            {entries.length > 0
              ? "No documents match your search."
              : status.synced
                ? "No documents in this workspace yet."
                : "Nothing here yet — the directory has not synced on this client."}
          </p>
        ) : (
          <ul className="ub-all-rows">
            {rows.map((entry) => (
              <li key={entry.uuid} className="ub-all-row">
                <button
                  type="button"
                  className="ub-all-open"
                  onClick={() => onSelect(entry.uuid)}
                  title={entry.uuid}
                >
                  <span className="ub-all-title">
                    {entry.title === "" ? <em>Untitled</em> : entry.title}
                  </span>
                  <ChangedStamp at={entry.updatedAt} now={now} />
                  <Stamp at={entry.createdAt} />
                </button>
                {/* The same gesture as the header's Pin control, on the one
                    screen that shows every document — so this is where a
                    sidebar gets curated from. The mark carries the state and
                    the row never changes width. */}
                {onTogglePin !== null && (
                  <button
                    type="button"
                    className="ub-all-pin"
                    aria-pressed={pinned.has(entry.uuid)}
                    aria-label={
                      pinned.has(entry.uuid)
                        ? "Unpin from the sidebar"
                        : "Pin to the sidebar"
                    }
                    title={
                      pinned.has(entry.uuid)
                        ? "Unpin from the sidebar"
                        : "Pin to the sidebar"
                    }
                    onClick={() => onTogglePin(entry.uuid)}
                  >
                    <PinIcon active={pinned.has(entry.uuid)} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

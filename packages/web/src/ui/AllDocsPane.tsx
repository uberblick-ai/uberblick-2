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
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";

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
    sort === "created" ? entry.createdAt : entry.updatedAt;
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
  if (at === undefined) return <span className="ub-all-stamp ub-muted">—</span>;
  return (
    <time className="ub-all-stamp" dateTime={new Date(at).toISOString()}>
      {STAMP_FORMAT.format(at)}
    </time>
  );
}

export function AllDocsPane({
  entries,
  groups,
  onSelect,
  onTogglePin,
}: {
  /** The directory's non-deleted stubs, live — `useDirectory` in the shell. */
  entries: readonly DirectoryEntry[];
  /** The sidebar as it stands, for which rows read as pinned. */
  groups: readonly SidebarGroup[];
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null when there is no sidebar room to write to. */
  onTogglePin: ((uuid: string) => void) | null;
}): ReactElement {
  const [sort, choose] = useStoredSort();
  const pinned = useMemo(
    () => new Set(groups.flatMap((group) => group.docs)),
    [groups],
  );
  const rows = useMemo(() => sortDirectory(entries, sort), [entries, sort]);

  return (
    <section className="ub-pane">
      <div className="ub-column ub-all">
        <h1 className="ub-all-heading">All docs</h1>
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
          <p className="ub-muted ub-empty">No documents in this workspace yet.</p>
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
                  <Stamp at={entry.updatedAt} />
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
                    <span aria-hidden="true">
                      {pinned.has(entry.uuid) ? "◆" : "◇"}
                    </span>
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

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
 * The title query folds to lower case over those same in-memory stubs:
 * synchronous, no request, no room, and correct offline. The title alone,
 * because the title is all a row
 * shows — matching on a description the row does not print looks like a row
 * that matched on nothing. That is also its whole scope, so the field's own
 * label says it rather than letting a reader assume the words in their
 * documents were searched: naming the scope beside the control left the
 * meaning in a second, quieter line, and a description is not what a reader
 * scanning chrome reads first (owner feedback, 2026-08-30). In the label it is
 * the field's accessible name too, so it reaches a screen reader with the
 * control instead of after it. Full-text over document *bodies* is the agents'
 * `search` tool over the MCP server's own index — not this (owner decision,
 * 2026-08-27).
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

import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";
import { LifecycleBadge } from "../ui/LifecycleBadge.js";
import { formatTimestamp, useTimestampClock } from "../ui/timestamps.js";

/**
 * The field's label, which is also the whole answer to *what does typing here
 * do?* — both halves of it, so nobody has to guess at the half that is missing.
 * Short, because a label is also the accessible name a screen reader repeats
 * every time the field is reached and in every listing of the form's controls.
 */
const SEARCH_LABEL = "Find by title, not document text";

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
 * Whether an entry matches what was typed.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the needle and the haystack must fold
 * the same way. A locale-aware fold does not — under a Turkish or Azeri locale
 * "I" folds to a dotless i, so a document would stop matching its own title
 * depending on who is looking at it.
 */
function matches(entry: DirectoryEntry, needle: string): boolean {
  if (needle === "") return true;
  return entry.title.toLowerCase().includes(needle);
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
  onSelect: (uuid: string) => void;
  /** Pin or unpin a row, or null when there is no sidebar room to write to. */
  onTogglePin: ((uuid: string) => void) | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const [query, setQuery] = useState("");
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
  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      sortDirectory(
        entries.filter((entry) => inMode(entry, mode) && matches(entry, needle)),
        sort.order,
        sort.direction,
      ),
    [entries, mode, needle, sort],
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
        {/* The scope is the label, not a sentence beside it. A filter that
            quietly skipped the words inside documents would be read as a search
            that found nothing in them, so what it does and does not look at is
            what the control is called — for a screen reader as much as for the
            eye. */}
        <label className="ub-docs-search-label">
          <span>{SEARCH_LABEL}</span>
          <input
            type="search"
            className="ub-docs-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
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
                  {/* Four silences, and only two of them are answers. A client
                      that has not heard from the directory yet knows neither
                      that the workspace is empty nor that nothing in it
                      matches — so it says what it does know instead of
                      reporting a zero it cannot stand behind. */}
                  <p className="ub-muted ub-docs-empty">
                    {needle !== ""
                      ? status.synced
                        ? "No documents match your search."
                        : "No matches among the documents synced so far."
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
                    {onTogglePin !== null && (
                      <button
                        type="button"
                        className="ub-docs-pin"
                        aria-pressed={groupOf.has(entry.uuid)}
                        aria-label={pinLabel(entry, groupOf.has(entry.uuid))}
                        title={pinLabel(entry, groupOf.has(entry.uuid))}
                        onClick={() => onTogglePin(entry.uuid)}
                      >
                        <PinIcon active={groupOf.has(entry.uuid)} />
                      </button>
                    )}
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

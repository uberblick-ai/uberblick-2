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
 * **Filtering is that same derivation, narrowed.** Title, tags and description,
 * folded to lower case, over stubs that are already in memory: synchronous, no
 * request, no room, and correct offline. That is also its whole scope, so the
 * pane says so on screen rather than letting a reader assume the words in their
 * documents were searched. Full-text over document *bodies* is the agents'
 * `search` tool over the MCP server's own index — not this (owner decision,
 * 2026-08-27).
 *
 * **An empty listing is never a claim this client cannot make.** Nothing heard
 * yet is not "no documents", and nothing matched among what has arrived is not
 * "nothing matches" — until the directory has synced, both say what they
 * actually know.
 *
 * The stamps are the stubs' own `updatedAt` — cache-quality freshness hints
 * written by whichever replica last stamped them, never history — and optional
 * by construction, which is why {@link sortDirectory} sorts the unstamped last
 * rather than treating absence as epoch zero: a document nobody has stamped is
 * not the oldest document, it is the one with no answer. Last changed is shown
 * as an age rather than a date ("3 days ago" is what a scan of a listing is
 * asking), and the pane keeps its own clock so a label goes stale by at most a
 * minute even when nothing else re-renders. The absolute date stays one hover
 * away, and the machine value in `dateTime`.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus } from "../ui/hooks.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** What the filter looks at, said on screen so nobody has to guess. */
const SCOPE =
  "Filters titles, tags and descriptions — not the text inside documents.";

/** One list per screen, so the sentence the search field points at has one id. */
const SCOPE_ID = "ub-docs-scope";

/** `3 days ago`, at the coarseness a reader actually reads. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const ago = Math.max(0, now - then);
  const [amount, unit] =
    ago < HOUR
      ? [Math.floor(ago / MINUTE), "minute"]
      : ago < DAY
        ? [Math.floor(ago / HOUR), "hour"]
        : ago < WEEK
          ? [Math.floor(ago / DAY), "day"]
          : ago < MONTH
            ? [Math.floor(ago / WEEK), "week"]
            : ago < YEAR
              ? [Math.floor(ago / MONTH), "month"]
              : [Math.floor(ago / YEAR), "year"];
  if (amount < 1) return "just now";
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

/** Absolute and in the reader's locale — the date behind the age. */
const STAMP_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The stamp, if a `Date` can actually hold it.
 *
 * The stubs are cache-quality and written by whichever replica had the clock,
 * so a finite-but-absurd number is a state that can reach here — the schema
 * only checks `Number.isFinite`, and `new Date(1e308).toISOString()` throws.
 * An uncaught throw in a cell would blank the whole listing over one bad stub,
 * so an unusable stamp is treated exactly like a missing one: a dash in the
 * row, and last in the order.
 */
function usableStamp(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  return Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

/** The stored order of every replica's `listDirectory`: title, then uuid. */
function byTitle(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

/**
 * The entries as the list shows them: last changed first, unstamped last.
 *
 * One order, and it is the one a working session opens on — what was touched
 * most recently is what is being worked on. Finding a document by name is what
 * the filter is for, so there is no second order to choose between and nothing
 * to remember across reloads.
 *
 * Entries with no usable stamp go last, in title order, and that is a decision
 * rather than a fallback: the stamps are optional, so a listing that read
 * "absent" as "very old" would still be sorting them — into a wall at the
 * bottom that hides nothing, instead of pretending they are ancient. Ties break
 * by title so the order is total: two documents stamped in the same coarse
 * millisecond must not swap places between renders, which is exactly the layout
 * shift the calm-UI rules forbid.
 */
export function sortDirectory(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => {
    const left = usableStamp(a.updatedAt);
    const right = usableStamp(b.updatedAt);
    if (left === undefined || right === undefined) {
      if (left === right) return byTitle(a, b);
      return left === undefined ? 1 : -1;
    }
    return left === right ? byTitle(a, b) : right - left;
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
  return (
    entry.title.toLowerCase().includes(needle) ||
    (entry.description ?? "").toLowerCase().includes(needle) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
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
 * The changing stamp, in coarse clock language.
 *
 * "3 days ago" answers *is this fresh?* at a glance, which is the question a
 * listing is scanned for — and it is the only question it answers. The exact
 * date stays one hover away in `title`, and the machine value in `dateTime`.
 */
function ChangedStamp({
  at,
  now,
}: {
  at: number | undefined;
  now: number;
}): ReactElement {
  const stamp = usableStamp(at);
  if (stamp === undefined) return <span className="ub-docs-age ub-muted">—</span>;
  const iso = new Date(stamp).toISOString();
  return (
    <time className="ub-docs-age" dateTime={iso} title={STAMP_FORMAT.format(stamp)}>
      {relativeAge(iso, now)}
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);
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
    () => sortDirectory(entries.filter((entry) => matches(entry, needle))),
    [entries, needle],
  );

  return (
    <section className="ub-pane">
      <div className="ub-column ub-docs">
        <h1 className="ub-docs-heading">Documents</h1>
        <label className="ub-docs-search-label">
          <span>Find a document</span>
          <input
            type="search"
            className="ub-docs-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-describedby={SCOPE_ID}
          />
        </label>
        {/* The scope, on screen rather than assumed. A filter that quietly
            skipped the words inside documents would be read as a search that
            found nothing in them — so the field itself carries the sentence as
            its description, not only the sighted reader. */}
        <p id={SCOPE_ID} className="ub-docs-scope ub-muted">
          {SCOPE}
        </p>
        {rows.length === 0 ? (
          /* Four silences, and only two of them are answers. A client that has
             not heard from the directory yet knows neither that the workspace
             is empty nor that nothing in it matches — so it says what it does
             know instead of reporting a zero it cannot stand behind. */
          <p className="ub-muted ub-docs-empty">
            {needle !== ""
              ? status.synced
                ? "No documents match your search."
                : "No matches among the documents synced so far."
              : status.synced
                ? "No documents in this workspace yet."
                : "Nothing here yet — the directory has not synced on this client."}
          </p>
        ) : (
          <ul className="ub-docs-rows">
            {rows.map((entry) => (
              <li key={entry.uuid} className="ub-docs-row">
                <button
                  type="button"
                  className="ub-docs-open"
                  onClick={() => onSelect(entry.uuid)}
                  title={entry.uuid}
                >
                  <span className="ub-docs-line">
                    <span className="ub-docs-title">
                      {entry.title === "" ? <em>Untitled</em> : entry.title}
                    </span>
                    {/* Where the sidebar carries this document, when it does.
                        Blank is the honest answer for the long tail. */}
                    {groupOf.has(entry.uuid) && (
                      <span className="ub-docs-group">{groupOf.get(entry.uuid)}</span>
                    )}
                    <ChangedStamp at={entry.updatedAt} now={now} />
                  </span>
                  {/* Shown, not just filtered on: a row that matched on its
                      description with the description invisible looks like a
                      row that matched on nothing. */}
                  {entry.description !== undefined && entry.description !== "" && (
                    <span className="ub-docs-desc">{entry.description}</span>
                  )}
                  {entry.tags.length > 0 && (
                    <span className="ub-docs-tags">
                      {entry.tags.map((tag) => (
                        <span className="ub-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                {/* Curation from the one screen that shows every document —
                    the sidebar lists what is already pinned, so this is where
                    the long tail gets pinned from. The mark carries the state
                    and the row never changes width. */}
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

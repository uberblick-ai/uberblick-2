/**
 * The doc view's chrome (#69, design surface 1a): what the topbar says about
 * the open document, and the identity line above its prose.
 *
 * Almost everything here is a reading of state the system already keeps — the
 * document's tags, its uuid and rev, the awareness of whoever else is in the
 * room, the provider's connection status. None of it is new state. The one
 * writer is the tag strip on the identity line (#122), and it writes `meta.tags`
 * wholesale through schema's `setTags` — the same call, on the same key, that
 * `set_tags` makes for an agent.
 *
 * The two pills are drawn on the same rules as the rest of the chrome (#76):
 * fixed slots and no growth, so a peer arriving or the hub going away swaps
 * words in place rather than moving the header around them.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type * as Y from "yjs";
import { getMeta, setTags } from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { GROUP_TAGS, groupKeyForTags, groupLabel } from "./groups.js";
import { activeSession } from "./doc-chrome.js";
import type { RemotePresence } from "./doc-chrome.js";
import { useDocRev, useRoomStatus } from "./hooks.js";
import { distinctTags, withTag, withoutTag } from "./tags.js";
import type { ThreadView } from "./threads.js";

/** What an untitled document is called wherever its name is shown. */
const UNTITLED = "Untitled";

function titleOf(meta: DocMeta): string {
  return meta.title === "" ? UNTITLED : meta.title;
}

/** The document's group: the first canonical tag it carries (#39's rule). */
function groupOf(meta: DocMeta): string {
  return groupLabel(groupKeyForTags(meta.tags));
}

/**
 * `<group> / <title>` for the open document.
 *
 * The group comes from the document's own `meta.tags`, which is what makes a
 * retag land here immediately — and it is the same derivation the sidebar
 * groups by, so the breadcrumb and the list agree on where a document lives.
 */
function Breadcrumb({ meta }: { meta: DocMeta }): ReactElement {
  return (
    <nav className="ub-crumb" aria-label="Breadcrumb">
      <span className="ub-crumb-group">{groupOf(meta)}</span>
      <span className="ub-crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="ub-crumb-title">{titleOf(meta)}</span>
    </nav>
  );
}

/**
 * The doc chrome in the topbar: the breadcrumb, and the two pills on the right.
 *
 * `connection` is the room whose status the connection pill reports and whose
 * awareness the activity pill reads. The app hands it the open document's room,
 * falling back to the directory room when no document is open: the socket is
 * shared, so the directory's status is the same truth about the same hub — and
 * a document list that reads "offline" while it is plainly listing documents
 * would be the one thing #37 exists to prevent.
 */
export function DocChrome({
  connection,
  presence,
  meta,
  threads,
  threadsOpen,
  onToggleThreads,
  syncOpen,
  onToggleSync,
}: {
  connection: RoomConnection | null;
  /**
   * Every remote session in that room, read once by the shell. The pill names
   * one of them (`activeSession`) and the sync panel lists them all, from this
   * same snapshot — one subscription, and no way for the two to disagree.
   */
  presence: readonly RemotePresence[];
  /** The open document's metadata, or null when none is open or read yet. */
  meta: DocMeta | null;
  /**
   * The open document's threads — what the rail would show. Passed rather than
   * read here, because the app shell decides on the same value whether the
   * drawer may be open at all.
   */
  threads: readonly ThreadView[];
  /** Whether the threads rail is open as a drawer — see `.ub-rail-open`. */
  threadsOpen: boolean;
  onToggleThreads: () => void;
  /** Whether the sync detail panel is open — the connection pill opens it. */
  syncOpen: boolean;
  onToggleSync: () => void;
}): ReactElement {
  const activity = activeSession(presence);
  // The count is the open threads, the way the rail counts them. It is *not*
  // what decides whether the handle is drawn: a document whose conversations are
  // all resolved still has a rail full of them, and a reader who cannot reach it
  // has lost the archive. So the handle follows the rail's content and the
  // number follows the rail's head — including when that number is zero.
  const openThreads = threads.filter((thread) => !thread.resolved).length;
  const state = useCalmSyncState(rawSyncState(useRoomStatus(connection)));
  const label = state === "syncing" ? "syncing…" : state;
  // `meta.uuid === ""` is a room that answered with nothing in it — see
  // `useDocMeta`. There is no document to name, so the breadcrumb says nothing.
  const named = meta !== null && meta.uuid !== "";
  return (
    <>
      {named && <Breadcrumb meta={meta} />}
      <span className="ub-chrome-pills">
        {/* The drawer's handle (#101). Below 1100px there is no room for the
            rail beside the prose, so it is hidden and this opens it as an
            overlay instead; above that width the rail is already on screen and
            the stylesheet drops this button. A document with nothing to say has
            no handle either. */}
        {threads.length > 0 && (
          <button
            type="button"
            className="ub-threads-toggle"
            aria-expanded={threadsOpen}
            aria-controls="ub-rail"
            onClick={onToggleThreads}
          >
            Threads <span className="ub-muted">{openThreads}</span>
          </button>
        )}
        {activity !== null && (
          <span
            className="ub-pill ub-pill-agent"
            // The session's presence colour, the same one its cursor carries in
            // the prose — the pill and the caret are one identity in two places.
            style={{ borderColor: activity.color, color: activity.color }}
          >
            {activity.name} editing block {activity.block}
          </span>
        )}
        {/* The pill is the panel's handle (#72): the indicator someone looks at
            when they wonder about sync is the thing to press for the detail.
            It stays a pill — same slots, same widths — so nothing beside it
            moves when it becomes operable. */}
        <button
          type="button"
          className={`ub-pill ub-pill-${state} ub-sync-toggle`}
          aria-expanded={syncOpen}
          aria-controls="ub-sync-panel"
          // The visible label is one word about the state, not about the
          // action, and `title` is not reliably announced — so the accessible
          // name carries both, keeping the visible word inside it.
          aria-label={`Sync details — ${label}`}
          title="Sync details"
          onClick={onToggleSync}
        >
          <span className="ub-status-mark" aria-hidden="true">
            {state === "syncing" ? (
              <span className="ub-spinner" />
            ) : (
              <span
                className={`ub-dot ${state === "synced" ? "ub-dot-live" : "ub-dot-off"}`}
              />
            )}
          </span>
          {/* The same fixed-width slot the status line uses: "syncing…" is the
              longest of the three words, so the pill never changes size and
              nothing beside it moves. */}
          <span className="ub-status-word">{label}</span>
        </button>
      </span>
    </>
  );
}

/** The id the add field points at — one document is open at a time. */
const SUGGESTIONS_ID = "ub-tag-suggestions";

/**
 * The document's tags, editable (#122).
 *
 * Every write is `setTags` on the document's own Y.Doc — the wholesale replace
 * `set_tags` performs, on the same `meta.tags`. That is what makes this a
 * *human front door to the agent's write* rather than a second tagging
 * mechanism: the directory stub is repaired from `meta` by the shell's existing
 * observer, so the sidebar group, the breadcrumb, `list_docs` and every other
 * client follow a chip the way they follow an agent.
 *
 * The next array is folded from `getMeta(ydoc).tags`, never from the rendered
 * prop. A remote wholesale write that landed between paint and click is already
 * in the document, and adding a chip must not carry a stale list back over it.
 *
 * Suggestions ride a native `<datalist>`: the browser filters it as the reader
 * types, keyboard included, and free-form input stays free-form. The list is
 * the workspace's tags minus the ones already on this document — suggesting a
 * chip that is already on screen would offer a write this component rejects.
 *
 * The same list, with the canonical group tags in front of it, is what a new
 * tag's spelling is snapped to (`withTag`): the group tags are spelled a
 * particular way whether or not any document in this workspace carries one yet.
 */
function TagStrip({
  ydoc,
  tags,
  known,
  readOnly,
}: {
  ydoc: Y.Doc;
  /** The document's tags as last read — what the chips show. */
  tags: readonly string[];
  /** Every tag the workspace uses, from the directory stubs. */
  known: readonly string[];
  /** Archived: the chips are still worth reading, and nothing here writes. */
  readOnly: boolean;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const strip = useRef<HTMLSpanElement | null>(null);
  /**
   * The chip position whose removal still owes the reader somewhere to stand.
   *
   * Removing a chip unmounts the button that had focus, and focus on a detached
   * element is focus on `<body>` — the keyboard reader is silently returned to
   * the top of the page, mid-gesture. The target cannot be picked here, because
   * the element to focus does not exist until the write has re-rendered the
   * strip, so the *position* is remembered and resolved in the layout effect
   * below.
   */
  const [refocus, setRefocus] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    const buttons = [
      ...(strip.current?.querySelectorAll<HTMLButtonElement>(".ub-tag-x") ?? []),
    ];
    // The chip that took the removed one's place, the last chip when it was the
    // last, and the add field when it was the only one: always the nearest
    // thing to where the reader was.
    const next = buttons[Math.min(refocus, buttons.length - 1)];
    const target =
      next ?? strip.current?.querySelector<HTMLInputElement>(".ub-tag-add");
    target?.focus();
  }, [refocus]);

  const add = (): void => {
    const next = withTag(getMeta(ydoc).tags, draft, [...GROUP_TAGS, ...known]);
    // Cleared either way: a duplicate or a blank is rejected quietly, and
    // leaving the word in the field would read as a failure nobody explained.
    setDraft("");
    if (next !== null) setTags(ydoc, next);
  };

  const remove = (tag: string, at: number): void => {
    setRefocus(at);
    setTags(ydoc, withoutTag(getMeta(ydoc).tags, tag));
  };

  // One chip per distinct tag: a duplicate in the array is one tag, and two
  // chips carrying the same word would be two React children with one key.
  const shown = distinctTags(tags);
  const suggestions = known.filter(
    (tag) => !tags.some((current) => current.toLowerCase() === tag.toLowerCase()),
  );

  return (
    <span className="ub-tags" ref={strip}>
      {shown.map((tag, at) => (
        <span className="ub-tag" key={tag}>
          <span className="ub-tag-name">{tag}</span>
          {!readOnly && (
            <button
              type="button"
              className="ub-tag-x"
              // The visible label is a glyph, so the accessible name says what
              // the button does and to which tag.
              aria-label={`Remove tag ${tag}`}
              title={`Remove tag ${tag}`}
              onClick={() => remove(tag, at)}
              // The keyboard-only path: the × is the chip's tab stop, and the
              // keys a reader reaches for on a focused chip are the delete
              // keys. Enter and Space already activate it, natively.
              onKeyDown={(event) => {
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                remove(tag, at);
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <>
          <input
            className="ub-tag-add"
            list={SUGGESTIONS_ID}
            value={draft}
            placeholder="+ tag"
            aria-label="Add a tag"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // An Enter that ends an IME composition belongs to the input
              // method, not to this field: it is how a Japanese or Chinese
              // reader accepts the candidate they are still typing, and
              // committing a tag there would cut the word in half. The keyCode
              // is the same check for the browsers that predate `isComposing`.
              const native = event.nativeEvent;
              if (native.isComposing || native.keyCode === 229) return;
              event.preventDefault();
              add();
            }}
          />
          <datalist id={SUGGESTIONS_ID}>
            {suggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </>
      )}
    </span>
  );
}

/**
 * The document's identity, above its prose: what kind of document this is, its
 * tags, and the two machine facts that identify the thing on screen.
 *
 * **Above the prose and above the title** (owner, design surface 1a): the
 * eyebrow line sits over the H1, and the tags sit in it. Putting them there
 * costs the title nothing, because the row is a fixed-height single line whose
 * add field is always drawn — the height with no chips is the height with six —
 * and the chips scroll sideways inside their own box rather than wrapping onto
 * a second line. The uuid and rev are pinned to the row's end, so a chip
 * appearing moves neither them nor the title.
 *
 * **The row is drawn before there is anything to put in it**, and that is the
 * same rule rather than a second one. `meta` is null for the first paint after
 * a document is opened or switched to — the observer reads it an effect later —
 * so a row that appeared with its contents would push the title down one frame
 * after every navigation, which is the jump the whole layout is built to avoid.
 * The shell is unconditional and its height comes from `min-height`; the words
 * arrive into a space that was already reserved for them.
 *
 * The uuid is shortened because identity is the uuid but *recognition* is its
 * first few characters — the full one is a click away on the room key below the
 * title. The rev is the whole document's, folded from its block revs
 * (`docRev`), so it moves on every edit; it sits in a fixed-width monospace slot
 * for that reason, since a rev that changed the width of this line would drag
 * the line around while somebody types.
 */
export function DocMetaLine({
  connection,
  meta,
  knownTags,
  archived,
}: {
  connection: RoomConnection;
  meta: DocMeta | null;
  /** Every tag the workspace uses — the add field's suggestions. */
  knownTags: readonly string[];
  /** Whether the directory tombstones this document: no writes from here. */
  archived: boolean;
}): ReactElement {
  const rev = useDocRev(connection);
  return (
    <p className="ub-doc-meta">
      {/* Nothing to say about a room that has not answered yet, and nothing to
          tag in it either — but the row itself stands, holding the space. */}
      {meta !== null && meta.uuid !== "" && (
        <>
          <span className="ub-badge">{groupOf(meta)}</span>
          <TagStrip
            ydoc={connection.ydoc}
            tags={meta.tags}
            known={knownTags}
            readOnly={archived}
          />
          <span className="ub-doc-ids">
            uuid {meta.uuid.slice(0, 8)} · rev {rev ?? "········"}
          </span>
        </>
      )}
    </p>
  );
}

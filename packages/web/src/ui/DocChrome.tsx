/**
 * The document identity line above its prose: editable tags, stable identity,
 * copy affordance and document actions.
 *
 * The tags are the one writer here: they write `meta.tags` wholesale through
 * schema's `setTags`, the same call and key `set_tags` uses for an agent.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type * as Y from "yjs";
import { getMeta, parseRoom, setTags } from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import { writeToClipboard } from "../editor/source-chrome.js";
import type { RoomConnection } from "../collab/rooms.js";
import { GROUP_TAGS, groupKeyForTags, groupLabel } from "./groups.js";
import { useDocRev } from "./hooks.js";
import { shareUrl } from "./route.js";
import { distinctTags, withTag, withoutTag } from "./tags.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./shadcn/dialog.js";

/** What an untitled document is called wherever its name is shown. */
const UNTITLED = "Untitled";

function titleOf(meta: DocMeta): string {
  return meta.title === "" ? UNTITLED : meta.title;
}

/**
 * The document's group: the first canonical tag it carries (#39's rule), or
 * null when it carries none of them.
 */
function groupOf(meta: DocMeta): string | null {
  return groupLabel(groupKeyForTags(meta.tags));
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
 * observer, so the sidebar group, `list_docs` and every other
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

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_MS = 1_500;

type CopyResult = "idle" | "copied" | "failed";

/**
 * Copy this document's shareable link (#68), at the end of the identity line.
 *
 * It used to be the room key under the title, which was both the label and the
 * affordance. The key itself is gone from the header (#535) — the sync panel is
 * where a `<workspaceId>/<docUuid>` belongs — so what is left is a control that
 * says what it does, beside the identity it is about.
 *
 * Exported because the identity line is not the only place a reader is looking
 * at a document's address. A document that has not reached this replica yet
 * draws the waiting notice instead of this line, and that is a state a link is
 * *more* worth sending from, not less — it can last as long as the hub is away.
 * `RoutePane` renders the same control there.
 *
 * The link is built from `segment` — the workspace as the *address* spells it —
 * rather than from the room key, which carries the bare uuid. The two are the
 * same string for an undecorated workspace and differ for `<slug>-<uuid>`, and
 * a copy that quietly handed back the undecorated form would rewrite somebody's
 * link on its way out of their own address bar. What is copied is the address
 * this document is open at, and the accessible name names it.
 *
 * The copy goes through `writeToClipboard`, not `navigator.clipboard`: that API
 * exists only in a secure context, and serving this client over plain http on a
 * tailnet host is a supported deployment (REMOTE.md). The shared helper falls
 * back to `execCommand`, and reports whether either worked — so a failure is
 * said out loud rather than swallowed into a button that quietly does nothing.
 *
 * The confirmation is positioned out of flow for the reason the rest of this
 * row is built the way it is (#76): nothing here may move sideways, and a word
 * appearing in the row would move everything after it.
 */
export function CopyLink({
  room,
  segment,
}: {
  room: string;
  segment: string;
}): ReactElement {
  const [result, setResult] = useState<CopyResult>("idle");

  useEffect(() => {
    if (result === "idle") return;
    const timer = setTimeout(() => setResult("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [result]);

  // The one address this button is about: what it copies, and what it says it
  // copies. Two derivations of that would be two chances for them to disagree.
  const address = `${segment}/${parseRoom(room).uuid}`;

  const copy = async (): Promise<void> => {
    const ok = await writeToClipboard(shareUrl(address, window.location.origin));
    setResult(ok ? "copied" : "failed");
  };

  return (
    <span className="ub-copy-wrap">
      <button
        type="button"
        className="ub-copy-link"
        // The visible words name the action; `title` is not reliably announced,
        // so the accessible name carries them *and* the address that lands on
        // the clipboard — which is the part a reader cannot see.
        aria-label={`Copy link to ${address}`}
        title={`Copy link to ${address}`}
        onClick={() => void copy()}
      >
        Copy link
      </button>
      {/* Rendered always, empty when idle: `role="status"` only announces
          changes to a region the reader was already in. */}
      <span className="ub-copied" role="status">
        {result !== "idle" && (result === "copied" ? "link copied" : "copy failed")}
      </span>
    </span>
  );
}

/**
 * The document's identity, above its prose: what kind of document this is, its
 * tags, the two machine facts that identify the thing on screen, and the link
 * to it.
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
 * first few characters. The full one is not in the header at all any more
 * (#535): the room key that carried it under the title said the same thing a
 * third time, and the sync panel is where a reader who wants it goes. The rev
 * is the whole document's, folded from its block revs
 * (`docRev`), so it moves on every edit; it sits in a fixed-width monospace slot
 * for that reason, since a rev that changed the width of this line would drag
 * the line around while somebody types.
 */
export function DocMetaLine({
  connection,
  segment,
  meta,
  knownTags,
  archived,
  pinned = false,
  onTogglePin = null,
  onArchive = null,
  onArchiveConfirmationFocusChange,
}: {
  connection: RoomConnection;
  /** The workspace as the address spells it — what a copied link carries. */
  segment: string;
  meta: DocMeta | null;
  /** Every tag the workspace uses — the add field's suggestions. */
  knownTags: readonly string[];
  /** Whether the directory tombstones this document: no writes from here. */
  archived: boolean;
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  /** Null means this replica cannot establish a current live directory stub. */
  onArchive?: (() => void) | null;
  /** Whether focus is inside the confirmation a remote archive may remove. */
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
}): ReactElement {
  const rev = useDocRev(connection);
  const group = meta === null ? null : groupOf(meta);
  return (
    <p className="ub-doc-meta">
      {/* Nothing to say about a room that has not answered yet, and nothing to
          tag in it either — but the row itself stands, holding the space. */}
      {meta !== null && meta.uuid !== "" && (
        <>
          {/* Only where the document is in a named group: a badge for the
              fallback would label every untagged document with a word that
              names no group (#535). */}
          {group !== null && <span className="ub-badge">{group}</span>}
          <TagStrip
            ydoc={connection.ydoc}
            tags={meta.tags}
            known={knownTags}
            readOnly={archived}
          />
          <span className="ub-doc-ids">
            uuid {meta.uuid.slice(0, 8)} · rev {rev ?? "········"}
          </span>
          {/* Archived or not: a tombstoned document still has an address, and
              handing somebody the link to it is not a write. */}
          <CopyLink room={connection.room} segment={segment} />
          {!archived && (
            <DocumentActions
              key={connection.room}
              title={titleOf(meta)}
              pinned={pinned}
              onTogglePin={onTogglePin}
              onArchive={onArchive}
              onConfirmationFocusChange={onArchiveConfirmationFocusChange}
            />
          )}
        </>
      )}
    </p>
  );
}

function DocumentActions({
  title,
  pinned,
  onTogglePin,
  onArchive,
  onConfirmationFocusChange,
}: {
  title: string;
  pinned: boolean;
  onTogglePin: (() => void) | null;
  onArchive: (() => void) | null;
  onConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () => () => onConfirmationFocusChange?.(false),
    [onConfirmationFocusChange],
  );

  return (
    <Dialog
      open={confirming}
      onOpenChange={(open) => {
        // The persistent menu button is also DialogTrigger so Radix can return
        // focus to it. Its ordinary menu click therefore requests a dialog
        // open too; only the Archive item below is allowed to accept that half.
        if (!open) setConfirming(false);
      }}
    >
      <span className="ub-document-actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <DialogTrigger asChild>
              <button
                type="button"
                className="ub-actions-trigger"
                aria-label="Document actions"
                title="Document actions"
              >
                ⋯
              </button>
            </DialogTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={onTogglePin === null}
              className={pinned ? "ub-action-pinned" : ""}
              onSelect={() => onTogglePin?.()}
            >
              {pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              aria-disabled={onArchive === null}
              className="ub-action-danger"
              onSelect={(event) => {
                if (onArchive === null) {
                  event.preventDefault();
                  return;
                }
                setConfirming(true);
              }}
            >
              {onArchive === null
                ? "Archive unavailable — no directory connection, or no live entry for this document"
                : "Archive document"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DialogContent
          className="ub-confirm"
          role="alertdialog"
          onFocusCapture={() => onConfirmationFocusChange?.(true)}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
              onConfirmationFocusChange?.(false);
            }
          }}
        >
          <DialogTitle>Archive {title}?</DialogTitle>
          <DialogDescription>
            Its content is preserved, but the document becomes read-only and
            leaves normal listings until you Restore it.
          </DialogDescription>
          <span className="ub-confirm-actions">
            <DialogClose asChild>
              <button type="button" className="ub-tool">
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="ub-tool ub-tool-danger"
              onClick={() => {
                setConfirming(false);
                onArchive?.();
              }}
            >
              Archive document
            </button>
          </span>
        </DialogContent>
      </span>
    </Dialog>
  );
}

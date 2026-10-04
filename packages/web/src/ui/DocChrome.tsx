/**
 * The document identity line above its prose: catalog-backed tags, stable
 * identity, copy affordance and document actions.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import type * as Y from "yjs";
import {
  assignDocumentTags,
  getMeta,
  getTagCatalogEntry,
  parseRoom,
  resolveTagAssignments,
} from "@uberblick/schema";
import type { DocMeta, TagAssignment, TagCatalogEntry } from "@uberblick/schema";
import { writeToClipboard } from "../editor/source-chrome.js";
import type { RoomConnection } from "../collab/rooms.js";
import { useDocRev, useRoomStatus } from "./hooks.js";
import { LifecycleBadge } from "./LifecycleBadge.js";
import { shareUrl } from "./route.js";
import { useTagCatalog } from "./tags.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./shadcn/alert-dialog.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";

/** What an untitled document is called wherever its name is shown. */
const UNTITLED = "Untitled";

function titleOf(meta: DocMeta): string {
  return meta.title === "" ? UNTITLED : meta.title;
}

function named(entry: TagAssignment): entry is TagCatalogEntry {
  return entry.name !== null;
}

function tagLabel(entry: TagCatalogEntry): string {
  return entry.state === "retired" ? `${entry.name} (retired)` : entry.name;
}

/**
 * How many entries the panel lists before it offers a search field (#958).
 *
 * Below it the whole vocabulary is on screen already, and a field would only
 * stand between the reader and the first option — so the list is the panel,
 * and the keyboard enters it directly. The count is the live one: it includes
 * the retired entries this document still carries, and it is read again on
 * every render, so removing the tenth takes the field away with it rather than
 * leaving a filter nobody can see.
 */
const TAG_SEARCH_THRESHOLD = 10;

/** A magnifier, so the field reads as a search before anything is typed. */
function TagSearchIcon(): ReactElement {
  return (
    <svg className="ub-tag-search-icon block size-3.5 shrink-0 text-muted-foreground" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6.75" cy="6.75" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M9.9 9.9 13.5 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The catalog-backed multi-select in the document header, as inline pills. */
function TagStrip({
  ydoc,
  tags,
  catalogConnection,
  readOnly,
  canWrite,
}: {
  ydoc: Y.Doc;
  /** The document's identities as last read — what the selected labels resolve. */
  tags: readonly string[];
  catalogConnection: RoomConnection | null;
  /** Archived or disconnected: assignments remain readable, but nothing writes. */
  readOnly: boolean;
  /** Recheck the live room at the exact write boundary. */
  canWrite: () => boolean;
}): ReactElement {
  const catalog = useTagCatalog(catalogConnection);
  const catalogStatus = useRoomStatus(catalogConnection);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Set when a toggle is about to unmount the option that holds focus. */
  const repairFocus = useRef(false);
  const listId = useId();
  const arrived =
    catalogConnection !== null && catalogStatus.hasReceivedServerState;
  const assignments =
    arrived && catalogConnection !== null
      ? resolveTagAssignments(catalogConnection.ydoc, tags)
      : [];
  const shown = assignments.filter(named).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const selected = new Set(assignments.map((entry) => entry.id));
  const options = (catalog?.entries ?? []).filter(
    (entry) => entry.state === "active" || selected.has(entry.id),
  );
  const showSearch = options.length >= TAG_SEARCH_THRESHOLD;
  // No field, no filter. `query` survives until the popover closes, so a count
  // that drops below the threshold while the panel is open would otherwise
  // leave text nobody can see hiding entries nobody can reach.
  const normalizedQuery = showSearch ? query.trim().toLowerCase() : "";
  const filtered = options.filter(
    (entry) =>
      normalizedQuery === "" || entry.name.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (readOnly || !arrived) setOpen(false);
  }, [arrived, readOnly]);

  /**
   * The way into the open panel, as the panel currently is: the search field
   * where there is one, otherwise the first option — and the trigger where
   * there is neither, so the keyboard never falls through to the page body.
   */
  const focusPanelEntry = (): void => {
    if (showSearch) {
      search.current?.focus();
      return;
    }
    const first = filtered.length > 0 ? optionRefs.current[0] : null;
    if (first !== null && first !== undefined) first.focus();
    else trigger.current?.focus();
  };

  // Removing an assigned retired entry unmounts the option holding focus, and
  // may take the search field with it. Repair after the render that dropped it.
  // Deliberately unkeyed and guarded by the ref: what this must run after is
  // *that* render, whichever one it turns out to be.
  useEffect(() => {
    if (!repairFocus.current) return;
    repairFocus.current = false;
    focusPanelEntry();
  });

  const toggle = (entry: TagCatalogEntry): void => {
    if (
      readOnly ||
      !arrived ||
      catalogConnection === null ||
      !canWrite()
    ) {
      return;
    }
    // Re-read both replicas at the write boundary. A stale render therefore
    // toggles only this identity on top of an intervening remote assignment.
    const liveIds = resolveTagAssignments(
      catalogConnection.ydoc,
      getMeta(ydoc).tags,
    ).map((assigned) => assigned.id);
    const isSelected = liveIds.includes(entry.id);
    const liveEntry = getTagCatalogEntry(catalogConnection.ydoc, entry.id);
    if (!isSelected && liveEntry?.state !== "active") return;
    if (isSelected && liveEntry?.state === "retired") repairFocus.current = true;
    assignDocumentTags(
      ydoc,
      catalogConnection.ydoc,
      isSelected
        ? liveIds.filter((identity) => identity !== entry.id)
        : [...liveIds, entry.id],
    );
  };

  const focusOption = (index: number): void => {
    if (filtered.length === 0) return;
    const wrapped = (index + filtered.length) % filtered.length;
    optionRefs.current[wrapped]?.focus();
  };

  const labels = shown.map((entry) => (
    <span className="ub-tag" key={entry.id}>
      <span className="ub-tag-name">{tagLabel(entry)}</span>
    </span>
  ));

  if (readOnly || !arrived) {
    return (
      <span className="ub-tags ub-tags-readonly">
        {arrived ? (labels.length > 0 ? labels : <span>No tags</span>) : (
          <span role="status">Loading tags…</span>
        )}
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className="ub-tags ub-tag-picker-trigger"
          aria-label="Edit tags"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
        >
          <span className="ub-tag-selected">
            {labels.length > 0 ? labels : <span className="ub-tag-placeholder">Add tags</span>}
          </span>
          <span className="ub-tag-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="ub-tag-picker-panel w-[min(20rem,calc(100vw_-_2rem))]! overflow-hidden p-0!"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusPanelEntry();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        {showSearch && (
          <div className="ub-tag-search-wrap border-b border-border p-2">
            <span className="ub-tag-search-field flex items-center gap-[0.4rem] rounded-(--radius-sm) border border-(--sidebar-input) bg-background px-2 py-[0.35rem] text-foreground focus-within:outline-2 focus-within:outline-(--ring) focus-within:-outline-offset-1">
              <TagSearchIcon />
              <input
                ref={search}
                type="search"
                className="ub-tag-search min-w-0 flex-auto border-0 bg-transparent p-0 text-inherit [font:inherit] placeholder:text-muted-foreground placeholder:opacity-100 focus-visible:outline-none"
                value={query}
                placeholder="Search tags"
                aria-label="Search tags"
                aria-controls={listId}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  const native = event.nativeEvent;
                  if (native.isComposing || native.keyCode === 229) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusOption(0);
                  }
                }}
              />
            </span>
          </div>
        )}
        <div
          id={listId}
          className="ub-tag-options max-h-56 overflow-y-auto p-[0.35rem]"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Available tags"
        >
          {filtered.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              className="ub-tag-option flex w-full cursor-pointer items-center gap-[0.45rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.45rem] py-[0.4rem] text-left text-popover-foreground [font:inherit] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              role="option"
              aria-selected={selected.has(entry.id)}
              onClick={() => toggle(entry)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusOption(index + 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(index - 1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  focusOption(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  focusOption(filtered.length - 1);
                }
              }}
            >
              <span className="ub-tag-check inline-flex size-4 shrink-0 items-center justify-center rounded-[0.2rem] border border-(--sidebar-muted-foreground)" aria-hidden="true">
                {selected.has(entry.id) ? "✓" : ""}
              </span>
              <span>{entry.name}</span>
              {entry.state === "retired" && (
                <span className="ub-tag-retired ml-auto text-muted-foreground">retired</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="ub-tag-empty m-0 px-2 py-[0.65rem] text-muted-foreground">
              {options.length === 0 ? "No tags available." : "No matching tags."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_MS = 1_500;

type CopyResult = "idle" | "copied" | "failed";

/**
 * Copy this document's shareable link (#68).
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
 * The hydrated identity line supplies its short uuid as the visible label. The
 * waiting screen has no identity line yet, so it keeps the explicit label.
 */
export function CopyLink({
  room,
  segment,
  shortUuid,
}: {
  room: string;
  segment: string;
  shortUuid?: string;
}): ReactElement {
  const [result, setResult] = useState<CopyResult>("idle");
  const label = shortUuid === undefined ? "Copy link" : `uuid ${shortUuid}`;
  const identity = shortUuid !== undefined;

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
    <span className={`ub-copy-wrap${identity ? " ub-copy-identity" : ""}`}>
      <button
        type="button"
        className="ub-copy-link"
        // `title` is not reliably announced, so the accessible name carries the
        // action and the address that lands on the clipboard even where the
        // visible label is only the document's short uuid.
        aria-label={`${label} — copies the canonical document URL for ${address}`}
        title={`${label} — copies the canonical document URL for ${address}`}
        onClick={() => void copy()}
      >
        {label}
      </button>
      {/* Rendered always, empty when idle: `role="status"` only announces
          changes to a region the reader was already in. */}
      <span className="ub-copied" role="status">
        {result !== "idle" &&
          (result === "copied" ? "URL copied to clipboard" : "Copy failed")}
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
 * eyebrow line sits over the H1, and the tag picker sits in it. The picker is a
 * fixed-height single control whose selected labels scroll inside their own
 * box rather than wrapping. The uuid and rev are pinned to the row's end, so a
 * changed assignment moves neither them nor the title.
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
  catalogConnection = null,
  segment,
  meta,
  archived,
  readOnly = false,
  pinned = false,
  onTogglePin = null,
  onArchive = null,
  onArchiveConfirmationFocusChange,
  hasTldr = false,
  onEditTldr,
}: {
  connection: RoomConnection;
  /** The workspace settings room that owns the curated tag catalog. */
  catalogConnection?: RoomConnection | null;
  /** The workspace as the address spells it — what a copied link carries. */
  segment: string;
  meta: DocMeta | null;
  /** Whether the directory tombstones this document: no writes from here. */
  archived: boolean;
  /** Whether the document room currently refuses writes. */
  readOnly?: boolean;
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  /** Null means this replica cannot establish a current live directory stub. */
  onArchive?: (() => void) | null;
  /** Whether focus is inside the confirmation a remote archive may remove. */
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  /** Whether the document-actions entry adds or edits the person-facing summary. */
  hasTldr?: boolean;
  onEditTldr?: (() => void) | undefined;
}): ReactElement {
  const rev = useDocRev(connection);
  return (
    <p className="ub-doc-meta">
      {/* Nothing to say about a room that has not answered yet, and nothing to
          tag in it either — but the row itself stands, holding the space. */}
      {meta !== null && meta.uuid !== "" && (
        <>
          <LifecycleBadge kind={meta.kind} status={meta.status} />
          <TagStrip
            ydoc={connection.ydoc}
            tags={meta.tags}
            catalogConnection={catalogConnection}
            readOnly={archived || readOnly}
            canWrite={() => connection.status.writable}
          />
          <span className="ub-doc-ids">
            <CopyLink
              room={connection.room}
              segment={segment}
              shortUuid={meta.uuid.slice(0, 8)}
            />
            <span className="ub-doc-rev"> · rev {rev ?? "········"}</span>
          </span>
          {!archived && (
            <DocumentActions
              key={connection.room}
              title={titleOf(meta)}
              pinned={pinned}
              onTogglePin={onTogglePin}
              onArchive={onArchive}
              onConfirmationFocusChange={onArchiveConfirmationFocusChange}
              hasTldr={hasTldr}
              onEditTldr={readOnly ? null : (onEditTldr ?? null)}
            />
          )}
        </>
      )}
    </p>
  );
}

/**
 * Why Archive is refused, in the menu and inside an already-open confirmation.
 *
 * One sentence for both, because they are one refusal: the rooms this action
 * writes can stop being ready between opening the menu and confirming, and a
 * dialog that closed silently on that click would be indistinguishable from an
 * archive that happened.
 */
const ARCHIVE_UNAVAILABLE =
  "Archive unavailable — the directory or sidebar room is not ready to write, or there is no live entry for this document";

function DocumentActions({
  title,
  pinned,
  onTogglePin,
  onArchive,
  onConfirmationFocusChange,
  hasTldr,
  onEditTldr,
}: {
  title: string;
  pinned: boolean;
  onTogglePin: (() => void) | null;
  onArchive: (() => void) | null;
  onConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  hasTldr: boolean;
  onEditTldr: (() => void) | null;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const openingTldrEditor = useRef(false);

  useEffect(
    () => () => onConfirmationFocusChange?.(false),
    [onConfirmationFocusChange],
  );

  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(open) => {
        // The persistent menu button is also AlertDialogTrigger so Radix can return
        // focus to it. Its ordinary menu click therefore requests a dialog
        // open too; only the Archive item below is allowed to accept that half.
        if (!open) setConfirming(false);
      }}
    >
      <span className="ub-document-actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="ub-actions-trigger"
                aria-label="Document actions"
                title="Document actions"
              >
                ⋯
              </button>
            </AlertDialogTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (!openingTldrEditor.current) return;
              openingTldrEditor.current = false;
              // The selected action reveals a textarea outside this portal.
              // Let that field keep the focus its mount effect gives it.
              event.preventDefault();
            }}
          >
            <DropdownMenuItem
              disabled={onTogglePin === null}
              className={pinned ? "ub-action-pinned text-(--brand-ink)!" : ""}
              onSelect={() => onTogglePin?.()}
            >
              {onTogglePin === null
                ? `${pinned ? "Unpin" : "Pin"} unavailable — sidebar is not ready to write`
                : pinned
                  ? "Unpin from sidebar"
                  : "Pin to sidebar"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={onEditTldr === null}
              onSelect={() => {
                openingTldrEditor.current = true;
                onEditTldr?.();
              }}
            >
              {onEditTldr === null
                ? `${hasTldr ? "Edit" : "Add"} TL;DR unavailable — document is read-only`
                : `${hasTldr ? "Edit" : "Add"} TL;DR`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              aria-disabled={onArchive === null}
              variant="destructive"
              className="ub-action-danger text-[light-dark(oklch(0.51_0.20_27.325),var(--destructive))]!"
              onSelect={(event) => {
                if (onArchive === null) {
                  event.preventDefault();
                  return;
                }
                setConfirming(true);
              }}
            >
              {onArchive === null ? ARCHIVE_UNAVAILABLE : "Archive document"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialogContent
          onFocusCapture={() => onConfirmationFocusChange?.(true)}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
              onConfirmationFocusChange?.(false);
            }
          }}
        >
          <AlertDialogTitle>Archive {title}?</AlertDialogTitle>
          <AlertDialogDescription>
            {onArchive === null
              ? `${ARCHIVE_UNAVAILABLE}. Nothing has been archived.`
              : "Its content is preserved, but the document becomes read-only and leaves normal listings until you Restore it."}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={onArchive === null}
              onClick={(event) => {
                // Readiness can be lost while this dialog is open, and then
                // closing on the click would look exactly like a successful
                // archive. Refuse in place instead: the dialog stays, saying
                // why, and Cancel is still the way out.
                if (onArchive === null) {
                  event.preventDefault();
                  return;
                }
                onArchive();
              }}
            >
              Archive document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </span>
    </AlertDialog>
  );
}

/**
 * The document metadata line above its prose: catalog-backed tags, lifecycle
 * and document actions.
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
import { writeToClipboard } from "../../editor/source-chrome.js";
import { notifyTransient } from "../../notifications.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { useRoomStatus } from "../hooks.js";
import { LifecycleBadge } from "./LifecycleBadge.js";
import { PickerList } from "../PickerList.js";
import { shareUrl } from "../route.js";
import { useTagCatalog } from "../tags.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../shadcn/dropdown-menu.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../shadcn/alert-dialog.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shadcn/popover.js";

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
 * Offer search only at the live entry threshold, including assigned retired
 * tags. Below it, keyboard entry goes directly to the list; a changing count
 * must also remove any hidden filter.
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
  const list = useRef<HTMLDivElement | null>(null);
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
   * Enter the search field, otherwise the first option, otherwise the
   * trigger; never strand keyboard focus on the page body.
   */
  const focusPanelEntry = (): void => {
    if (showSearch) {
      search.current?.focus();
      return;
    }
    const first = list.current?.querySelector<HTMLButtonElement>("[role='option']");
    if (first !== null && first !== undefined) first.focus();
    else trigger.current?.focus();
  };

  // A retired-tag removal may unmount the focused option and search field.
  // Repair focus after that render, using the one-shot ref rather than a
  // keyed effect.
  useEffect(() => {
    if (!repairFocus.current) return;
    repairFocus.current = false;
    focusPanelEntry();
  });

  const toggle = (id: string): void => {
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
    const isSelected = liveIds.includes(id);
    const liveEntry = getTagCatalogEntry(catalogConnection.ydoc, id);
    if (!isSelected && liveEntry?.state !== "active") return;
    if (isSelected && liveEntry?.state === "retired") repairFocus.current = true;
    assignDocumentTags(
      ydoc,
      catalogConnection.ydoc,
      isSelected
        ? liveIds.filter((identity) => identity !== id)
        : [...liveIds, id],
    );
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
          className="ub-tags ub-tag-picker-trigger group/tags flex min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 flex-auto cursor-pointer flex-wrap items-center gap-[0.3rem] border-0 bg-transparent p-0 text-left [font:inherit] text-inherit focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          aria-label="Edit tags"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
        >
          <span className="ub-tag-selected">
            {labels.length > 0 ? labels : <span className="ub-tag-placeholder">Add tags</span>}
          </span>
          <span className="ub-tag-chevron flex-none ub-type-caption opacity-55 group-hover/tags:opacity-100" aria-hidden="true">
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
                className="ub-tag-search min-h-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:ub-type-body min-w-0 flex-auto border-0 bg-transparent p-0 text-inherit [font:inherit] placeholder:text-muted-foreground placeholder:opacity-100 focus-visible:outline-none"
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
                    list.current?.querySelector<HTMLButtonElement>("[role='option']")?.focus();
                  }
                }}
              />
            </span>
          </div>
        )}
        <PickerList
          id={listId}
          label="Available tags"
          options={filtered.map((entry) => ({
            id: entry.id,
            label: entry.name,
            selected: selected.has(entry.id),
            ...(entry.state === "retired" ? { detail: "retired" } : {}),
          }))}
          multiple
          onPick={toggle}
          empty={options.length === 0 ? "No tags available." : "No matching tags."}
          listRef={list}
        />
      </PopoverContent>
    </Popover>
  );
}

function copyAddress(room: string, segment: string, copyPath?: string): string {
  return copyPath?.replace(/^\//, "") ?? `${segment}/${parseRoom(room).uuid}`;
}

async function copyText(text: string, message: string, fallbackReady?: Promise<void>): Promise<void> {
  const ok = await writeToClipboard(text, fallbackReady);
  notifyTransient({
    key: "clipboard",
    message: ok ? message : "Copy failed",
    severity: ok ? "success" : "error",
  });
}

/** The waiting screen has no actions menu, so it keeps an explicit control. */
export function CopyLink({
  room,
  segment,
  copyPath,
}: {
  room: string;
  segment: string;
  copyPath?: string | undefined;
}): ReactElement {
  // Derive the copied address and its accessible name from the same value.
  const address = copyAddress(room, segment, copyPath);

  return (
    <span className="ub-copy-wrap">
      <button
        type="button"
        className="ub-copy-link inline-flex min-h-11 min-w-[max(2.75rem,6em)] cursor-pointer items-center justify-center border-0 bg-transparent px-[0.15rem] py-0 [font:inherit] text-(--muted-foreground) hover:text-(--foreground) hover:underline focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        aria-label={`Copy link — copies the canonical document URL for ${address}`}
        title={`Copy link — copies the canonical document URL for ${address}`}
        onClick={() => void copyText(shareUrl(address, window.location.origin), "URL copied to clipboard")}
      >
        Copy link
      </button>
    </span>
  );
}

/**
 * Reserve the identity row above the title before metadata arrives,
 * preventing navigation jumps. Selected tags scroll within one fixed-height
 * control; document actions stay at the end.
 */
export function DocMetaLine({
  connection,
  catalogConnection = null,
  segment,
  copyPath,
  meta,
  archived,
  readOnly = false,
  contentReadOnly = false,
  pinned = false,
  onTogglePin = null,
  onArchive = null,
  onArchiveConfirmationFocusChange,
  hasTldr = false,
  onEditTldr,
  onRemoveTldr,
}: {
  connection: RoomConnection;
  /** The workspace settings room that owns the curated tag catalog. */
  catalogConnection?: RoomConnection | null;
  /** The workspace as the address spells it — what a copied link carries. */
  segment: string;
  copyPath?: string | undefined;
  meta: DocMeta | null;
  /** Whether the directory tombstones this document: no writes from here. */
  archived: boolean;
  /** Whether the document room currently refuses writes. */
  readOnly?: boolean;
  /** Decided content stays immutable without withholding tags or placement. */
  contentReadOnly?: boolean;
  pinned?: boolean;
  onTogglePin?: (() => void) | null;
  /** Null means this replica cannot establish a current live directory stub. */
  onArchive?: (() => void) | null;
  /** Whether focus is inside the confirmation a remote archive may remove. */
  onArchiveConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  /** Whether the document-actions entry adds or edits the person-facing summary. */
  hasTldr?: boolean;
  onEditTldr?: (() => void) | undefined;
  onRemoveTldr?: (() => void) | undefined;
}): ReactElement {
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
          <DocumentActions
            key={`${connection.room}/${archived}`}
            title={titleOf(meta)}
            uuid={meta.uuid}
            address={copyAddress(connection.room, segment, copyPath)}
            archived={archived}
            pinned={pinned}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onConfirmationFocusChange={onArchiveConfirmationFocusChange}
            hasTldr={hasTldr}
            tldrOptOut={meta.tldrOptOut === true}
            contentReadOnly={contentReadOnly || meta.kind === "decision"}
            onEditTldr={readOnly ? null : (onEditTldr ?? null)}
            onRemoveTldr={readOnly ? null : (onRemoveTldr ?? null)}
          />
        </>
      )}
    </p>
  );
}

/**
 * Use one Archive refusal in the menu and open confirmation. Readiness can
 * disappear before confirmation; refusing in place must preserve the dialog
 * and explain why nothing was written.
 */
const ARCHIVE_UNAVAILABLE =
  "Archive unavailable — the directory or sidebar room is not ready to write, or there is no live entry for this document";

function DocumentActions({
  title,
  uuid,
  address,
  archived,
  pinned,
  onTogglePin,
  onArchive,
  onConfirmationFocusChange,
  hasTldr,
  tldrOptOut,
  contentReadOnly,
  onEditTldr,
  onRemoveTldr,
}: {
  title: string;
  uuid: string;
  address: string;
  archived: boolean;
  pinned: boolean;
  onTogglePin: (() => void) | null;
  onArchive: (() => void) | null;
  onConfirmationFocusChange?: ((focused: boolean) => void) | undefined;
  hasTldr: boolean;
  tldrOptOut: boolean;
  contentReadOnly: boolean;
  onEditTldr: (() => void) | null;
  onRemoveTldr: (() => void) | null;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const openingTldrEditor = useRef(false);
  const pendingCopy = useRef<(() => void) | null>(null);

  const copyFromMenu = (text: string, message: string): void => {
    const closed = new Promise<void>((resolve) => { pendingCopy.current = resolve; });
    void copyText(text, message, closed);
  };

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
                className="ub-actions-trigger size-11 cursor-pointer rounded-(--radius-sm) border border-transparent bg-transparent font-[inherit] [font-style:inherit] [font-weight:inherit] ub-type-h2 text-(--muted-foreground) hover:border-(--border) hover:bg-(--secondary) hover:text-(--foreground) data-[state=open]:border-(--border) data-[state=open]:bg-(--secondary) data-[state=open]:text-(--foreground) focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
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
              // The plain-HTTP selection fallback needs focus after the menu's
              // modal focus trap has released it.
              pendingCopy.current?.();
              pendingCopy.current = null;
              if (!openingTldrEditor.current) return;
              openingTldrEditor.current = false;
              // The selected action reveals a textarea outside this portal.
              // Let that field keep the focus its mount effect gives it.
              event.preventDefault();
            }}
          >
            <DropdownMenuItem
              onSelect={() => copyFromMenu(shareUrl(address, window.location.origin), "URL copied to clipboard")}
            >
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => copyFromMenu(uuid, "Document id copied to clipboard")}
            >
              Copy document id
            </DropdownMenuItem>
            {!archived && (
              <>
                <DropdownMenuSeparator />
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
                {!contentReadOnly && (
                  <>
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
                    {!tldrOptOut && (
                      <DropdownMenuItem
                        disabled={onRemoveTldr === null}
                        onSelect={() => onRemoveTldr?.()}
                      >
                        {onRemoveTldr === null
                          ? "Remove TL;DR unavailable — document is read-only"
                          : "Remove TL;DR"}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
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
              </>
            )}
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
                // Lost readiness refuses Archive in place; keep the reason
                // and Cancel visible instead of closing as though the archive
                // succeeded.
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

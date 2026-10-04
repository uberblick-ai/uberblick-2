/**
 * The sidebar: the `_sidebar` document, rendered (#115).
 *
 * Curation, not a listing. The groups and their order, and the pinned uuids and
 * their order, are read out of the sidebar doc with `readSidebar` and rendered
 * exactly as stored — nothing here sorts, and nothing here derives a group from
 * a tag. Titles come from the directory stubs, which is the only thing the
 * directory is asked for: the sidebar stores uuids and nothing else.
 *
 * Every gesture writes through the schema module (`packages/schema/src/sidebar.ts`),
 * so a human dragging a document and an agent calling `pin_doc` are one
 * operation with two front doors — and the re-render is an observer over the
 * same Y.Doc, so either writer's change is live in every client.
 *
 * dnd-kit owns pointer/touch/keyboard gestures, sorting feedback and focus.
 * Rows keep their navigation and disclosure clicks alongside dragging. Shared
 * order changes cancel a drag; only a successful drop commits through the schema.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode, Ref, RefObject } from "react";
import type * as Y from "yjs";
import {
  createGroup,
  deleteGroup,
  pinDoc,
  readSidebar,
  renameGroup,
  unpinDoc,
} from "@uberblick/schema";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import type { AwarenessUser } from "../collab/identity.js";
import type { RoomConnection } from "../collab/rooms.js";
import { useDirectory, useRoomStatus, useStoredFlag } from "./hooks.js";
import { rawSyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
import { useSortable } from "@dnd-kit/react/sortable";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { useDroppable } from "@dnd-kit/react";
import { SidebarDragProvider, sidebarRowSensors, useSidebarDragInstructions, useSidebarRowClickGuard } from "./sidebar-drag.js";
import { Sidebar as SidebarFrame, SidebarHeader, SidebarContent as SidebarScrollContent, SidebarFooter, SIDEBAR_TOGGLE_CLASSES, useSidebar } from "./shadcn/sidebar.js";
import { Input } from "./shadcn/input.js";
import { UserMenu } from "./UserMenu.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { workspaceLabel } from "./workspace-names.js";
import type { SettingsPage, Workspace } from "./route.js";

/** The group a pin lands in when the sidebar has none yet. */
const FIRST_GROUP_NAME = "Pinned";

/** What `+ group` creates, before the reader types over it. */
const NEW_GROUP_NAME = "New group";

// Both modes share a grid cell; only each mode's middle content scrolls.
const SIDEBAR_PANE_CLASSES = "ub-sidebar-pane [grid-area:1/1] min-w-0 min-h-0 flex flex-col transition-[transform,opacity] duration-[180ms] ease-[ease] motion-reduce:transition-none motion-reduce:duration-0 [&[inert]]:pointer-events-none [&[inert]_*]:pointer-events-none";

/** Per-group collapse preference, persisted per browser like the sidebar's own. */
function groupCollapsedKey(groupId: string): string {
  return `uberblick.sidebar.group.${groupId}.collapsed`;
}

/**
 * Pin the document, or unpin it — the one-button path the doc chrome offers.
 *
 * The sidebar is re-read here rather than taken from the caller's props: a
 * remote pin that landed between paint and click is already in the document,
 * and deciding from a stale reading would pin a document twice or unpin one
 * that is not there.
 *
 * A pin with no group to go in creates one. Which group a *deliberate* choice
 * of group belongs to is the drag, so the button does not ask: it puts the
 * document at the end of the first group, where the reader can see it and move
 * it. That is the least chrome that still has a keyboard path.
 */
export function togglePin(sidebarDoc: Y.Doc, uuid: string): void {
  const groups = readSidebar(sidebarDoc);
  if (groups.some((group) => group.docs.includes(uuid))) {
    unpinDoc(sidebarDoc, uuid);
    return;
  }
  const target = groups[0]?.id ?? createGroup(sidebarDoc, FIRST_GROUP_NAME);
  pinDoc(sidebarDoc, target, uuid);
}

type SidebarProps = {
  /** Keep the shell mounted for movement while retiring its interactions. */
  collapsed?: boolean;
  /** The pane-boundary control that hides this sidebar. */
  collapseButtonRef?: Ref<HTMLButtonElement>;
  collapseLabel: string;
  onCollapse: () => void;
  /** The directory room: its sync state, and whether a document can be created. */
  connection: RoomConnection | null;
  /** The sidebar room — where every gesture here writes. Null: read-only. */
  sidebar: RoomConnection | null;
  /** The sidebar as `readSidebar` reports it, live. */
  groups: SidebarGroup[];
  /** The workspaces the switcher offers — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  workspace: Workspace | null;
  workspaceNames?: ReadonlyMap<string, string | null>;
  onWorkspaceMenuOpenChange?: (open: boolean) => void;
  /** Go to a workspace. Switching is navigating; see `WorkspaceSwitcher`. */
  onSwitchWorkspace: (segment: string) => void;
  /** This tab's awareness identity — what the user card is about. */
  identity: AwarenessUser;
  /** Agent sessions in the workspace, for the user menu's readout. */
  agentSessions: number;
  selected: string | null;
  onSelect: (uuid: string) => void;
  onCreate: () => void;
  /** Go to the "All docs" listing (#118) — the live row in Navigation. */
  onOpenAll: () => void;
  /** Enter workspace settings. Like every selection, this is navigation. */
  onOpenSettings: (page: SettingsPage) => void;
  /** Leave settings for the workspace's fixed list address. */
  onBackToWorkspace: () => void;
  /** Whether that listing is what the address currently names. */
  allOpen: boolean;
  /** Whether the address names workspace settings. */
  settingsOpen: boolean;
  /** The selected settings destination, when settings is open. */
  settingsPage: SettingsPage | null;
};

export function Sidebar(props: SidebarProps): ReactElement {
  const sidebarRoot = useRef<HTMLElement | null>(null);
  const dragging = useRef(false);
  const onDraggingChange = useCallback((active: boolean) => {
    dragging.current = active;
  }, []);
  const { narrow } = useSidebar();
  return (
    <SidebarFrame
      ref={sidebarRoot}
      className="ub-list group/sidebar overflow-clip [overflow-clip-margin:1.25rem]"
      aria-label="Sidebar"
      data-mode={props.settingsOpen ? "settings" : "documents"}
      onEscapeKeyDown={(event) => {
        // Radix sees Escape in capture, before the field and dnd-kit. Let those
        // existing handlers cancel their operation without dismissing the sheet.
        if (
          dragging.current ||
          (event.target instanceof Element && event.target.closest(".ub-group-rename") !== null)
        ) event.preventDefault();
      }}
    >
      <SidebarContent
        {...props}
        drawer={narrow}
        sidebarRoot={sidebarRoot}
        onDraggingChange={onDraggingChange}
      />
    </SidebarFrame>
  );
}

// Radix unmounts this body on drawer closure, retiring menus, drafts and drags.
function SidebarContent({
  drawer,
  sidebarRoot,
  onDraggingChange,
  collapsed = false,
  collapseButtonRef,
  collapseLabel,
  onCollapse,
  connection,
  sidebar,
  groups,
  workspaces,
  workspace,
  workspaceNames,
  onWorkspaceMenuOpenChange,
  onSwitchWorkspace,
  identity,
  agentSessions,
  selected,
  onSelect,
  onCreate,
  onOpenAll,
  onOpenSettings,
  onBackToWorkspace,
  allOpen,
  settingsOpen,
  settingsPage,
}: SidebarProps & {
  drawer: boolean;
  sidebarRoot: RefObject<HTMLElement | null>;
  onDraggingChange: (active: boolean) => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const sidebarStatus = useRoomStatus(sidebar);
  const reading = statusReading(status, rawSyncState(status));
  const sidebarWritable = sidebar !== null && sidebarStatus.writable;
  const ydoc = sidebarWritable ? sidebar.ydoc : null;
  const canWriteSidebar = (): boolean => sidebar?.status.writable === true;
  /**
   * The group whose name is being edited, and whether it exists only because
   * that field was opened — `+ group` makes the group first, so cancelling has
   * something to take back.
   */
  const [renaming, setRenaming] = useState<{ id: string; fresh: boolean } | null>(null);
  /**
   * The directory stub behind each pinned uuid — tombstones included, which is
   * why this reader includes stubs that ordinary document listings omit.
   *
   * The sidebar is the one reader that names documents by uuid instead of
   * listing them, so it is the one reader that still has something to draw
   * after a document leaves the listings. Read without the tombstones, an
   * archived pin has no title and falls back to eight characters of uuid
   * (#287); with the stub in hand the row says what it is.
   */
  const stubs = useDirectory(connection, true);
  const labels = useMemo(
    () => new Map(stubs.map((entry) => [entry.uuid, entry])),
    [stubs],
  );
  const shownMode = useRef(settingsOpen);
  useEffect(() => {
    if (shownMode.current === settingsOpen) return;
    shownMode.current = settingsOpen;
    sidebarRoot.current
      ?.querySelector<HTMLElement>(
        ".ub-sidebar-pane:not([inert]) [data-swap-focus]",
      )
      ?.focus();
  }, [settingsOpen, sidebarRoot]);

  const addGroup = (): void => {
    if (ydoc === null || !canWriteSidebar()) return;
    // Straight into its rename field: a group is named by the person making it,
    // and "New group" is a placeholder, not a decision.
    setRenaming({ id: createGroup(ydoc, NEW_GROUP_NAME), fresh: true });
  };

  const commitRename = (groupId: string, name: string): void => {
    setRenaming(null);
    // An empty name is a slip, not a rename: the group keeps the one it has.
    if (ydoc !== null && canWriteSidebar() && name.trim() !== "") {
      renameGroup(ydoc, groupId, name.trim());
    }
  };

  /**
   * Escape out of the name field. A group that exists only because the field
   * was opened goes with it: cancelling means "never mind", and leaving "New
   * group" behind would be the field making a decision the reader declined.
   */
  const cancelRename = (): void => {
    const open = renaming;
    setRenaming(null);
    if (ydoc !== null && canWriteSidebar() && open?.fresh === true) {
      deleteGroup(ydoc, open.id);
    }
  };

  useEffect(() => {
    if (sidebarWritable) return;
    setRenaming(null);
  }, [sidebarWritable]);

  return (
    <>
      <button
        ref={collapseButtonRef}
        type="button"
        className={`${SIDEBAR_TOGGLE_CLASSES} ub-sidebar-toggle ub-sidebar-hide top-2 border-transparent bg-(--sidebar-accent) text-sidebar-foreground ${drawer ? "right-2" : "-right-4"}`}
        aria-expanded="true"
        aria-label={collapseLabel}
        title={collapseLabel}
        onClick={onCollapse}
      >
        {drawer ? "×" : "«"}
      </button>
      <SidebarDragProvider
        connection={sidebar}
        onDraggingChange={onDraggingChange}
        active={!collapsed && !settingsOpen && sidebarWritable}
      >
      <div className={`ub-sidebar-stack grid min-w-0 min-h-0 flex-1 ${drawer ? "pt-10" : ""}`}>
        <nav
          className={`${SIDEBAR_PANE_CLASSES} ub-document-sidebar [transform:translateX(0)] opacity-100 group-data-[mode=settings]/sidebar:[transform:translateX(-25%)] group-data-[mode=settings]/sidebar:opacity-0`}
          aria-label="Documents"
          aria-hidden={settingsOpen || collapsed}
          inert={settingsOpen || collapsed}
        >
          <SidebarHeader className={drawer ? undefined : "pr-6"}>
            <WorkspaceSwitcher
              workspaces={workspaces}
              current={workspace}
              names={workspaceNames}
              onOpenChange={onWorkspaceMenuOpenChange}
              onSwitch={onSwitchWorkspace}
              active={!settingsOpen && !collapsed}
            />
          </SidebarHeader>
          <SidebarScrollContent className="px-2 pb-2 [&>*]:shrink-0">
            <div className="ub-list-head">
              <button
                type="button"
                onClick={onCreate}
                disabled={!status.writable}
                title={
                  status.writable
                    ? undefined
                    : "New document unavailable while the directory is read-only"
                }
              >
                {status.writable ? "+ new doc" : "new doc unavailable"}
              </button>
              {/* A refusal takes this line's word, because the three readings below
                  all describe a connection that is working or coming back and none of
                  them is true of a page the hub will not admit (#448). The ordinary
                  readings stay exactly as they were — uncalmed, and saying
                  "directory", since this line is about the directory room. */}
              <span className="ub-muted">
                {reading.detail !== null
                  ? reading.word
                  : status.connected
                    ? status.synced
                      ? "directory synced"
                      : "syncing…"
                    : "offline"}
              </span>
            </div>
            <Navigation allOpen={allOpen} onOpenAll={onOpenAll} />
            {!sidebarWritable && (
              <p className="ub-muted ub-sidebar-unwritable">
                Sidebar changes unavailable while offline.
              </p>
            )}
            {groups.length === 0 && (
              <p className="ub-muted ub-empty">
                Nothing pinned yet. Pin the open document from its Document actions
                menu.
              </p>
            )}
            {groups.map((group, index) => (
                <GroupSection
                  key={group.id}
                  index={index}
                  group={group}
                  ydoc={ydoc}
                  labels={labels}
                  selected={selected}
                  onSelect={onSelect}
                  canWrite={canWriteSidebar}
                  editing={renaming?.id === group.id}
                  onEdit={() => setRenaming({ id: group.id, fresh: false })}
                  onCancel={cancelRename}
                  onCommit={(name) => commitRename(group.id, name)}
                />
            ))}
            <button
              type="button"
              className="ub-group-add"
              onClick={addGroup}
              disabled={ydoc === null}
              title={
                ydoc === null
                  ? "Group changes unavailable while the sidebar is offline"
                  : undefined
              }
            >
              + group
            </button>
          </SidebarScrollContent>
          <SidebarFooter className="border-t border-sidebar-border">
            {workspace !== null && (
              <button
                type="button"
                className="ub-settings-entry"
                data-swap-focus
                onClick={() => onOpenSettings("general")}
              >
                <GearIcon />
                Workspace settings
              </button>
            )}
            {!settingsOpen && !collapsed && (
              <UserMenu identity={identity} agentSessions={agentSessions} />
            )}
          </SidebarFooter>
        </nav>
        <SettingsNavigation
          drawer={drawer}
          workspaceLabel={workspace === null ? "workspace" : workspaceLabel(workspace, workspaceNames ?? new Map(), workspaces)}
          identity={identity}
          agentSessions={agentSessions}
          active={settingsOpen && !collapsed}
          page={settingsPage}
          onSelect={onOpenSettings}
          onBack={onBackToWorkspace}
        />
      </div>
      </SidebarDragProvider>
    </>
  );
}

/** The navigation pane that replaces the document sidebar in settings mode. */
function SettingsNavigation({
  drawer,
  workspaceLabel: label,
  identity,
  agentSessions,
  active,
  page,
  onSelect,
  onBack,
}: {
  drawer: boolean;
  workspaceLabel: string;
  identity: AwarenessUser;
  agentSessions: number;
  active: boolean;
  page: SettingsPage | null;
  onSelect: (page: SettingsPage) => void;
  onBack: () => void;
}): ReactElement {
  return (
    <nav
      className={`${SIDEBAR_PANE_CLASSES} ub-settings-sidebar z-1 [transform:translateX(100%)] opacity-0 group-data-[mode=settings]/sidebar:[transform:translateX(0)] group-data-[mode=settings]/sidebar:opacity-100`}
      aria-label="Workspace settings"
      aria-hidden={!active}
      inert={!active}
    >
      <SidebarHeader className={drawer ? undefined : "pr-6"}>
        <button
          type="button"
          className="ub-settings-back flex min-h-8.5 pointer-coarse:min-h-11 w-full items-center gap-2 rounded-[0.42rem] border border-transparent bg-transparent px-2 py-1.5 text-left text-sm font-[inherit] text-(--sidebar-row-foreground) cursor-pointer hover:bg-(--sidebar-accent) hover:text-sidebar-foreground"
          data-swap-focus
          onClick={onBack}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-(--radius-sm) bg-(--brand-subtle) text-(--brand) [&_svg]:size-4" aria-hidden="true">
            <BackIcon />
          </span>
          <span className="min-w-0 truncate">
            Back to {label}
          </span>
        </button>
      </SidebarHeader>
      <SidebarScrollContent className="px-2 pb-2 [&>*]:shrink-0">
        <section className="ub-nav ub-settings-nav">
          <p className="ub-nav-label">Workspace settings</p>
          <ul>
            <li>
              <button
                type="button"
                aria-current={page === "general" ? "page" : undefined}
                onClick={() => onSelect("general")}
              >
                <GearIcon />
                General
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-current={page === "tags" ? "page" : undefined}
                onClick={() => onSelect("tags")}
              >
                <TagIcon />
                Tags
              </button>
            </li>
          </ul>
        </section>
      </SidebarScrollContent>
      <SidebarFooter className="border-t border-sidebar-border">
        {active && <UserMenu identity={identity} agentSessions={agentSessions} />}
      </SidebarFooter>
    </nav>
  );
}

/**
 * The sidebar's fixed navigation (#483): the destination the app has, and the
 * two it is going to have.
 *
 * Chrome rather than curation — not a group, not draggable, not a drop target,
 * nothing of it in `_sidebar` — so it is drawn above the groups whether
 * anything is pinned or not, and above the "nothing pinned yet" line too.
 *
 * The two placeholders are shown before their destinations exist (owner
 * decision, 2026-08-29), because both are recorded product intent rather than
 * invented labels: the dashboard in *Product Overview* and *My daily
 * workflows*, requirement documents in #438. They are unavailable rather than
 * hidden, in the workspace menu's own words (#480) — `aria-disabled` and no
 * handler, so a screen reader is told what the muted ink and the missing hover
 * ground tell a pointer. Focusable on purpose: `disabled` would drop them out
 * of the tab order, and a reader who never meets a row never learns the
 * destination is coming.
 */
function Navigation({
  allOpen,
  onOpenAll,
}: {
  allOpen: boolean;
  onOpenAll: () => void;
}): ReactElement {
  return (
    <section className="ub-nav">
      <p className="ub-nav-label">Navigation</p>
      <ul>
        <li>
          <button
            type="button"
            className="ub-all-open-entry"
            aria-current={allOpen ? "page" : undefined}
            onClick={onOpenAll}
          >
            <GridIcon />
            All docs
          </button>
        </li>
        <Soon icon={<DashboardIcon />}>Dashboard</Soon>
        <Soon icon={<ChecklistIcon />}>Product requirements</Soon>
      </ul>
    </section>
  );
}

/** A navigation row for a destination the product has decided on and not built. */
function Soon({
  icon,
  children,
}: {
  icon: ReactNode;
  children: string;
}): ReactElement {
  return (
    <li>
      <button
        type="button"
        className="ub-nav-soon flex min-h-8.5 w-full cursor-default items-center gap-2 rounded-[0.42rem] border border-transparent bg-transparent px-2 py-1.5 text-left font-[inherit] text-sm text-(--sidebar-muted-foreground)"
        aria-disabled="true"
      >
        {icon}
        <span>
          {children}{" "}
          <span className="block text-[11px]">Coming soon</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The three navigation glyphs. Drawn here rather than pulled from an icon set,
 * for the reason `Chevron` and `DocumentIcon` are (#110): three 16px marks are
 * not worth a dependency, and `currentColor` is what lets a muted row mute its
 * own glyph.
 */
function GridIcon(): ReactElement {
  return (
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3h4v4H3z M9 3h4v4H9z M3 9h4v4H3z M9 9h4v4H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DashboardIcon(): ReactElement {
  return (
    <svg className="block size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 13.5h11 M5 13.5V8 M8 13.5V3.5 M11 13.5V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChecklistIcon(): ReactElement {
  return (
    <svg className="block size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 4.8 L4 6.3 L6.5 3.3 M8.5 5h5 M2.5 10.8 L4 12.3 L6.5 9.3 M8.5 11h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The settings mark, drawn locally like the rest of the sidebar glyphs. */
function GearIcon(): ReactElement {
  return (
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.8 2.2h2.4l.4 1.6 1.4.8 1.6-.5 1.2 2.1-1.2 1.1v1.5l1.2 1.1-1.2 2.1-1.6-.5-1.4.8-.4 1.6H6.8l-.4-1.6-1.4-.8-1.6.5-1.2-2.1 1.2-1.1V7.3L2.2 6.2l1.2-2.1 1.6.5 1.4-.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.7" fill="none" stroke="currentColor" />
    </svg>
  );
}

/** The catalog mark, drawn locally like the rest of the sidebar glyphs. */
function TagIcon(): ReactElement {
  return (
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 2.5 4.8 13.5 M11.2 2.5 10 13.5 M2.8 6h10.7 M2.2 10h10.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BackIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.5 3.5 6 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The group header's disclosure mark: one shape, rotated.
 *
 * Drawn rather than typed. The bug this fixes (#110) was that the two glyphs
 * `›` and `⌄` sit at different heights in their em boxes, so the mark neither
 * lined up with the label nor stayed put when the group toggled — swapping one
 * badly-centred glyph for another badly-centred glyph is the failure mode, not
 * the fix. A path on a square viewBox is centred by construction and rotates
 * about its own middle, which leaves CSS one job: `transform`.
 */
function Chevron(): ReactElement {
  return (
    <svg className="ub-group-caret" viewBox="0 0 8 8" aria-hidden="true">
      <path
        d="M3 1.6 L5.4 4 L3 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The leading mark on a pinned row: a page with a folded corner.
 *
 * Drawn, not typed, for the reason `Chevron` is (#110) — and drawn here rather
 * than pulled from an icon set, because one 16px glyph is not worth a
 * dependency. `currentColor` is what lets the row's own tint reach it.
 */
function DocumentIcon(): ReactElement {
  return (
    <svg className="ub-doc-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9 2H4.5v12h7V4.5z M9 2v2.5h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One group: its header, and the documents pinned into it.
 *
 * A component rather than inline markup so each group owns its own
 * `useStoredFlag` — the hook count stays fixed however many groups the sidebar
 * holds.
 */
function GroupSection({
  index,
  group,
  ydoc,
  labels,
  selected,
  onSelect,
  canWrite,
  editing,
  onEdit,
  onCancel,
  onCommit,
}: {
  group: SidebarGroup;
  index: number;
  /** The sidebar's Y.Doc, or null when there is no sidebar room to write to. */
  ydoc: Y.Doc | null;
  /** What each pinned uuid is called, and whether it is archived. */
  labels: ReadonlyMap<string, DirectoryEntry>;
  selected: string | null;
  onSelect: (uuid: string) => void;
  /** Recheck the live room at the write boundary, not only at render time. */
  canWrite: () => boolean;
  /** Whether this group's name is the one being edited — one field at a time. */
  editing: boolean;
  onEdit: () => void;
  /** Escape: the name stands, and a group the field itself made goes away. */
  onCancel: () => void;
  onCommit: (name: string) => void;
}): ReactElement {
  const sortable = useSortable({
    id: `group:${group.id}`,
    index,
    group: "groups",
    type: "group",
    accept: "group",
    plugins: [SortableKeyboardPlugin],
    sensors: sidebarRowSensors,
    disabled: ydoc === null || editing,
    data: { kind: "group", id: group.id, label: `group ${group.name}` },
  });
  const instructions = useSidebarDragInstructions();
  const rowClickGuard = useSidebarRowClickGuard();
  const [collapsed, setCollapsed] = useStoredFlag(groupCollapsedKey(group.id), false);
  const append = useDroppable({
    id: `append:${group.id}`,
    // Pointer drops on any header append. Keyboard navigation uses the visible
    // rows, otherwise ArrowUp from row one would wrap to its own group's end.
    accept: (source) => source.type === "doc" && (
      source.manager?.dragOperation.activatorEvent?.type !== "keydown" || collapsed || group.docs.length === 0
    ),
    disabled: ydoc === null,
    data: { kind: "append", group: group.id, label: `end of ${group.name}` },
  });
  /**
   * Focus and select the name, once — when the field appears.
   *
   * The identity is stable, which is the whole point: React calls a callback
   * ref again whenever the callback itself changes, so an inline arrow would
   * re-run on every render of this group. A sidebar that re-renders while
   * somebody is typing — an agent pinning, a peer dragging, anything at all —
   * would then reselect the draft under the caret, and the next keystroke would
   * replace what they had typed.
   */
  const openField = useCallback((element: HTMLInputElement | null) => {
    element?.focus();
    element?.select();
  }, []);

  return (
    <section className="ub-group" ref={sortable.ref}>
      <div className="ub-group-head data-[drop-target=true]:bg-(--sidebar-accent)" ref={append.ref} data-drop-target={append.isDropTarget}>
        {editing ? (
          <form
            className="mx-[0.4rem] my-1 flex-1 min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              // Native Enter submission uses the same commit path as leaving.
              event.currentTarget.querySelector<HTMLInputElement>("input")?.blur();
            }}
          >
            <Input
              className="ub-group-rename font-medium tracking-[0.12em] uppercase [--input:var(--sidebar-input)] [--background:var(--sidebar)]"
              defaultValue={group.name}
              aria-label="Group name"
              // Focused *and* selected: the field is opened to replace the name
              // far more often than to edit it, and `select()` alone leaves the
              // caret somewhere the keyboard is not.
              ref={openField}
              onBlur={(event) => onCommit(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                }
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            {...rowClickGuard}
            className="ub-group-toggle flex flex-1 min-w-0 items-center gap-1 rounded-(--radius-sm) border-0 bg-transparent px-[0.4rem] py-1 text-left font-[inherit] text-[11px] font-medium tracking-[0.12em] uppercase text-(--sidebar-group-label) cursor-pointer select-none [-webkit-touch-callout:none] hover:text-sidebar-foreground"
            ref={sortable.handleRef}
            aria-describedby={ydoc === null ? undefined : instructions}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Chevron />
            <span className="ub-group-label">{group.name}</span>
            <span className="ub-group-rule" aria-hidden="true" />
          </button>
        )}
        {!editing && ydoc !== null && (
          <>
            <button
              type="button"
              className="ub-group-act"
              aria-label={`Rename group ${group.name}`}
              title="Rename group"
              onClick={onEdit}
            >
              <span aria-hidden="true">✎</span>
            </button>
            {/* Deletes the group and its pins — never the documents, which the
                sidebar only ever held the uuids of. */}
            <button
              type="button"
              className="ub-group-act"
              aria-label={`Delete group ${group.name}`}
              title="Delete group"
              onClick={() => {
                if (canWrite()) deleteGroup(ydoc, group.id);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </>
        )}
      </div>
      {/*
        Always rendered, never conditionally: the open/closed transition is a
        `grid-template-rows` animation (see styles.css), and CSS cannot animate
        an element that is not there. `inert` is what keeps that honest — a
        collapsed group is out of the tab order and out of the accessibility
        tree, exactly as it was when React removed it from the DOM.
      */}
      <div className="ub-group-body" data-collapsed={collapsed} inert={collapsed}>
        <ul>
          {group.docs.map((uuid, index) => (
            <PinnedRow key={uuid} uuid={uuid} index={index} group={group.id}
              entry={labels.get(uuid)} selected={selected} onSelect={onSelect}
              disabled={ydoc === null || collapsed} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function PinnedRow({ uuid, index, group, entry, selected, onSelect, disabled }: {
  uuid: string;
  index: number;
  group: string;
  entry: DirectoryEntry | undefined;
  selected: string | null;
  onSelect: (uuid: string) => void;
  disabled: boolean;
}): ReactElement {
  const sortable = useSortable({
    id: `doc:${uuid}`, index, group, type: "doc", accept: "doc", disabled,
    plugins: [SortableKeyboardPlugin],
    sensors: sidebarRowSensors,
    data: { kind: "doc", id: uuid, label: pinTitle(uuid, entry) },
  });
  const instructions = useSidebarDragInstructions();
  const rowClickGuard = useSidebarRowClickGuard();
  return (
    <li className="ub-pin-row flex items-center data-[drop-target=true]:bg-(--sidebar-accent)" ref={sortable.ref} data-drop-target={sortable.isDropTarget && !sortable.isDragSource}>
      <button type="button" aria-current={uuid === selected ? "page" : undefined}
        {...rowClickGuard}
        className="flex flex-1 min-w-0 w-full min-h-8.5 items-center gap-2 rounded-[0.42rem] border border-transparent bg-transparent px-2 py-1.5 text-left font-[inherit] text-sm text-(--sidebar-row-foreground) cursor-pointer select-none [-webkit-touch-callout:none] hover:bg-(--sidebar-accent) hover:text-sidebar-foreground aria-[current=page]:bg-(--sidebar-accent) aria-[current=page]:border-(--sidebar-selected-border) aria-[current=page]:text-sidebar-foreground aria-[current=page]:font-medium"
        ref={sortable.handleRef} aria-describedby={disabled ? undefined : instructions}
        onClick={() => onSelect(uuid)} title={pinTitle(uuid, entry)}>
        <DocumentIcon />
        <span className="ub-pin-label"><PinLabel uuid={uuid} entry={entry} /></span>
      </button>
    </li>
  );
}

/**
 * What a pinned row is called — the three states `get_sidebar` reports, in the
 * same words.
 *
 * A uuid the directory has never mentioned is shown as itself rather than
 * dropped: the sidebar is somebody's curation, and silently hiding an entry
 * from it would be the one thing a curated list must not do. It resolves into
 * its title when the directory arrives.
 *
 * An archived document used to be drawn as that same stub (#287), which was a
 * lie about a document the directory can describe perfectly well: the stub is
 * there, tombstoned, with the title still in it. So the row keeps the title and
 * marks it. Archiving is not unpinning — whether a pin should follow the
 * document out of the listings is #210 — and the row stays live, because
 * opening it read-only is where Restore is.
 */
function PinLabel({
  uuid,
  entry,
}: {
  uuid: string;
  entry: DirectoryEntry | undefined;
}): ReactNode {
  if (entry === undefined) return <span className="ub-muted">{uuid.slice(0, 8)}</span>;
  const title = entry.title === "" ? <em>Untitled</em> : entry.title;
  if (entry.deleted !== true) return title;
  return (
    <>
      {title}
      <span className="ub-muted">{" \u00b7 archived"}</span>
    </>
  );
}

/**
 * The same four things {@link PinLabel} draws, as the one string a `title`
 * attribute can carry.
 *
 * The row is 34px and ellipsises anything longer than the column (#481), which
 * is the right geometry but left the name unrecoverable: the tooltip offered
 * the uuid, so a clipped title could be read nowhere at all. Here the stub is
 * the whole uuid rather than the eight characters the row shows, because the
 * tooltip is the place the rest of it is recoverable from.
 */
function pinTitle(uuid: string, entry: DirectoryEntry | undefined): string {
  if (entry === undefined) return uuid;
  const title = entry.title === "" ? "Untitled" : entry.title;
  return entry.deleted === true ? `${title} \u00b7 archived` : title;
}

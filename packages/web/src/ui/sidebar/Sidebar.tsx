/**
 * Render curated groups and pinned UUIDs in stored order, without sorting or
 * tag-derived groups. Resolve titles from directory stubs. Schema writes and
 * observers share one Y.Doc; dnd-kit owns gestures and feedback, shared order
 * changes cancel dragging, and only a successful drop commits.
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
import type { AwarenessUser } from "../../collab/identity.js";
import type { AccountIdentity } from "../../shell/account.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { useDirectory, useRoomStatus, useStoredFlag } from "../hooks.js";
import { rawSyncState } from "../status/calm.js";
import { statusReading } from "../status/status-reading.js";
import { useSortable } from "@dnd-kit/react/sortable";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { useDroppable } from "@dnd-kit/react";
import { SidebarDragProvider, sidebarRowSensors, useSidebarDragInstructions, useSidebarRowClickGuard } from "./sidebar-drag.js";
import { Sidebar as SidebarFrame, SidebarHeader, SidebarContent as SidebarScrollContent, SidebarFooter, SIDEBAR_TOGGLE_CLASSES, useSidebar } from "../shadcn/sidebar.js";
import { Input } from "../shadcn/input.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "../shadcn/alert-dialog.js";
import { UserMenu } from "./UserMenu.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { workspaceLabel } from "../workspace-names.js";
import type { SettingsPage, Workspace } from "../route.js";

/** The group a pin lands in when the sidebar has none yet. */
const FIRST_GROUP_NAME = "Pinned";

/** What `+ group` creates, before the reader types over it. */
const NEW_GROUP_NAME = "New group";

const GROUP_ACTION_CLASSES = "ub-group-act flex-none min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 border-0 bg-transparent cursor-pointer rounded-(--radius-sm) px-[0.3rem] py-[0.15rem] font-[inherit] text-[0.75rem]/[inherit] [font-weight:inherit] [font-style:inherit] text-(--sidebar-muted-foreground) opacity-0 [@media(hover:none)]:opacity-100 [@media(hover:hover)]:[.ub-group-head:hover_&]:opacity-100 [.ub-group-head:focus-within_&]:opacity-100 hover:text-foreground hover:bg-sidebar-accent transition-opacity duration-[120ms] ease-[ease] motion-reduce:transition-none";

// Both modes share a grid cell; only each mode's middle content scrolls.
const SIDEBAR_PANE_CLASSES = "ub-sidebar-pane [grid-area:1/1] min-w-0 min-h-0 flex flex-col transition-[transform,opacity] duration-[180ms] ease-[ease] motion-reduce:transition-none motion-reduce:duration-0 [&[inert]]:pointer-events-none [&[inert]_*]:pointer-events-none";

// Native buttons have no preflight reset. Keep their inherited type and focus
// ring while Tailwind gates hover by the primary input's capability.
const SIDEBAR_ROW_CLASSES = "flex min-h-8.5 [@media(any-pointer:coarse)]:min-h-11 items-center gap-2 rounded-[0.42rem] border border-solid border-transparent bg-transparent px-2 py-1.5 text-left text-sm/[inherit] font-[inherit] text-(--sidebar-row-foreground) cursor-pointer enabled:not-aria-disabled:hover:bg-(--sidebar-accent) enabled:not-aria-disabled:hover:text-sidebar-foreground";
const SIDEBAR_NAV_CLASSES = `${SIDEBAR_ROW_CLASSES} w-full aria-[current=page]:bg-(--sidebar-accent) aria-[current=page]:border-(--sidebar-selected-border) aria-[current=page]:text-sidebar-foreground aria-[current=page]:font-medium`;

/** Per-group collapse preference, persisted per browser like the sidebar's own. */
function groupCollapsedKey(groupId: string): string {
  return `uberblick.sidebar.group.${groupId}.collapsed`;
}

/**
 * Re-read the sidebar at click time so remote pins are honored. Append a new
 * pin to the first group, creating it if needed; deliberate group and
 * position changes belong to dragging.
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
  /** This tab's awareness identity, separate from its served hub account. */
  identity: AwarenessUser;
  account?: AccountIdentity;
  /** Agent sessions in the workspace, for the user menu's readout. */
  agentSessions: number;
  selected: string | null;
  onSelect: (uuid: string) => void;
  onCreate: () => void;
  /** Navigate to the All docs listing. */
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
  hubAdmin?: boolean;
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
  account,
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
  hubAdmin = false,
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
   * Remember whether opening the rename field created its group, so
   * cancellation can remove it.
   */
  const [renaming, setRenaming] = useState<{ id: string; fresh: boolean } | null>(null);
  /**
   * Include tombstoned directory stubs: pinned UUIDs still need their
   * archived titles after leaving ordinary listings.
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
        settingsOpen ? ".ub-settings-back" : ".ub-settings-entry",
      )
      ?.focus();
  }, [settingsOpen, sidebarRoot]);

  const addGroup = (): void => {
    if (ydoc === null || !canWriteSidebar()) return;
    // Open the rename field immediately; New group is only a placeholder.
    setRenaming({ id: createGroup(ydoc, NEW_GROUP_NAME), fresh: true });
  };

  const commitRename = (groupId: string, name: string): void => {
    setRenaming(null);
    // An empty rename keeps the existing name.
    if (ydoc !== null && canWriteSidebar() && name.trim() !== "") {
      renameGroup(ydoc, groupId, name.trim());
    }
  };

  /**
   * Escape preserves an existing name and removes a group created only for
   * this cancelled field.
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
                className={`${SIDEBAR_ROW_CLASSES} disabled:text-(--sidebar-muted-foreground) disabled:cursor-default`}
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
              {/*
                  * Refusals take precedence over ordinary directory readings, which describe
                  * working or reconnecting rooms. Keep directory readings uncalmed.
               */}
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
                  onDeleteCloseFocus={() => {
                    const root = sidebarRoot.current;
                    const target = root?.querySelector<HTMLButtonElement>(".ub-group-add:not(:disabled)")
                      ?? root?.querySelector<HTMLButtonElement>(".ub-document-sidebar .ub-nav button");
                    target?.focus();
                  }}
                  editing={renaming?.id === group.id}
                  onEdit={() => setRenaming({ id: group.id, fresh: false })}
                  onCancel={cancelRename}
                  onCommit={(name) => commitRename(group.id, name)}
                />
            ))}
            <button
              type="button"
              className={`ub-group-add ${SIDEBAR_ROW_CLASSES} self-start mt-[0.35rem] disabled:opacity-50 disabled:cursor-default`}
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
        </nav>
        <SettingsNavigation
          drawer={drawer}
          workspaceLabel={workspace === null ? "workspace" : workspaceLabel(workspace, workspaceNames ?? new Map(), workspaces)}
          active={settingsOpen && !collapsed}
          page={settingsPage}
          hubAdmin={hubAdmin}
          onSelect={onOpenSettings}
          onBack={onBackToWorkspace}
        />
      </div>
      <SidebarFooter className="border-t border-sidebar-border" aria-hidden={collapsed} inert={collapsed}>
        {workspace !== null && (
          <button
            type="button"
            className={`ub-settings-entry ${SIDEBAR_ROW_CLASSES} w-full`}
            data-swap-focus
            onClick={() => onOpenSettings("general")}
          >
            <GearIcon />
            Workspace settings
          </button>
        )}
        <UserMenu identity={identity} account={account} agentSessions={agentSessions} active={!collapsed} />
      </SidebarFooter>
      </SidebarDragProvider>
    </>
  );
}

/** The navigation pane that replaces the document sidebar in settings mode. */
function SettingsNavigation({
  drawer,
  workspaceLabel: label,
  active,
  page,
  hubAdmin,
  onSelect,
  onBack,
}: {
  drawer: boolean;
  workspaceLabel: string;
  active: boolean;
  page: SettingsPage | null;
  hubAdmin: boolean;
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
                className={SIDEBAR_NAV_CLASSES}
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
                className={SIDEBAR_NAV_CLASSES}
                aria-current={page === "tags" ? "page" : undefined}
                onClick={() => onSelect("tags")}
              >
                <TagIcon />
                Tags
              </button>
            </li>
            <li>
              <button
                type="button"
                className={SIDEBAR_NAV_CLASSES}
                aria-current={page === "access" ? "page" : undefined}
                onClick={() => onSelect("access")}
              >
                <GearIcon />
                Access
              </button>
            </li>
          </ul>
        </section>
        {hubAdmin && <section className="ub-nav ub-settings-nav" aria-label="Hub">
          <p className="ub-nav-label">Hub</p>
          <ul>
            <li><button type="button" className={SIDEBAR_NAV_CLASSES}
              aria-current={page === "hub-admins" ? "page" : undefined}
              onClick={() => onSelect("hub-admins")}><GearIcon />Admins</button></li>
            <li><button type="button" className={SIDEBAR_NAV_CLASSES}
              aria-current={page === "hub-workspaces" ? "page" : undefined}
              onClick={() => onSelect("hub-workspaces")}><GearIcon />Workspaces</button></li>
          </ul>
        </section>}
      </SidebarScrollContent>
    </nav>
  );
}

/**
 * Fixed navigation is outside sidebar curation and dragging. The current
 * unbuilt destination is a focusable aria-disabled row without a handler so
 * keyboard readers encounter their unavailable state.
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
            className={`ub-all-open-entry ${SIDEBAR_NAV_CLASSES}`}
            aria-current={allOpen ? "page" : undefined}
            onClick={onOpenAll}
          >
            <GridIcon />
            All docs
          </button>
        </li>
        <Soon icon={<DashboardIcon />}>Dashboard</Soon>
      </ul>
    </section>
  );
}

/** An unbuilt destination remains visible without accepting navigation. */
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

/** Local 16px paths use currentColor so disabled rows also mute their glyphs. */
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
 * Rotate one centered square path for disclosure; swapping text glyphs
 * changes vertical alignment.
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

/** A local page path uses currentColor to inherit the pinned row tint. */
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
 * One component per group keeps useStoredFlag hook counts independent of the
 * group count.
 */
function GroupSection({
  index,
  group,
  ydoc,
  labels,
  selected,
  onSelect,
  canWrite,
  onDeleteCloseFocus,
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
  /** The persistent sidebar control to focus when Delete's trigger is gone. */
  onDeleteCloseFocus: () => void;
  /** Whether this group's name is the one being edited — one field at a time. */
  editing: boolean;
  onEdit: () => void;
  /** Escape: the name stands, and a group the field itself made goes away. */
  onCancel: () => void;
  onCommit: (name: string) => void;
}): ReactElement {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteRefused, setDeleteRefused] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const deleteUnavailable = ydoc === null || deleteRefused;
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
   * Keep the callback ref stable: rerunning focus/select during a remote
   * sidebar render would replace the draft on the next keystroke.
   */
  const openField = useCallback((element: HTMLInputElement | null) => {
    element?.focus();
    element?.select();
  }, []);

  return (
    <AlertDialog open={confirmingDelete} onOpenChange={(open) => {
      setDeleteRefused(false);
      setConfirmingDelete(open);
    }}>
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
              // Focus before selecting so replacement typing reaches this
              // field.
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
            className="ub-group-toggle flex flex-1 min-w-0 min-h-6 [@media(any-pointer:coarse)]:min-h-11 items-center gap-1 rounded-(--radius-sm) border-0 bg-transparent px-[0.4rem] py-1 text-left font-[inherit] text-[11px] font-medium tracking-[0.12em] uppercase text-(--sidebar-group-label) cursor-pointer select-none [-webkit-touch-callout:none] hover:text-sidebar-foreground"
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
              className={GROUP_ACTION_CLASSES}
              aria-label={`Rename group ${group.name}`}
              title="Rename group"
              onClick={onEdit}
            >
              <span aria-hidden="true">✎</span>
            </button>
            <AlertDialogTrigger asChild>
              <button
                ref={deleteTrigger}
                type="button"
                className={GROUP_ACTION_CLASSES}
                aria-label={`Delete group ${group.name}`}
                title="Delete group"
              >
                <span aria-hidden="true">×</span>
              </button>
            </AlertDialogTrigger>
          </>
        )}
      </div>
      {/*
          * Keep the group mounted for grid-row animation; inert removes collapsed
          * content from Tab order and the accessibility tree.
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
      {/* Keep the confirmation while writability is lost and its trigger retires. */}
      <AlertDialogContent onCloseAutoFocus={(event) => {
        if (deleteTrigger.current?.isConnected) return;
        event.preventDefault();
        onDeleteCloseFocus();
      }}>
        <AlertDialogTitle>Delete group {group.name}?</AlertDialogTitle>
        <AlertDialogDescription>
          {deleteUnavailable
            ? "Delete unavailable — sidebar is not ready to write. Nothing has been deleted."
            : "The group and its pins will be removed. Its documents are preserved."}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleteUnavailable} onClick={(event) => {
            // The room can refuse writes between paint and confirmation.
            if (ydoc === null || !canWrite()) {
              event.preventDefault();
              setDeleteRefused(true);
              return;
            }
            deleteGroup(ydoc, group.id);
          }}>
            Delete group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
        className="flex flex-1 min-w-0 w-full min-h-8.5 [@media(any-pointer:coarse)]:min-h-11 items-center gap-2 rounded-[0.42rem] border border-transparent bg-transparent px-2 py-1.5 text-left font-[inherit] text-sm text-(--sidebar-row-foreground) cursor-pointer select-none [-webkit-touch-callout:none] hover:bg-(--sidebar-accent) hover:text-sidebar-foreground aria-[current=page]:bg-(--sidebar-accent) aria-[current=page]:border-(--sidebar-selected-border) aria-[current=page]:text-sidebar-foreground aria-[current=page]:font-medium"
        ref={sortable.handleRef} aria-describedby={disabled ? undefined : instructions}
        onClick={() => onSelect(uuid)} title={pinTitle(uuid, entry)}>
        <DocumentIcon />
        <span className="ub-pin-label"><PinLabel uuid={uuid} entry={entry} /></span>
      </button>
    </li>
  );
}

/**
 * Never hide an unresolved curated pin: show its UUID until its title
 * arrives. Archived stubs keep their title and marker, and remain navigable
 * read-only so Restore stays reachable.
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
 * The tooltip recovers clipped titles and the full UUID of an unresolved pin;
 * the visible row may truncate both.
 */
function pinTitle(uuid: string, entry: DirectoryEntry | undefined): string {
  if (entry === undefined) return uuid;
  const title = entry.title === "" ? "Untitled" : entry.title;
  return entry.deleted === true ? `${title} \u00b7 archived` : title;
}

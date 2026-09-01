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
 * ## Drag and drop
 *
 * Native HTML drag events, no dependency. The dragged item is held in React
 * state rather than in `dataTransfer` — a drag within one list never leaves the
 * page, and `dataTransfer.getData` is unreadable during `dragover`, which is
 * where the drop targets have to decide whether they want it. `setData` is
 * still called, because Firefox refuses to start a drag without it.
 *
 * Positions are explicit drop slots between the rows rather than a midpoint
 * test on the row under the pointer: an insertion point is what the reader is
 * choosing, so it is what the DOM holds. The slots only take the pointer while
 * a drag of the matching kind is in flight (see `[data-dragging]` in
 * styles.css), so they cost the ordinary pointer nothing.
 *
 * A collapsed group's body is `inert`, so it cannot receive a drop — its header
 * takes one instead, appending to the group. That is also the forgiving target
 * for a drag that lands near a header rather than in a slot.
 */

import { Fragment, useCallback, useMemo, useState } from "react";
import type { DragEvent, ReactElement, ReactNode } from "react";
import type * as Y from "yjs";
import {
  createGroup,
  deleteGroup,
  moveDoc,
  moveGroup,
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
import { UserMenu } from "./UserMenu.js";
import { SettingsIcon } from "./WorkspaceSettings.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import type { Workspace } from "./route.js";

/** The group a pin lands in when the sidebar has none yet. */
const FIRST_GROUP_NAME = "Pinned";

/** What `+ group` creates, before the reader types over it. */
const NEW_GROUP_NAME = "New group";

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

/**
 * Where an item dropped at rendered position `index` has to be inserted.
 *
 * Yjs has no move, so `moveDoc` and `moveGroup` delete and then insert — and
 * their `index` counts positions in the list the item has *already left*. Every
 * slot below the item it is being dragged from is therefore one place higher by
 * the time the insert happens. Without this, dragging a row down by one lands
 * it exactly where it started.
 */
function landingIndex(
  list: readonly string[],
  item: string,
  index: number,
): number {
  const at = list.indexOf(item);
  return at !== -1 && at < index ? index - 1 : index;
}

/** What is being dragged. Held in state, not in `dataTransfer` — see the header. */
type Drag = { kind: "doc"; uuid: string } | { kind: "group"; id: string };

/** The drag, as the rows and slots need to see it. */
interface Dnd {
  /** What kind of thing is in flight, or null when nothing is. */
  kind: Drag["kind"] | null;
  /** The slot currently under the pointer — the one that draws the line. */
  over: string | null;
  start: (drag: Drag, event: DragEvent) => void;
  end: () => void;
  enter: (slot: string) => void;
  leave: (slot: string) => void;
  /** Move the dragged document into `groupId` at a rendered position. */
  dropDoc: (groupId: string, index: number) => void;
}

export function Sidebar({
  connection,
  sidebar,
  groups,
  entries,
  workspaces,
  workspace,
  onSwitchWorkspace,
  identity,
  agentSessions,
  selected,
  onSelect,
  onCreate,
  onOpenAll,
  onOpenSettings,
  allOpen,
}: {
  /** The directory room: its sync state, and whether a document can be created. */
  connection: RoomConnection | null;
  /** The sidebar room — where every gesture here writes. Null: read-only. */
  sidebar: RoomConnection | null;
  /** The sidebar as `readSidebar` reports it, live. */
  groups: SidebarGroup[];
  /**
   * The workspace's documents, for the count the switcher prints (#74) — the
   * live ones, which is what that number means. Titles come from a second
   * reading of the same directory that keeps the tombstones; see `stubs`.
   */
  entries: DirectoryEntry[];
  /** The workspaces the switcher offers — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  workspace: Workspace | null;
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
  /** Go to workspace settings (#485) — the footer's gear row, and the menu's. */
  onOpenSettings: () => void;
  /** Whether that listing is what the address currently names. */
  allOpen: boolean;
}): ReactElement {
  const status = useRoomStatus(connection);
  const reading = statusReading(status, rawSyncState(status));
  const ydoc = sidebar?.ydoc ?? null;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /**
   * The group whose name is being edited, and whether it exists only because
   * that field was opened — `+ group` makes the group first, so cancelling has
   * something to take back.
   */
  const [renaming, setRenaming] = useState<{ id: string; fresh: boolean } | null>(null);
  /**
   * The directory stub behind each pinned uuid — tombstones included, which is
   * the whole point of reading the directory again rather than using `entries`.
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

  const end = useCallback(() => {
    setDrag(null);
    setOver(null);
  }, []);

  const dnd: Dnd = {
    kind: drag?.kind ?? null,
    over,
    start: (next, event) => {
      // Firefox starts no drag at all without a payload; nothing reads it.
      event.dataTransfer.setData("text/plain", next.kind === "doc" ? next.uuid : next.id);
      setDrag(next);
    },
    end,
    // `dragover` repeats for as long as the pointer is over a slot, so the
    // reading is compared before it is stored: React would otherwise re-render
    // the whole sidebar a few times a second to draw the same line.
    enter: (slot) => setOver((previous) => (previous === slot ? previous : slot)),
    leave: (slot) => setOver((previous) => (previous === slot ? null : previous)),
    dropDoc: (groupId, index) => {
      if (ydoc === null || drag?.kind !== "doc") return;
      const target = groups.find((group) => group.id === groupId);
      moveDoc(ydoc, drag.uuid, groupId, landingIndex(target?.docs ?? [], drag.uuid, index));
      end();
    },
  };

  const dropGroup = (index: number): void => {
    if (ydoc === null || drag?.kind !== "group") return;
    const order = groups.map((group) => group.id);
    moveGroup(ydoc, drag.id, landingIndex(order, drag.id, index));
    end();
  };

  const addGroup = (): void => {
    if (ydoc === null) return;
    // Straight into its rename field: a group is named by the person making it,
    // and "New group" is a placeholder, not a decision.
    setRenaming({ id: createGroup(ydoc, NEW_GROUP_NAME), fresh: true });
  };

  const commitRename = (groupId: string, name: string): void => {
    setRenaming(null);
    // An empty name is a slip, not a rename: the group keeps the one it has.
    if (ydoc !== null && name.trim() !== "") renameGroup(ydoc, groupId, name.trim());
  };

  /**
   * Escape out of the name field. A group that exists only because the field
   * was opened goes with it: cancelling means "never mind", and leaving "New
   * group" behind would be the field making a decision the reader declined.
   */
  const cancelRename = (): void => {
    const open = renaming;
    setRenaming(null);
    if (ydoc !== null && open?.fresh === true) deleteGroup(ydoc, open.id);
  };

  return (
    <nav className="ub-list" data-dragging={drag?.kind}>
      {/* The workspace, across the top of the column it is the workspace of
          (#74). Above the head rather than in it: the head is about this
          workspace's documents, and the switcher is about which workspace. */}
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={workspace}
        docs={entries.length}
        onSwitch={onSwitchWorkspace}
        onOpenSettings={onOpenSettings}
      />
      <div className="ub-list-head">
        <button type="button" onClick={onCreate} disabled={connection === null}>
          + new doc
        </button>
        {/* A refusal takes this line's word, because the three readings below
            all describe a connection that is working or coming back and none of
            them is true of a page the hub will not admit (#448). The ordinary
            readings stay exactly as they were — uncalmed, and saying
            "directory", since this line is about the directory room — so the
            settled state is passed only because the shared derivation takes
            one, and the word it makes from it is unused here. */}
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
      {groups.length === 0 && (
        <p className="ub-muted ub-empty">
          Nothing pinned yet. Pin the open document from its Document actions
          menu.
        </p>
      )}
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          <DropSlot
            slot={`group-${index}`}
            active={drag?.kind === "group"}
            dnd={dnd}
            onDrop={() => dropGroup(index)}
          />
          <GroupSection
            group={group}
            ydoc={ydoc}
            labels={labels}
            selected={selected}
            onSelect={onSelect}
            dnd={dnd}
            editing={renaming?.id === group.id}
            onEdit={() => setRenaming({ id: group.id, fresh: false })}
            onCancel={cancelRename}
            onCommit={(name) => commitRename(group.id, name)}
          />
        </Fragment>
      ))}
      <DropSlot
        slot={`group-${groups.length}`}
        active={drag?.kind === "group"}
        dnd={dnd}
        onDrop={() => dropGroup(groups.length)}
      />
      <button
        type="button"
        className="ub-group-add"
        onClick={addGroup}
        disabled={ydoc === null}
      >
        + group
      </button>
      {/* The sidebar's footer: the two rows that are about neither the corpus
          nor one document, below the line the groups end at. The way into
          workspace settings (#485) is a row rather than a menu item alone,
          because it is a place to go — and it is above the user card, which is
          about this client rather than the workspace. */}
      <div className="ub-list-foot">
        {/* Only where the address names a workspace to have settings for: a row
            offering a destination it cannot reach is the one thing this column
            is careful never to do (#529). The workspace menu above says the
            same thing its own way, with a disabled item. */}
        {workspace !== null && (
          <ul>
            <li>
              {/* `data-swap-focus`: the row a mode swap hands focus to
                  (App.tsx) — leaving settings lands on the way back in. */}
              <button type="button" data-swap-focus onClick={onOpenSettings}>
                <SettingsIcon />
                Workspace settings
              </button>
            </li>
          </ul>
        )}
        <UserMenu identity={identity} agentSessions={agentSessions} />
      </div>
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
      <button type="button" aria-disabled="true" title="Coming soon">
        {icon}
        {children}
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
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
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
    <svg className="ub-nav-icon" viewBox="0 0 16 16" aria-hidden="true">
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
 * One insertion point.
 *
 * `active` is what the drop needs, not the pointer: a slot between two
 * documents means nothing to a group being dragged, and a slot between two
 * groups means nothing to a document. An inactive slot declines the drag —
 * without `preventDefault` on `dragover` the browser shows "no drop" and never
 * fires `drop`, which is exactly the right answer.
 */
function DropSlot({
  slot,
  active,
  dnd,
  onDrop,
}: {
  slot: string;
  active: boolean;
  dnd: Dnd;
  onDrop: () => void;
}): ReactElement {
  return (
    <div
      className="ub-drop-slot"
      // A pointer affordance and nothing else: it holds no content, and the
      // keyboard path into the sidebar is the header's Pin control, not a drag.
      // Announcing an empty box between every pair of rows would be noise.
      aria-hidden="true"
      data-over={active && dnd.over === slot ? "true" : undefined}
      onDragOver={(event) => {
        if (!active) return;
        event.preventDefault();
        dnd.enter(slot);
      }}
      onDragLeave={() => dnd.leave(slot)}
      onDrop={(event) => {
        if (!active) return;
        event.preventDefault();
        onDrop();
      }}
    />
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
  group,
  ydoc,
  labels,
  selected,
  onSelect,
  dnd,
  editing,
  onEdit,
  onCancel,
  onCommit,
}: {
  group: SidebarGroup;
  /** The sidebar's Y.Doc, or null when there is no sidebar room to write to. */
  ydoc: Y.Doc | null;
  /** What each pinned uuid is called, and whether it is archived. */
  labels: ReadonlyMap<string, DirectoryEntry>;
  selected: string | null;
  onSelect: (uuid: string) => void;
  dnd: Dnd;
  /** Whether this group's name is the one being edited — one field at a time. */
  editing: boolean;
  onEdit: () => void;
  /** Escape: the name stands, and a group the field itself made goes away. */
  onCancel: () => void;
  onCommit: (name: string) => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useStoredFlag(groupCollapsedKey(group.id), false);
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
    <section className="ub-group">
      <div className="ub-group-head">
        {editing ? (
          <input
            className="ub-group-rename"
            defaultValue={group.name}
            aria-label="Group name"
            // Focused *and* selected: the field is opened to replace the name
            // far more often than to edit it, and `select()` alone leaves the
            // caret somewhere the keyboard is not.
            ref={openField}
            onBlur={(event) => onCommit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                // Through the blur, so there is one commit path.
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="ub-group-toggle"
            aria-expanded={!collapsed}
            draggable={ydoc !== null}
            onClick={() => setCollapsed(!collapsed)}
            onDragStart={(event) => dnd.start({ kind: "group", id: group.id }, event)}
            onDragEnd={dnd.end}
            // A collapsed group's list is inert and cannot be dropped into, so
            // the header takes the document instead — at the end of the group.
            onDragOver={(event) => {
              if (dnd.kind === "doc") event.preventDefault();
            }}
            onDrop={(event) => {
              if (dnd.kind !== "doc") return;
              event.preventDefault();
              dnd.dropDoc(group.id, group.docs.length);
            }}
          >
            <Chevron />
            <span className="ub-group-label">{group.name}</span>
            {/* The hairline across to the count — decoration, and announced as
                nothing. It is what carries the label to the end of the row
                instead of the count being pushed there. */}
            <span className="ub-group-rule" aria-hidden="true" />
            <span className="ub-group-count">{group.docs.length}</span>
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
              onClick={() => deleteGroup(ydoc, group.id)}
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
          {group.docs.map((uuid, index) => {
            // Resolved once for the row: the drawn label and the tooltip are
            // the same reading of the same stub, so a clipped row can never
            // offer different words than it shows (#529).
            const entry = labels.get(uuid);
            return (
              <Fragment key={uuid}>
                <li className="ub-drop-row">
                  <DropSlot
                    slot={`${group.id}-${index}`}
                    active={dnd.kind === "doc"}
                    dnd={dnd}
                    onDrop={() => dnd.dropDoc(group.id, index)}
                  />
                </li>
                <li>
                  <button
                    type="button"
                    // The open document, said once, to the styling and to a
                    // screen reader alike — the `ub-selected` class this
                    // replaces told only the first of them (#481). The All-docs
                    // entry in the footer already marked itself this way, so the
                    // two rows are now one state with one rule.
                    aria-current={uuid === selected ? "page" : undefined}
                    draggable={ydoc !== null}
                    onClick={() => onSelect(uuid)}
                    onDragStart={(event) => dnd.start({ kind: "doc", uuid }, event)}
                    onDragEnd={dnd.end}
                    title={pinTitle(uuid, entry)}
                  >
                    <DocumentIcon />
                    <span className="ub-pin-label">
                      <PinLabel uuid={uuid} entry={entry} />
                    </span>
                  </button>
                </li>
              </Fragment>
            );
          })}
          {/* The last slot, and an empty group's only one — which is what lets
              an empty group be a drop target at all. */}
          <li className="ub-drop-row">
            <DropSlot
              slot={`${group.id}-${group.docs.length}`}
              active={dnd.kind === "doc"}
              dnd={dnd}
              onDrop={() => dnd.dropDoc(group.id, group.docs.length)}
            />
          </li>
        </ul>
      </div>
    </section>
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

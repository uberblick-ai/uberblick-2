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
import type { RoomConnection } from "../collab/rooms.js";
import { useRoomStatus, useStoredFlag } from "./hooks.js";

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
  selected,
  onSelect,
  onCreate,
  onOpenSettings,
}: {
  /** The directory room: its sync state, and whether a document can be created. */
  connection: RoomConnection | null;
  /** The sidebar room — where every gesture here writes. Null: read-only. */
  sidebar: RoomConnection | null;
  /** The sidebar as `readSidebar` reports it, live. */
  groups: SidebarGroup[];
  /** The directory stubs, for the titles the sidebar itself does not store. */
  entries: DirectoryEntry[];
  selected: string | null;
  onSelect: (uuid: string) => void;
  onCreate: () => void;
  /** Open the local settings dialog (#176) — what the footer's gear does. */
  onOpenSettings: () => void;
}): ReactElement {
  const status = useRoomStatus(connection);
  const ydoc = sidebar?.ydoc ?? null;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const titles = useMemo(
    () => new Map(entries.map((entry) => [entry.uuid, entry.title])),
    [entries],
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
    setRenaming(createGroup(ydoc, NEW_GROUP_NAME));
  };

  return (
    <nav className="ub-list" data-dragging={drag?.kind}>
      <div className="ub-list-head">
        <button type="button" onClick={onCreate} disabled={connection === null}>
          + new doc
        </button>
        <span className="ub-muted">
          {status.connected ? (status.synced ? "directory synced" : "syncing…") : "offline"}
        </span>
      </div>
      {groups.length === 0 && (
        <p className="ub-muted ub-empty">
          Nothing pinned yet. Pin the open document from its header.
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
            titles={titles}
            selected={selected}
            onSelect={onSelect}
            dnd={dnd}
            renaming={renaming}
            onRenaming={setRenaming}
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
      {/* The sidebar's footer. Settings are machine-local and rarely opened, so
          they sit at the bottom of the one column that is always about this
          client rather than about the open document. */}
      <div className="ub-list-foot">
        <button
          type="button"
          className="ub-settings-open"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </div>
    </nav>
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
  titles,
  selected,
  onSelect,
  dnd,
  renaming,
  onRenaming,
}: {
  group: SidebarGroup;
  /** The sidebar's Y.Doc, or null when there is no sidebar room to write to. */
  ydoc: Y.Doc | null;
  titles: ReadonlyMap<string, string>;
  selected: string | null;
  onSelect: (uuid: string) => void;
  dnd: Dnd;
  /** The group being renamed, if any — one field is open at a time. */
  renaming: string | null;
  onRenaming: (groupId: string | null) => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useStoredFlag(groupCollapsedKey(group.id), false);
  const editing = renaming === group.id;

  const commitName = (name: string): void => {
    onRenaming(null);
    // An empty name is a slip, not a rename: the group keeps the one it has.
    if (ydoc !== null && name.trim() !== "") renameGroup(ydoc, group.id, name.trim());
  };

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
            ref={(element) => {
              element?.focus();
              element?.select();
            }}
            onBlur={(event) => commitName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                // Through the blur, so there is one commit path.
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onRenaming(null);
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
              onClick={() => onRenaming(group.id)}
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
          {group.docs.map((uuid, index) => (
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
                  className={uuid === selected ? "ub-selected" : ""}
                  draggable={ydoc !== null}
                  onClick={() => onSelect(uuid)}
                  onDragStart={(event) => dnd.start({ kind: "doc", uuid }, event)}
                  onDragEnd={dnd.end}
                  title={uuid}
                >
                  <PinLabel uuid={uuid} titles={titles} />
                </button>
              </li>
            </Fragment>
          ))}
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
 * What a pinned row is called.
 *
 * A uuid the directory has never mentioned is shown as itself rather than
 * dropped: the sidebar is somebody's curation, and silently hiding an entry
 * from it would be the one thing a curated list must not do. It resolves into
 * its title when the directory arrives.
 */
function PinLabel({
  uuid,
  titles,
}: {
  uuid: string;
  titles: ReadonlyMap<string, string>;
}): ReactNode {
  const title = titles.get(uuid);
  if (title === undefined) return <span className="ub-muted">{uuid.slice(0, 8)}</span>;
  return title === "" ? <em>Untitled</em> : title;
}

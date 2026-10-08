/** Shared sidebar lookup, placement and payload helpers, independent of transport. */
import {
  decisionTopicArchived,
  getDirectoryEntry,
  moveDoc,
  pinDoc,
  readSidebar,
} from "@uberblick/schema";
import type { SidebarGroup } from "@uberblick/schema";
import { ToolError } from "./failures.js";
import type { Replica, Replicas } from "./replica.js";

/** How a pinned uuid resolves against the directory. */
type PinStatus = "ok" | "archived" | "unknown";

interface PinnedDoc {
  uuid: string;
  /** The stub's cached title, or null when the directory has no entry. */
  title: string | null;
  status: PinStatus;
}

/** Every uuid the sidebar pins, for `list_docs`' derived `pinned` flag. */
export function pinnedUuids(replicas: Replicas): Set<string> {
  const pinned = new Set<string>();
  for (const group of readSidebar(replicas.sidebar().doc)) {
    for (const uuid of group.docs) pinned.add(uuid);
  }
  return pinned;
}

/** A group by id, else by name — first match in sidebar order. */
export function findGroup(groups: SidebarGroup[], key: string): SidebarGroup | null {
  return (
    groups.find((group) => group.id === key) ??
    groups.find((group) => group.name === key) ??
    null
  );
}

/** Where a document ended up: the group it is in, and its index in that group. */
export interface SidebarPlacement {
  group: { id: string; name: string };
  position: number;
}

/**
 * The group carrying `groupId`, or a `group_not_found` failure.
 *
 * Id only, deliberately: `create_doc` places into a group that already exists,
 * and a name would let it create one as a side effect of creating a document.
 * `pin_doc` keeps its own name-or-id lookup, which is the tool an agent uses to
 * bring a group into being.
 */
export function requireGroup(
  replicas: Replicas,
  groupId: string,
): SidebarGroup {
  const group = readSidebar(replicas.sidebar().doc).find(
    (candidate) => candidate.id === groupId,
  );
  if (group === undefined) {
    throw new ToolError(
      "group_not_found",
      `No sidebar group ${groupId} in workspace ${replicas.config.workspaceId} — ` +
        "get_sidebar lists the ids, and pin_doc is what creates a group by name",
      { group: groupId },
    );
  }
  return group;
}

/**
 * Put a document at `index` in an existing group — the one pin operation, used
 * by `pin_doc` and by `create_doc`'s optional placement.
 *
 * One path means one set of semantics: schema's one-pin rule (a pin already
 * elsewhere is *moved*, carrying its unpin counter, so a concurrent unpin still
 * wins), `index` clamped into range and omitted meaning last, and order stored
 * rather than computed. Two implementations would be two of those, drifting.
 *
 * The caller resolves the group first — {@link requireGroup} or `pin_doc`'s
 * name-or-id lookup — because "which group" is where the two tools legitimately
 * differ, and "what pinning means" is where they must not.
 */
export function placeInGroup(
  replicas: Replicas,
  groupId: string,
  uuid: string,
  index: number | undefined,
): { moved: boolean; position: number } {
  const sidebar = replicas.sidebar();
  const moved = readSidebar(sidebar.doc).some((group) =>
    group.docs.includes(uuid),
  );
  if (moved) moveDoc(sidebar.doc, uuid, groupId, index);
  else pinDoc(sidebar.doc, groupId, uuid, index);
  const target = readSidebar(sidebar.doc).find((group) => group.id === groupId);
  // A concurrent sidebar_group delete, arriving between the write and this
  // read, is the way this happens. Saying "gone" is the only honest answer:
  // a sentinel position would be echoed to the caller as if it were a place.
  if (target === undefined) {
    throw new ToolError(
      "group_not_found",
      `Sidebar group ${groupId} disappeared while ${uuid} was being pinned into it — ` +
        "read get_sidebar and pin it again",
      { group: groupId, uuid },
    );
  }
  return { moved, position: target.docs.indexOf(uuid) };
}

/** The sidebar as an agent reads it: stored order, titles from the directory. */
export function sidebarPayload(
  replicas: Replicas,
  sidebar: Replica,
): Record<string, unknown> {
  const directory = replicas.directory().doc;
  const resolve = (uuid: string): PinnedDoc => {
    const stub = getDirectoryEntry(directory, uuid);
    if (stub === null) return { uuid, title: null, status: "unknown" };
    return {
      uuid,
      title: stub.title,
      status: decisionTopicArchived(directory, uuid) ? "archived" : "ok",
    };
  };
  return {
    workspace: replicas.config.workspaceId,
    groups: readSidebar(sidebar.doc).map((group) => ({
      id: group.id,
      name: group.name,
      docs: group.docs.map(resolve),
    })),
  };
}

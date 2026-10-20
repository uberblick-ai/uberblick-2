/**
 * Preserve explicit curation in `<workspaceId>/_sidebar`; tags never derive
 * navigation. Schema owns stored order, one-pin semantics and unpin counters.
 */
import {
  decisionTopicArchived,
  getDirectoryEntry,
  isDirectoryEntryArchived,
  isDirectoryEntryDeleted,
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

/**
 * Prefer ids so same-named groups remain addressable; names use sidebar order.
 * pin_doc may create a new name, while create_doc uses requireGroup for ids only.
 */
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
 * Require an existing id: create_doc must not create a group as a side effect.
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
 * Callers resolve the group first. Moving preserves the unpin counter so a
 * concurrent unpin wins; schema clamps index, defaults to last and stores order.
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
  // A concurrent group deletion must refuse rather than return a sentinel position.
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

/** Use stub titles without hydration; keep unknown and archived pins removable. */
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
      status: (stub.kind === "decision" && (stub.topic ?? stub.uuid) === uuid
        ? decisionTopicArchived(directory, uuid) : isDirectoryEntryArchived(directory, uuid)) ? "archived" : "ok",
    };
  };
  return {
    workspace: replicas.config.workspaceId,
    groups: readSidebar(sidebar.doc).map((group) => ({
      id: group.id,
      name: group.name,
      docs: group.docs.filter(uuid => !isDirectoryEntryDeleted(directory, uuid)).map(resolve),
    })),
  };
}

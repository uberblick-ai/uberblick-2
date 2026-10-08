import { createGroup, deleteGroup, moveGroup, readSidebar, renameGroup, unpinDoc } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "./failures.js";
import { strictInput } from "./inputs.js";
import type { ToolMode } from "./inputs.js";
import { findGroup, placeInGroup, sidebarPayload } from "./sidebar.js";

const groupArg = z
  .string()
  .min(1)
  .describe("Group name, or the group id get_sidebar returned.");

const indexArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Position, clamped into range. Omitted means last.");

/**
 * `sidebar_group`'s three shapes, stated once for the boundary and for
 * `tools/list`.
 *
 * `action` already said which one a call means; what it did not say is that the
 * other actions' fields are then wrong rather than spare. A `rename` carrying
 * an `index` used to move nothing and say nothing — the handler simply read the
 * fields its branch wanted — so a caller that meant to move a group and typed
 * the wrong action was told it had succeeded.
 */
const SIDEBAR_GROUP_MODES: readonly ToolMode[] = [
  {
    title: "rename",
    when: { field: "action", is: "rename" },
    requires: ["name"],
    forbids: ["index"],
  },
  { title: "move", when: { field: "action", is: "move" }, forbids: ["name"] },
  {
    title: "delete",
    when: { field: "action", is: "delete" },
    forbids: ["name", "index"],
  },
];

import { operation, sidebarOperation } from "./tools/operation.js";

export const getSidebarInput = strictInput({});

export const getSidebarOperation = operation("get_sidebar", getSidebarInput, (context, _args, _request) => {
  const { replicas } = context;

  const sidebar = replicas.sidebar();
  return ({
    ...sidebarPayload(replicas, sidebar),
    hub: replicas.sync.state(),
  });
});

export const pinDocInput = strictInput({
  uuid: z.uuid().describe("Document UUID."),
  group: groupArg,
  index: indexArg,
});

export const pinDocOperation = sidebarOperation("pin_doc", pinDocInput, (context, { uuid, group, index }, _request, sidebar) => {
  const { replicas } = context;

  const groups = readSidebar(sidebar.doc);
  const target = findGroup(groups, group);
  const groupId = target?.id ?? createGroup(sidebar.doc, group);
  const { moved } = placeInGroup(replicas, groupId, uuid, index);
  return ({
    uuid,
    group: { id: groupId, name: target?.name ?? group },
    moved,
    ...sidebarPayload(replicas, sidebar),
  });
});

export const unpinDocInput = strictInput({
  // No directory check: a pin whose document nothing can resolve is
  // exactly the one that most needs removing.
  uuid: z.uuid().describe("Document UUID."),
});

export const unpinDocOperation = sidebarOperation("unpin_doc", unpinDocInput, (context, { uuid }, _request, sidebar) => {
  const { replicas } = context;

  const wasPinned = readSidebar(sidebar.doc).some((group) =>
    group.docs.includes(uuid),
  );
  unpinDoc(sidebar.doc, uuid);
  return ({
    uuid,
    unpinned: wasPinned,
    ...sidebarPayload(replicas, sidebar),
  });
});

export const sidebarGroupInput = strictInput(
  {
    action: z
      .enum(["rename", "delete", "move"])
      .describe("What to do with the group."),
    group: groupArg,
    name: z
      .string()
      .min(1)
      .optional()
      .describe("The new name. rename only, and required there."),
    index: indexArg,
  },
  SIDEBAR_GROUP_MODES,
);

export const sidebarGroupOperation = sidebarOperation("sidebar_group", sidebarGroupInput, (context, { action, group, name, index }, _request, sidebar) => {
  const { replicas } = context;

  const target = findGroup(readSidebar(sidebar.doc), group);
  if (target === null) {
    throw new ToolError(
      "group_not_found",
      `No sidebar group "${group}" in workspace ${replicas.config.workspaceId}`,
      { group },
    );
  }
  let renamed = target.name;
  if (action === "rename") {
    // `rename` without a `name` never reaches here: the input boundary
    // refuses it — see {@link SIDEBAR_GROUP_MODES}. TypeScript reads the
    // field as optional because the object declares it once for all three
    // actions, which is what this assertion stands in for.
    renamed = name as string;
    renameGroup(sidebar.doc, target.id, renamed);
  } else if (action === "delete") {
    deleteGroup(sidebar.doc, target.id);
  } else {
    moveGroup(sidebar.doc, target.id, index);
  }
  return ({
    action,
    group: { id: target.id, name: renamed },
    ...sidebarPayload(replicas, sidebar),
  });
});

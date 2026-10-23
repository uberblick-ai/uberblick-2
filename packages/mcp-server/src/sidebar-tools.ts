import { createGroup, deleteGroup, moveGroup, readSidebar, renameGroup, unpinDoc } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "./failures.js";
import { strictInput } from "./inputs.js";
import type { ToolMode } from "./inputs.js";
import { findGroup, placeInGroup, sidebarPayload } from "./sidebar.js";
import { uuidArg } from "./tools/schemas.js";

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
 * One table validates and advertises each action; fields belonging to another
 * action must refuse rather than silently disappear.
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

import { READ, operation, sidebarOperation } from "./tools/operation.js";

export const getSidebarInput = strictInput({});

export const getSidebarOperation = operation(READ, getSidebarInput, (context, _args, _request) => {
  const { replicas } = context;

  const sidebar = replicas.sidebar();
  return ({
    ...sidebarPayload(replicas, sidebar),
    hub: replicas.hubState(),
  });
});

export const pinDocInput = strictInput({
  uuid: uuidArg,
  group: groupArg,
  index: indexArg,
});

export const pinDocOperation = sidebarOperation({ requireStub: true }, pinDocInput, (context, { uuid, group, index }, _request, sidebar) => {
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
  uuid: uuidArg,
});

export const unpinDocOperation = sidebarOperation({ requireStub: false }, unpinDocInput, (context, { uuid }, _request, sidebar) => {
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

export const sidebarGroupOperation = sidebarOperation({ requireStub: false }, sidebarGroupInput, (context, { action, group, name, index }, _request, sidebar) => {
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
    // SIDEBAR_GROUP_MODES requires name here; the shared TypeScript shape is optional.
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

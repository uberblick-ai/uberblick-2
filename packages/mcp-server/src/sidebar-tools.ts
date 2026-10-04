/**
 * The sidebar tools: get_sidebar, pin_doc, unpin_doc, sidebar_group.
 *
 * The sidebar is explicit curation — an ordered list of named groups, each an
 * ordered list of document uuids, in the synced `<workspaceId>/_sidebar` room.
 * `@uberblick/schema`'s sidebar module owns the semantics (one pin per
 * document, unpin counters, order is stored and never computed); this module is
 * the agent-facing surface over it, and deliberately adds only three things:
 *
 * 1. **Groups are named, not identified.** An agent thinks in "Start here", not
 *    in a group uuid, so every tool takes a group id *or* a name, and pin_doc
 *    creates the group when the name is new. Ids still come back from
 *    get_sidebar, and win the lookup, so two groups that ended up sharing a
 *    name are still separately addressable.
 * 2. **Titles are resolved from directory stubs, never by opening documents.**
 *    Rendering navigation must not join every pinned room. A uuid the directory
 *    has never heard of, and one whose entry is tombstoned, are reported as
 *    `unknown` and `archived` rather than dropped: a pin nothing can resolve is
 *    exactly what the reader has to see in order to unpin it.
 * 3. **Tags never derive navigation.** A new workspace's optional starter
 *    sidebar is written explicitly by `ub init`; this module only exposes the
 *    curation an agent asked for.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createGroup,
  decisionTopicArchived,
  deleteGroup,
  getDirectoryEntry,
  moveDoc,
  moveGroup,
  pinDoc,
  readSidebar,
  renameGroup,
  unpinDoc,
} from "@uberblick/schema";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import { z } from "zod";
import { ToolError, failureContract, guarded } from "./failures.js";
import { strictInput } from "./inputs.js";
import type { ToolMode } from "./inputs.js";
import type { Replica, Replicas } from "./replica.js";

/**
 * What the tools need from `tools.ts`, so neither module imports the other.
 *
 * The failure half is not in here: `guarded`, `ToolError` and the description
 * text all come from ./failures.ts, which both modules import. One contract in
 * one place beats two modules agreeing to pass the same wrapper around.
 */
export interface SidebarToolContext {
  /** The directory entry for a uuid, or a `doc_not_found` failure. */
  requireStub(uuid: string): DirectoryEntry;
  /** `{applied, synced, hub}` for a write that just landed. */
  durability(replica: Replica): Record<string, unknown>;
  json(payload: unknown): CallToolResult;
}

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
function findGroup(groups: SidebarGroup[], key: string): SidebarGroup | null {
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
function sidebarPayload(
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

/** What every sidebar tool says about the shape it answers with. */
const SIDEBAR_SHAPE =
  "Every sidebar tool answers with the whole sidebar — `groups`, in order, each with its `id`, its `name` and its " +
  "`docs` in order — so a caller never has to re-read to see where a change landed. A pinned document's `title` " +
  "comes from its directory stub, never from opening the document. `status` is `ok`, `archived` (the document is " +
  "tombstoned but still pinned — archive_doc unpins, so this is a pin that outlived the archive) or " +
  "`unknown` (no directory entry at all — a document nothing can resolve, " +
  "left visible so it can be unpinned).";

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

/** What `sidebar_group` says about its three shapes, in the words an agent reads. */
const SIDEBAR_GROUP_SHAPES =
  "`action` picks one of three shapes and each takes only its own field: `rename` needs `name` and refuses " +
  "`index`, `move` takes `index` (omitted: last) and refuses `name`, `delete` takes neither. A field belonging " +
  "to another action is refused at the input boundary before the sidebar is touched, rather than ignored — so a " +
  "call that says two things is a failure you can see, not a silent half-success.";

export function registerSidebarTools(
  server: McpServer,
  replicas: Replicas,
  context: SidebarToolContext,
): void {
  server.registerTool(
    "get_sidebar",
    {
      title: "Read the sidebar",
      description:
        "The workspace's curated navigation: named groups of pinned documents, in the order they are stored. " +
        "This is not the corpus — unpinned documents are fully alive and reachable through list_docs, search, " +
        "links and backlinks; a decision needs a matching `kind`, `status` or `tag` predicate in list_docs. " +
        "Unpinned documents are simply not entry points.\n\n" +
        SIDEBAR_SHAPE +
        failureContract("get_sidebar"),
      inputSchema: strictInput({}),
    },
    guarded("get_sidebar", async () => {
      await replicas.settle();
      const sidebar = replicas.sidebar();
      return context.json({
        ...sidebarPayload(replicas, sidebar),
        hub: replicas.sync.state(),
      });
    }),
  );

  server.registerTool(
    "pin_doc",
    {
      title: "Pin a document into a sidebar group",
      description:
        "Pin a document into a group, creating the group when no group carries that name. `index` places it; " +
        "omit it to append.\n\n" +
        "One pin per document across the whole sidebar, so this is also how a pinned document is moved or " +
        "reordered: pinning one that is already pinned moves it to `index` in the named group — carrying the pin " +
        "as it stands rather than re-pinning it, so a concurrent unpin still wins — and `index` then counts " +
        "positions in the target group after the document has been taken out of it.\n\n" +
        SIDEBAR_SHAPE +
        failureContract("pin_doc"),
      inputSchema: strictInput({
        uuid: z.uuid().describe("Document UUID."),
        group: groupArg,
        index: indexArg,
      }),
    },
    guarded("pin_doc", async ({ uuid, group, index }) => {
      await replicas.settle();
      // The sidebar stores uuids and nothing else, so a typo pinned here is a
      // reference nothing can ever resolve. Identity is checked against the
      // directory — an archived document is still pinnable, deliberately:
      // archive_doc unpins (#957), so this is the one way back to a pin, and
      // get_sidebar surfaces the archived state either way.
      context.requireStub(uuid);
      const sidebar = replicas.sidebar();
      const groups = readSidebar(sidebar.doc);
      const target = findGroup(groups, group);
      const groupId = target?.id ?? createGroup(sidebar.doc, group);
      const { moved } = placeInGroup(replicas, groupId, uuid, index);
      return context.json({
        uuid,
        group: { id: groupId, name: target?.name ?? group },
        moved,
        ...sidebarPayload(replicas, sidebar),
        ...context.durability(sidebar),
      });
    }),
  );

  server.registerTool(
    "unpin_doc",
    {
      title: "Unpin a document",
      description:
        "Remove a document from the sidebar, wherever it sits. The document itself is untouched: unpinning is a " +
        "navigation act, not a delete — archive_doc is the one that tombstones a document.\n\n" +
        "An unpin beats a move made concurrently on another replica, so a document does not reappear because " +
        "somebody was dragging it at the time. It takes no group: one pin per document means there is only ever " +
        "one place to remove it from. `unpinned` is false when the document was not pinned to begin with.\n\n" +
        SIDEBAR_SHAPE +
        failureContract("unpin_doc"),
      inputSchema: strictInput({
        // No directory check: a pin whose document nothing can resolve is
        // exactly the one that most needs removing.
        uuid: z.uuid().describe("Document UUID."),
      }),
    },
    guarded("unpin_doc", async ({ uuid }) => {
      await replicas.settle();
      const sidebar = replicas.sidebar();
      const wasPinned = readSidebar(sidebar.doc).some((group) =>
        group.docs.includes(uuid),
      );
      unpinDoc(sidebar.doc, uuid);
      return context.json({
        uuid,
        unpinned: wasPinned,
        ...sidebarPayload(replicas, sidebar),
        ...context.durability(sidebar),
      });
    }),
  );

  server.registerTool(
    "sidebar_group",
    {
      title: "Rename, delete or move a sidebar group",
      description:
        "Manage the groups themselves. `delete` removes the group and its pins — the documents are untouched, " +
        "because the group only ever held their uuids, and they stay reachable through list_docs and search; a " +
        "decision needs a matching `kind`, `status` or `tag` predicate in list_docs.\n\n" +
        SIDEBAR_GROUP_SHAPES +
        "\n\n" +
        "There is no create action: pin_doc creates a group by naming one that does not exist, which is how a " +
        "group comes into being with something in it rather than empty.\n\n" +
        SIDEBAR_SHAPE +
        failureContract("sidebar_group"),
      inputSchema: strictInput(
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
      ),
    },
    guarded("sidebar_group", async ({ action, group, name, index }) => {
      await replicas.settle();
      const sidebar = replicas.sidebar();
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
      return context.json({
        action,
        group: { id: target.id, name: renamed },
        ...sidebarPayload(replicas, sidebar),
        ...context.durability(sidebar),
      });
    }),
  );
}

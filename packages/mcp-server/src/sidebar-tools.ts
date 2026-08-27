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
 * 3. **The one-time seed.** Before the sidebar existed, the web UI grouped the
 *    corpus by four tags. {@link seedSidebarOnce} reproduces that grouping —
 *    including the owner's reading order, Overview before Install and run —
 *    after which tags are metadata and the sidebar is the navigation. It is a
 *    migration for corpora that predate curation, and nothing more: a new
 *    workspace gets its first-open sidebar from `ub init` (see the CLI's
 *    `starter.ts` and `seed.ts`'s `SidebarSeed`), because the web client is
 *    usually the first thing opened and it runs no migration at all. What this
 *    finds already written, it adopts.
 *
 * The seed runs at server start and nowhere else. Not from the tools: a read
 * that writes would report a sidebar the update log may have refused, because
 * only a mutating handler ends with `assertHealthy` and `{applied, synced}`.
 * Running it from one place at boot means a refused append is caught where it
 * happens — it poisons the replica set, every tool then refuses to serve, and
 * the restart that follows rebuilds from the log with the seed unwritten, which
 * is the honest outcome.
 *
 * It decides *after* the first settle, so it decides from the whole picture
 * rather than from this machine's log: with a hub configured, the directory that
 * says what to seed — and any curation made before the flag existed — may still
 * be on the wire when the process comes up. The wait is the bounded one every
 * tool call already pays on boot, and there is nothing to wait for offline, so
 * an unreachable or unconfigured hub decides immediately.
 *
 * Two things make running it safe without any coordination:
 *
 *   - **A set-once flag in the sidebar doc says it has run** (schema's
 *     `isSidebarSeeded` / `markSidebarSeeded`), so it is a migration rather than
 *     a derivation: a sidebar deliberately emptied stays empty, and the flag
 *     travels with the document to every replica.
 *   - **Its group ids are fixed constants, not generated.** Two replicas that
 *     both seed while offline — neither having seen the other's flag — write the
 *     same four groups rather than eight, and the merge is one sidebar. It is
 *     also why the sidebar room is attached from boot in `replica.ts`:
 *     hydrating from the log before the seed decides is what makes a second run
 *     rare in the first place.
 *
 * Sharing an id is what makes those two runs merge, and it has a boundary the
 * schema module's header states in full: concurrent creates of one group id are
 * two writes of one key, so one nested map wins whole. Identical runs lose
 * nothing, because both sides wrote the same pins; two replicas seeding from
 * *different* views of the directory can lose one side's. #210 is the layout fix.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createGroup,
  deleteGroup,
  getDirectoryEntry,
  isSidebarSeeded,
  listDirectory,
  markSidebarSeeded,
  moveDoc,
  moveGroup,
  pinDoc,
  readSidebar,
  renameGroup,
  unpinDoc,
} from "@uberblick/schema";
import type { DirectoryEntry, SidebarGroup } from "@uberblick/schema";
import { z } from "zod";
import { log } from "./log.js";
import type { Replica, Replicas } from "./replica.js";

/**
 * The tag groups the web sidebar derived before curation was stored, in the
 * order it showed them. The seed reproduces exactly this, once.
 */
const LEGACY_TAG_GROUPS = [
  {
    tag: "start-here",
    name: "Start here",
    id: "5e1d0000-0000-4000-8000-000000000001",
  },
  {
    tag: "feature",
    name: "Features",
    id: "5e1d0000-0000-4000-8000-000000000002",
  },
  { tag: "verify", name: "Verify", id: "5e1d0000-0000-4000-8000-000000000003" },
  {
    tag: "reference",
    name: "Reference",
    id: "5e1d0000-0000-4000-8000-000000000004",
  },
] as const;

/**
 * Titles that lead their group in the seeded sidebar, in this order.
 *
 * The owner's reading order for the onboarding docs (2026-08-24): Overview
 * first, Install and run second. Alphabetical order gets that backwards, which
 * is the ordering intent the sidebar exists to carry. It applies to the seed
 * and to nothing else — after it, order is whatever an agent or a human made it.
 */
const SEED_LEADING_TITLES = ["Overview", "Install and run"];

/** What the tools need from `tools.ts`, so neither module imports the other. */
export interface SidebarToolContext {
  /** The directory entry for a uuid, or a `doc_not_found` failure. */
  requireStub(uuid: string): DirectoryEntry;
  /** `{applied, synced, hub}` for a write that just landed. */
  durability(replica: Replica): Record<string, unknown>;
  /** Wrap a handler so every throw becomes a structured tool failure. */
  guarded<Args>(
    handler: (args: Args) => Promise<CallToolResult>,
  ): (args: Args) => Promise<CallToolResult>;
  json(payload: unknown): CallToolResult;
  /** A tool failure with a stable machine-readable code, ready to throw. */
  error(
    code: string,
    message: string,
    detail?: Record<string, unknown>,
  ): Error;
}

/** How a pinned uuid resolves against the directory. */
type PinStatus = "ok" | "archived" | "unknown";

interface PinnedDoc {
  uuid: string;
  /** The stub's cached title, or null when the directory has no entry. */
  title: string | null;
  status: PinStatus;
}

/**
 * The seed's ordering: the leading titles first, then everything else in the
 * order `listDirectory` gave it (by title).
 */
function seedOrder(entries: DirectoryEntry[]): DirectoryEntry[] {
  const leading = SEED_LEADING_TITLES.flatMap((title) =>
    entries.filter((entry) => entry.title === title),
  );
  return [...leading, ...entries.filter((entry) => !leading.includes(entry))];
}

/**
 * Reproduce the legacy tag grouping in the sidebar, once.
 *
 * A document carrying more than one legacy tag lands in the first group that
 * claims it, which is what the derived sidebar did — one pin per document is a
 * sidebar rule, not a convention this could break.
 *
 * @returns the groups written, zero when the corpus gave it nothing to do.
 */
function seedFromTags(replicas: Replicas, sidebar: Replica): number {
  const buckets = new Map<string, DirectoryEntry[]>();
  for (const entry of listDirectory(replicas.directory().doc)) {
    const group = LEGACY_TAG_GROUPS.find((candidate) =>
      entry.tags.includes(candidate.tag),
    );
    if (group === undefined) continue;
    const bucket = buckets.get(group.tag);
    if (bucket === undefined) buckets.set(group.tag, [entry]);
    else bucket.push(entry);
  }
  if (buckets.size === 0) return 0;

  // One transaction, so the migration is one update in the log and one merge on
  // every other replica — never a half-built sidebar somebody else can see, and
  // never a flag without the groups it stands for.
  let written = 0;
  sidebar.doc.transact(() => {
    for (const { tag, name, id } of LEGACY_TAG_GROUPS) {
      const bucket = buckets.get(tag);
      if (bucket === undefined) continue;
      // The id is fixed, so a replica seeding this group offline writes THIS
      // group rather than a second one carrying the same name.
      createGroup(sidebar.doc, name, undefined, id);
      written += 1;
      for (const entry of seedOrder(bucket)) {
        pinDoc(sidebar.doc, id, entry.uuid);
      }
    }
    markSidebarSeeded(sidebar.doc);
  });
  return written;
}

/**
 * Run the one-time migration out of tag grouping, at server start.
 *
 * Called once, from `server.ts`, and never from a tool — see the header for why
 * a read must not write. It settles first, so the corpus it groups and the
 * curation it must not overwrite have both had their bounded chance to arrive
 * from the hub; with no hub there is nothing to wait for and it decides at once.
 *
 * A sidebar that already holds a group is adopted, not seeded: curation made
 * before this flag existed, or by another client, is exactly what a migration
 * must not write over.
 *
 * Never throws. An append the log refuses is already recorded as this replica
 * set's sticky persistence failure, which stops every tool; failing server
 * construction on top of that would only take the diagnostics away too.
 */
export async function seedSidebarOnce(replicas: Replicas): Promise<void> {
  try {
    // Bounded, and a no-op with no hub configured — see the header. Diagnostics
    // rather than health: a poisoned replica set is checked for below, and a
    // settle that cannot run is the next tool call's problem to report.
    await replicas.settle({ requireHealthy: false });
  } catch (error) {
    log.warn("the sidebar seed could not settle first, so it did not run", error);
    return;
  }
  if (replicas.persistenceError() !== null) return;

  const sidebar = replicas.sidebar();
  if (isSidebarSeeded(sidebar.doc)) return;

  if (readSidebar(sidebar.doc).length > 0) {
    markSidebarSeeded(sidebar.doc);
  } else if (seedFromTags(replicas, sidebar) === 0) {
    // Nothing carries a legacy tag — an empty workspace, or one that never had
    // them. Left unflagged on purpose: a corpus that arrives later still gets
    // its sidebar, on the next start.
    return;
  }

  // The same honesty a mutating tool owes its caller, told to the only reader
  // there is at boot: applied means the update log took it.
  const failure = replicas.persistenceError();
  if (failure !== null) {
    log.error("the sidebar seed did not reach the update log", {
      room: sidebar.room,
      applied: false,
      message: failure.message,
    });
    return;
  }
  log.info("seeded the sidebar from the legacy tag groups", {
    room: sidebar.room,
    applied: true,
    synced: replicas.isRoomQuiet(sidebar.room),
  });
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
  error: SidebarToolContext["error"],
): SidebarGroup {
  const group = readSidebar(replicas.sidebar().doc).find(
    (candidate) => candidate.id === groupId,
  );
  if (group === undefined) {
    throw error(
      "group_not_found",
      `No sidebar group ${groupId} in workspace ${replicas.config.workspaceId} — ` +
        "get_sidebar lists the ids, and pin_doc is what creates a group by name",
      { group: groupId, applied: false, synced: false },
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
  error: SidebarToolContext["error"],
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
    throw error(
      "group_not_found",
      `Sidebar group ${groupId} disappeared while ${uuid} was being pinned into it — ` +
        "read get_sidebar and pin it again",
      { group: groupId, uuid, applied: false, synced: false },
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
      status: stub.deleted === true ? "archived" : "ok",
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
  "tombstoned but still pinned) or `unknown` (no directory entry at all — a document nothing can resolve, left " +
  "visible so it can be unpinned).";

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
        "links and backlinks; they are simply not entry points.\n\n" +
        SIDEBAR_SHAPE,
      inputSchema: {},
    },
    context.guarded(async () => {
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
        SIDEBAR_SHAPE,
      inputSchema: {
        uuid: z.uuid().describe("Document UUID."),
        group: groupArg,
        index: indexArg,
      },
    },
    context.guarded(async ({ uuid, group, index }) => {
      await replicas.settle();
      // The sidebar stores uuids and nothing else, so a typo pinned here is a
      // reference nothing can ever resolve. Identity is checked against the
      // directory — an archived document is still pinnable, because archiving
      // is a directory act and get_sidebar surfaces it either way.
      context.requireStub(uuid);
      const sidebar = replicas.sidebar();
      const groups = readSidebar(sidebar.doc);
      const target = findGroup(groups, group);
      const groupId = target?.id ?? createGroup(sidebar.doc, group);
      const { moved } = placeInGroup(
        replicas,
        groupId,
        uuid,
        index,
        context.error,
      );
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
        SIDEBAR_SHAPE,
      inputSchema: {
        // No directory check: a pin whose document nothing can resolve is
        // exactly the one that most needs removing.
        uuid: z.uuid().describe("Document UUID."),
      },
    },
    context.guarded(async ({ uuid }) => {
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
        "Manage the groups themselves. `rename` needs `name`; `move` takes `index` (omitted: last); `delete` " +
        "removes the group and its pins — the documents are untouched, because the group only ever held their " +
        "uuids, and they stay reachable through list_docs and search.\n\n" +
        "There is no create action: pin_doc creates a group by naming one that does not exist, which is how a " +
        "group comes into being with something in it rather than empty.\n\n" +
        SIDEBAR_SHAPE,
      inputSchema: {
        action: z
          .enum(["rename", "delete", "move"])
          .describe("What to do with the group."),
        group: groupArg,
        name: z.string().min(1).optional().describe("The new name. rename only."),
        index: indexArg,
      },
    },
    context.guarded(async ({ action, group, name, index }) => {
      await replicas.settle();
      const sidebar = replicas.sidebar();
      const target = findGroup(readSidebar(sidebar.doc), group);
      if (target === null) {
        throw context.error(
          "group_not_found",
          `No sidebar group "${group}" in workspace ${replicas.config.workspaceId}`,
          { group, applied: false, synced: false },
        );
      }
      let renamed = target.name;
      if (action === "rename") {
        if (name === undefined) {
          throw context.error("invalid_arguments", "rename needs a `name`", {
            group,
            applied: false,
            synced: false,
          });
        }
        renameGroup(sidebar.doc, target.id, name);
        renamed = name;
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

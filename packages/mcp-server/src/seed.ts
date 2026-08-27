/**
 * Markdown templates → documents inside uberblick.
 *
 * This is a *private* path, not a product surface. Its only caller is `ub
 * init`, which writes the two starter templates that ship in
 * `packages/cli/templates/` into a workspace that is nobody's yet. There is no
 * general corpus import: no command, no `ub import`, and no MCP tool. The
 * project's own documents live in the live workspace and are read and written
 * through the MCP tools — `list_docs` is what enumerates them.
 *
 * Markdown is still export-only as a *storage* rule: `importMarkdown` is the
 * reader this path was built for, and it is deliberately not exposed.
 *
 * Five properties worth stating, because they are what the implementation is
 * shaped around:
 *
 * 1. **It writes through the same path the MCP tools do.** A {@link Replicas}
 *    set over the {@link MirrorStore}, so every update lands in the
 *    authoritative update log synchronously and reaches the hub the same way
 *    any tool's write does. Nothing here touches the derived index tables.
 * 2. **Identity comes from the file.** The frontmatter `uuid` is what makes a
 *    re-run recognise a document it already wrote. A file without one is an
 *    error — this reader never invents identity.
 * 3. **Write-once by construction.** A uuid that already exists is never
 *    written again, not even when the template has changed. After the first
 *    write the document belongs to whoever edits it, and this reader cannot
 *    tell an edited template from an edited *document* — so it does not guess,
 *    and a re-run cannot clobber real work. That is also what makes `ub init`
 *    idempotent.
 * 4. **A document it must not write is skipped, not written.** Two cases: a uuid
 *    the directory knows whose room has not reached this replica (writing it
 *    would put a second copy of every block into a room that already has one),
 *    and a uuid whose directory entry is tombstoned (a tombstone is sticky, so
 *    the document could never be listed again). Both report why and fail the
 *    call, which is the honest outcome.
 * 5. **A store that cannot log stops the run.** Health is asserted after every
 *    document and after the final wait, so a failing store can never let this
 *    report success for writes the log refused.
 *
 * Offline-first like everything else: with no hub it writes into the local log
 * and the rooms stay pending until one appears. With a hub it waits for the
 * rooms to sync *before* deciding what exists, which is what keeps a second
 * machine from duplicating a corpus it has not downloaded yet.
 *
 * {@link importSeedDir} takes an optional {@link StarterSeed} on top of that,
 * because a seeded workspace is a *first-open state* rather than a set of
 * rooms: `ub init` owns the starter sidebar group and writes it here, through
 * this same replica set and this same log, so the pins exist whether or not an
 * MCP server ever starts. The MCP server's own boot-time migration
 * (`sidebar-tools.ts`) then adopts what it finds rather than seeding again.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendBlock,
  createGroup,
  getDirectoryEntry,
  getMeta,
  importMarkdown,
  initDoc,
  isSidebarSeeded,
  listDirectory,
  markSidebarSeeded,
  pinDoc,
  readSidebar,
  setLinks,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput, ImportedBlock, ImportedDoc } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";

/** A parsed seed file: an {@link ImportedDoc} that is guaranteed to have identity. */
export interface SeedDoc extends ImportedDoc {
  uuid: string;
  /** The source file name, for reporting. Never part of the document. */
  file: string;
}

/**
 * What happened to one seed file.
 *
 * - `created` — the document did not exist and was written.
 * - `unchanged` — the uuid is already in the system, so nothing was written.
 *   This is the normal outcome of every run after the first, whatever the file
 *   says now.
 * - `skipped` — the importer refused, and `reason` says why.
 */
export type SeedAction = "created" | "unchanged" | "skipped";

export interface SeedImport {
  file: string;
  uuid: string;
  title: string;
  room: string;
  action: SeedAction;
  blocks: number;
  /** Why the document was skipped. Null for every other action. */
  reason: string | null;
  /** Whether the hub has acknowledged this room's changes. */
  synced: boolean;
}

/** Read and parse every markdown template in `dir`, sorted by name. */
export function readSeedDocs(dir: string): SeedDoc[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => {
    const parsed = importMarkdown(readFileSync(join(dir, file), "utf8"));
    if (parsed.uuid === undefined) {
      throw new Error(
        `${file}: no \`uuid\` in frontmatter. Identity is UUIDs and the importer ` +
          `never invents one — a generated uuid would make every re-run a new document.`,
      );
    }
    if (parsed.title === "") {
      throw new Error(`${file}: no \`title\` in frontmatter`);
    }
    return { ...parsed, uuid: parsed.uuid, file };
  });
}

function toBlockInput(block: ImportedBlock): BlockInput {
  return {
    type: block.type,
    text: block.text,
    ...(block.level === undefined ? {} : { level: block.level }),
    ...(block.language === undefined ? {} : { language: block.language }),
    // The seed files are GFM, so their prose carries inline marks. Dropping
    // `inline` here would not just lose the formatting: `text` is the *resolved*
    // plain text, so the markup would be gone from the document entirely.
    ...(block.inline === undefined ? {} : { inline: block.inline }),
  };
}

function applySeed(
  replicas: Replicas,
  seed: SeedDoc,
): Omit<SeedImport, "synced"> {
  const replica = replicas.replica(seed.uuid);
  const doc = replica.doc;
  const directory = replicas.directory();
  const stub = getDirectoryEntry(directory.doc, seed.uuid);
  const identity = {
    file: seed.file,
    uuid: seed.uuid,
    title: seed.title,
    room: replica.room,
    blocks: seed.blocks.length,
  };
  const skip = (reason: string): Omit<SeedImport, "synced"> => {
    log.warn("skipping a seed document", {
      uuid: seed.uuid,
      file: seed.file,
      reason,
      hub: replicas.sync.state().status,
    });
    return { ...identity, action: "skipped", reason };
  };

  // A tombstone is sticky by design: upserting a deleted entry keeps it deleted,
  // so a document written here could never be listed again. Importing into that
  // is a conflict a human has to resolve, not something to do quietly.
  if (stub?.deleted === true) {
    return skip(
      "the directory entry is tombstoned, and a tombstone is sticky — this " +
        "document could never appear in list_docs again",
    );
  }

  // An empty `meta.uuid` is the one reliable "this document does not exist
  // yet" — the room is joined by uuid, so its name proves nothing.
  const hydrated = getMeta(doc).uuid !== "";

  // …but a live stub over an empty room means the document exists somewhere and
  // this replica has not received it, which is the case where writing does real
  // damage: the blocks would merge into the existing room as a second copy.
  if (!hydrated && stub !== null && replicas.sync.enabled) {
    return skip(
      "the directory names this document but its room has not reached this " +
        "replica, so writing it would duplicate every block",
    );
  }

  // Already imported, so this importer is done with it — whatever the file says
  // now. The document belongs to the MCP tools from here on, and a changed seed
  // file is indistinguishable from an edited document.
  if (hydrated) {
    // The one thing a re-run still does: give a stub imported before the
    // directory carried timestamps a `createdAt`, so it can be sorted with the
    // rest. `upsertDirectoryEntry` sets it once, so this is a no-op the second
    // time — and it deliberately does not touch `updatedAt`, because importing
    // nothing is not the document changing.
    if (stub !== null && stub.createdAt === undefined) {
      upsertDirectoryEntry(directory.doc, {
        uuid: seed.uuid,
        title: stub.title,
        tags: stub.tags,
        createdAt: Date.now(),
      });
    }
    return { ...identity, action: "unchanged", reason: null };
  }

  initDoc(doc, { uuid: seed.uuid, title: seed.title, tags: seed.tags });
  for (const block of seed.blocks) {
    appendBlock(doc, toBlockInput(block));
  }
  // A file that declares no links says nothing about links — it does not say
  // "no links". `initDoc` has already seeded an empty set, so writing one here
  // would only ever be a way to clear something.
  const links = seed.links ?? [];
  if (links.length > 0) {
    setLinks(doc, links);
  }

  // Discovery is a synced doc, so being discoverable is an explicit write here —
  // the way `create_doc` does it — not a side effect of having been observed.
  const now = Date.now();
  upsertDirectoryEntry(directory.doc, {
    uuid: seed.uuid,
    title: seed.title,
    tags: seed.tags,
    createdAt: now,
    updatedAt: now,
  });

  return { ...identity, action: "created", reason: null };
}

/**
 * Links are UUIDs, so there is nothing to resolve — but a link to a uuid no
 * document has is a content bug worth naming. A warning, not an error: a seed
 * doc may legitimately cite something created outside the seed set.
 */
function warnOnDanglingLinks(replicas: Replicas, docs: SeedDoc[]): void {
  const known = new Set(docs.map((doc) => doc.uuid));
  for (const doc of docs) {
    for (const target of doc.links ?? []) {
      if (known.has(target)) continue;
      if (getDirectoryEntry(replicas.directory().doc, target) !== null) continue;
      log.warn("seed document links to a uuid no document has", {
        file: doc.file,
        uuid: doc.uuid,
        target,
      });
    }
  }
}

/**
 * Import every parsed seed document that is not already in the system.
 *
 * The two-pass shape is the load-bearing part. Every target room is joined and
 * given a chance to sync *before* anything is written, because "does this
 * document already exist?" has to be asked of everything reachable, not just of
 * what this machine happens to have downloaded. Skipping that, a second machine
 * would find every seed document empty and append a second copy of its blocks
 * into the very same room — merging into a duplicated document.
 *
 * @throws PersistenceError as soon as an update fails to reach the log. The log
 * is the authoritative replica, so a failed append leaves the document ahead of
 * the truth: continuing would pile more unlogged writes on top and let the run
 * report documents as imported that a restart will not bring back.
 */
export async function importSeedDocs(
  replicas: Replicas,
  docs: SeedDoc[],
): Promise<SeedImport[]> {
  await replicas.settle();

  for (const doc of docs) {
    replicas.replica(doc.uuid);
  }
  await replicas.sync.waitForQuiet();

  warnOnDanglingLinks(replicas, docs);

  const results: Omit<SeedImport, "synced">[] = [];
  for (const doc of docs) {
    results.push(applySeed(replicas, doc));
    // Checked per document, not once at the end: the first failed append is the
    // last honest moment. Stopping here leaves the documents already imported
    // intact and durable, and reports the failure instead of a false success.
    replicas.assertHealthy();
  }

  // The import is already durable — it is in the log. This only lets the report
  // tell the truth about what the hub has taken.
  await replicas.sync.waitForQuiet();
  // A remote update can fail to log while we wait, which poisons this replica
  // just as surely as one of our own writes would.
  replicas.assertHealthy();

  return results.map((result) => ({
    ...result,
    synced: replicas.isRoomQuiet(result.room),
  }));
}

/**
 * A starter layout: the first-open state of a workspace that is nobody's yet.
 *
 * Handing one to {@link importSeedDir} changes two things about the import.
 *
 * 1. **It becomes exclusive.** A starter seed is only ever for a workspace that
 *    holds nothing but the documents being imported, so the import refuses one
 *    that holds anything else — see {@link holdsOnlyStarters}, which asks that
 *    question of the hydrated directory rather than of whatever this replica
 *    happened to have on disk.
 * 2. **It ends by writing one sidebar group**, described by the fields below.
 *
 * The group's id is the caller's, and it is fixed rather than generated, for
 * the reason the schema module's header states — two replicas seeding offline
 * write the same group instead of two, and merge into one. Its boundary is
 * #210: two concurrent creates of one id are two writes of one key, so one
 * nested map wins whole and the loser's pins go with it. That is safe *here*
 * because every writer of this group writes exactly the same name and the same
 * pins — `ub init` seeds one fixed starter layout, and its runs are serialised
 * on one machine by the seed lock.
 */
export interface StarterSeed {
  /** The group's fixed id. */
  id: string;
  /** The group's name, as a reader sees it. */
  name: string;
  /** Document uuids, pinned in this order. */
  docs: string[];
}

/**
 * Whether this workspace is still one a starter seed may be written into:
 * hydrated, its directory names nothing but `docs`.
 *
 * The check is *here*, after hydration and before the first write, because
 * eligibility read anywhere earlier is eligibility read from the wrong replica.
 * `ub init` does ask the same question locally first — cheaply, without a hub —
 * but a local answer is only ever about what this machine has downloaded. A
 * replica bound to a workspace it has never synced (`ub workspace use <id>`
 * followed by `ub init`, or a database restored from a backup) reads an empty
 * directory and would otherwise write starter documents, and a starter sidebar
 * group, into somebody's real corpus.
 *
 * Tombstones count. An archived document is a document this workspace has had,
 * and it is the same evidence a live one is: this workspace is somebody's.
 */
function holdsOnlyStarters(replicas: Replicas, docs: SeedDoc[]): boolean {
  const starters = new Set(docs.map((doc) => doc.uuid));
  const directory = listDirectory(replicas.directory().doc, {
    includeDeleted: true,
  });
  return directory.every((entry) => starters.has(entry.uuid));
}

/**
 * Write one starter sidebar group through the same replica set the documents
 * went through, so the pins are in the update log before this returns — with or
 * without a hub, and with or without an MCP server ever having started.
 *
 * Three things it refuses, all of them "this sidebar is not a blank one":
 *
 * 1. **The seed marker is set.** Set once and never cleared, which is what lets
 *    a sidebar deliberately emptied stay empty.
 * 2. **A group is already there.** Curation — a user's, another client's, or
 *    the MCP server's own legacy tag migration — is exactly what a seed must
 *    not write over.
 * 3. **A pin would not resolve.** Every uuid must have a live directory entry:
 *    an archived starter document stays archived rather than being pinned back,
 *    and a layout that is not fully durable is not one to mark as seeded.
 *
 * @returns whether the group was written.
 */
async function seedSidebar(
  replicas: Replicas,
  seed: StarterSeed,
): Promise<boolean> {
  const sidebar = replicas.sidebar();
  if (isSidebarSeeded(sidebar.doc) || readSidebar(sidebar.doc).length > 0) {
    return false;
  }
  const directory = replicas.directory().doc;
  for (const uuid of seed.docs) {
    const stub = getDirectoryEntry(directory, uuid);
    if (stub === null || stub.deleted === true) return false;
  }

  // One transaction, so the group, its pins and the marker are one update: no
  // replica ever sees a half-built starter layout, and no marker ever stands
  // for pins that are not there.
  sidebar.doc.transact(() => {
    createGroup(sidebar.doc, seed.name, undefined, seed.id);
    for (const uuid of seed.docs) {
      pinDoc(sidebar.doc, seed.id, uuid);
    }
    markSidebarSeeded(sidebar.doc);
  });
  // The same bar the documents were held to: applied means the log took it.
  replicas.assertHealthy();
  await replicas.sync.waitForQuiet();
  replicas.assertHealthy();
  return true;
}

/**
 * The whole import as one call: open a replica set for `config`, import every
 * markdown file in `dir`, optionally pin the result into one sidebar group,
 * close both handles again.
 *
 * The lifecycle is the reason this exists — a caller that is not a process
 * dedicated to importing (`ub init` seeding a new workspace's starter
 * documents) must not leave a SQLite handle and a hub connection open behind
 * it. `hub` is the sync layer's status at the end, reported after the replicas
 * are gone.
 *
 * `starter` is what makes a seeded workspace open the same way for every first
 * client: the starter documents are navigation, not just rooms, and the
 * `_sidebar` document is the only thing that says so. Passing one also makes
 * the import exclusive — it settles first and writes nothing at all into a
 * workspace whose directory names anything else, which is the only place that
 * question can be asked of the whole workspace rather than of this machine's
 * copy of it. The group is written last, and only from documents the directory
 * already names, so the layout is durable before it is declared. See
 * {@link StarterSeed}, {@link holdsOnlyStarters} and {@link seedSidebar}.
 *
 * A refused starter seed returns no results and reports why on stderr. It is
 * not an error: the caller asked for a workspace's first-open state, and the
 * honest answer is that this workspace already has one.
 */
export async function importSeedDir(
  dir: string,
  config: McpConfig,
  starter: StarterSeed | null = null,
): Promise<{ results: SeedImport[]; hub: string; sidebar: boolean }> {
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  const replicas = new Replicas(config, store);
  try {
    const docs = readSeedDocs(dir);
    if (starter !== null) {
      // Before the first write, and after the directory has had its bounded
      // chance to arrive from the hub — the same two-pass hydration
      // `importSeedDocs` relies on, paid here so the decision is made on the
      // state the writes will be made on. `settle` is the whole wait: it waits
      // for every attached room to go quiet, the directory included, and skips
      // the wait entirely when the hub is unreachable. A second `waitForQuiet`
      // here would buy nothing and would repeat the full connect timeout
      // offline, with `ub init`'s seed lock held. It also throws on a poisoned
      // replica before returning, so health is asserted before this reads
      // anything.
      await replicas.settle();
      if (!holdsOnlyStarters(replicas, docs)) {
        log.warn("not seeding a starter layout into a workspace in use", {
          workspace: config.workspaceId,
          hub: replicas.sync.state().status,
        });
        return { results: [], hub: replicas.sync.state().status, sidebar: false };
      }
    }
    const results = await importSeedDocs(replicas, docs);
    const seeded =
      starter === null ? false : await seedSidebar(replicas, starter);
    return { results, hub: replicas.sync.state().status, sidebar: seeded };
  } finally {
    replicas.destroy();
    store.close();
  }
}

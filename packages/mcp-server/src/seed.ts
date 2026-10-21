/** Private starter templates write through replicas, never derived index tables. */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_DESCRIPTION_LENGTH,
  appendBlock,
  createGroup,
  decisionDirectoryFields,
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
import type { ImportedDoc } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";

/**
 * Seed files require identity and a description even though ordinary imports may omit them.
 */
export interface SeedDoc extends ImportedDoc {
  uuid: string;
  description: string;
  /** The source file name, for reporting. Never part of the document. */
  file: string;
}

/**
 * Unchanged UUIDs are never rewritten, even if the template changed; skipped
 * documents carry a reason rather than being silently overwritten.
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

/**
 * Read starter templates in name order; this private reader is not a general
 * import surface or storage format. Require UUID, title and description so
 * reruns retain identity and fresh starters do not ask agents to backfill descriptions.
 */
export function readSeedDocs(dir: string): SeedDoc[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  return files.map((file) => {
    const source = readFileSync(join(dir, file), "utf8");
    const parsed = importMarkdown(source);
    if (parsed.uuid === undefined) {
      throw new Error(
        `${file}: no \`uuid\` in frontmatter. Identity is UUIDs and the importer ` +
          `never invents one — a generated uuid would make every re-run a new document.`,
      );
    }
    if (parsed.title === "") {
      throw new Error(`${file}: no \`title\` in frontmatter`);
    }
    // The lossless importer preserves quoted padding. Trim before validating
    // starter descriptions against the same bounds as create_doc and set_metadata.
    const description = parsed.description?.trim();
    if (description === undefined || description === "") {
      throw new Error(
        `${file}: no \`description\` in frontmatter. Every document written here ` +
          `arrives described, so a fresh workspace's own documents never ask their ` +
          `first agent to backfill one.`,
      );
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `${file}: the \`description\` is ${description.length} characters, over the ` +
          `${MAX_DESCRIPTION_LENGTH} every write boundary holds a description to.`,
      );
    }
    return { ...parsed, uuid: parsed.uuid, description, file };
  });
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

  // Tombstones survive upsert. Skip with a reason; only a person can resolve
  // a conflict whose new content would remain undiscoverable.
  if (stub?.deleted === true) {
    return skip(
      "the directory entry is tombstoned, and a tombstone is sticky — this " +
        "document could never appear in list_docs again",
    );
  }

  // The room name does not prove existence; nonempty meta.uuid proves hydration.
  const hydrated = getMeta(doc).uuid !== "";

  // With sync enabled, a live stub over an unhydrated room already names a document.
  // Skip with a reason rather than merge a second copy of every block into it.
  if (!hydrated && stub !== null && replicas.sync.enabled) {
    return skip(
      "the directory names this document but its room has not reached this " +
        "replica, so writing it would duplicate every block",
    );
  }

  // A changed template cannot be distinguished from edited work; never rewrite a hydrated UUID.
  if (hydrated) {
    // Backfill missing createdAt once for sorting. Do not touch updatedAt:
    // importing nothing does not change the document.
    if (stub !== null && stub.createdAt === undefined) {
      upsertDirectoryEntry(directory.doc, {
        uuid: seed.uuid,
        title: stub.title,
        tags: stub.tags,
        ...decisionDirectoryFields(doc),
        createdAt: Date.now(),
      });
    }
    return { ...identity, action: "unchanged", reason: null };
  }

  initDoc(doc, {
    uuid: seed.uuid,
    title: seed.title,
    description: seed.description,
    tags: seed.tags,
  });
  for (const block of seed.blocks) {
    appendBlock(doc, block);
  }
  // Missing links are unspecified, not a request to clear links; initDoc seeds the empty set.
  const links = seed.links ?? [];
  if (links.length > 0) {
    setLinks(doc, links);
  }

  // Match create_doc's explicit directory write; cache description so listings
  // can answer without opening each document room.
  const now = Date.now();
  upsertDirectoryEntry(directory.doc, {
    uuid: seed.uuid,
    title: seed.title,
    description: seed.description,
    tags: seed.tags,
    ...decisionDirectoryFields(doc),
    createdAt: now,
    updatedAt: now,
  });

  return { ...identity, action: "created", reason: null };
}

/**
 * UUID links need no name resolution. Warn, rather than refuse, when missing:
 * a seed may legitimately cite a document outside this set.
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
 * Hydrate directory and target rooms before deciding existence; otherwise a
 * second machine can append duplicate blocks. Offline writes remain in the
 * authoritative local log with sync pending. Stop on the first failed append
 * rather than report imports that a restart cannot recover.
 * @throws PersistenceError when an update cannot be logged.
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
    // Stop after the first failed document; earlier logged imports remain durable.
    replicas.assertHealthy();
  }

  // Writes are already local-durable; this wait only updates hub acknowledgement.
  await replicas.sync.waitForQuiet();
  // Remote updates during the wait can also poison the local log.
  replicas.assertHealthy();

  return results.map((result) => ({
    ...result,
    synced: replicas.isRoomQuiet(result.room),
  }));
}

/**
 * A fixed group ID makes offline seeds converge to one group. Concurrent
 * nested-map creates select one whole map, so callers must supply the same
 * name and pins; workspace creation serializes local seeds with its seed lock.
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
 * Check the hydrated directory before any write. Tombstones count as prior
 * use too; an empty unsynced local copy cannot establish starter eligibility.
 */
function holdsOnlyStarters(replicas: Replicas, docs: SeedDoc[]): boolean {
  const starters = new Set(docs.map((doc) => doc.uuid));
  const directory = listDirectory(replicas.directory().doc, {
    includeDeleted: true,
  });
  return directory.every((entry) => starters.has(entry.uuid));
}

/**
 * Preserve deliberate curation: refuse a seed marker, existing group or any
 * missing/archived pin. The marker is never cleared, even for an emptied sidebar.
 * Pins and group use the documents' local log, independent of hub/MCP startup;
 * explicit starter curation is never derived from or changed by tags.
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

  // One update prevents a half-built layout or a marker without its pins.
  sidebar.doc.transact(() => {
    createGroup(sidebar.doc, seed.name, undefined, seed.id);
    for (const uuid of seed.docs) {
      pinDoc(sidebar.doc, seed.id, uuid);
    }
    markSidebarSeeded(sidebar.doc);
  });
  // Refuse success if the layout or a remote update during the wait was not logged.
  replicas.assertHealthy();
  await replicas.sync.waitForQuiet();
  replicas.assertHealthy();
  return true;
}

/**
 * Close this call's SQLite handle and connection, retaining the final hub reading.
 * A starter requires an exclusive hydrated workspace and writes navigation last,
 * after its documents are durable. Refusal returns no results and warns on stderr
 * without failing the caller, because a used workspace already has a first-open state.
 */
export async function importSeedDir(
  dir: string,
  config: McpConfig,
  starter: StarterSeed | null = null,
): Promise<{ results: SeedImport[]; hub: string; sidebar: boolean }> {
  const workspace = openWorkspaceReplicas(config);
  const { replicas } = workspace;
  try {
    const docs = readSeedDocs(dir);
    if (starter !== null) {
      // Settle hydrates and checks log health before eligibility. An extra
      // wait would repeat connect grace offline while holding the seed lock.
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
    await workspace.close();
  }
}
